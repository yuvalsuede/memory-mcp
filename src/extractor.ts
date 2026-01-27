#!/usr/bin/env node

/**
 * extractor.ts - The silent brain of memory-mcp
 *
 * Called by Claude Code hooks (Stop, PreCompact, SessionEnd).
 * Reads the conversation transcript, extracts meaningful memories
 * using Haiku, deduplicates, and syncs to CLAUDE.md.
 */

import * as fs from "fs";
import * as path from "path";
import { MemoryStore } from "./store";
import { callHaiku, buildExtractionPrompt, buildConsolidationPrompt } from "./llm";

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
}

interface ExtractedMemory {
  type: "decision" | "pattern" | "gotcha" | "architecture" | "progress" | "context";
  content: string;
  tags: string[];
  supersedes_content?: string | null;
}

// --- Stdin ---

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 1000);
  });
}

// --- Transcript Parsing ---

function readTranscript(transcriptPath: string, afterLine: number): string[] {
  if (!fs.existsSync(transcriptPath)) return [];
  const content = fs.readFileSync(transcriptPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  return lines.slice(afterLine);
}

function summarizeTranscriptLines(lines: string[]): string {
  const events: string[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const msg = entry.message || {};
      const content = msg.content;

      if (entry.type === "user") {
        const text = typeof content === "string" ? content : extractTextFromBlocks(content);
        if (text) events.push(`USER: ${text.slice(0, 500)}`);
      } else if (entry.type === "assistant") {
        // Extract text blocks
        const text = extractTextFromBlocks(content);
        if (text) events.push(`CLAUDE: ${text.slice(0, 500)}`);

        // Extract tool_use blocks
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use") {
              const name = block.name || "unknown";
              const input = block.input || {};

              if (name === "Write" || name === "Edit") {
                events.push(`TOOL [${name}]: ${input.file_path || "unknown file"}`);
              } else if (name === "Bash") {
                events.push(`TOOL [Bash]: ${(input.command || "").slice(0, 200)}`);
              } else if (name === "Read") {
                events.push(`TOOL [Read]: ${input.file_path || "unknown"}`);
              } else {
                events.push(`TOOL [${name}]`);
              }
            }
          }
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  return events.join("\n");
}

function extractTextFromBlocks(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join(" ");
  }
  return "";
}

// --- Chunked Extraction ---

function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize));
    start += chunkSize - overlap;
  }
  return chunks;
}

async function extractMemories(
  transcript: string,
  existingMemories: import("./types").Memory[]
): Promise<ExtractedMemory[]> {
  const chunks = chunkText(transcript, 6000, 500);
  const allMemories: ExtractedMemory[] = [];

  for (const chunk of chunks) {
    const prompt = buildExtractionPrompt(existingMemories, chunk);
    const response = await callHaiku(prompt);
    if (!response) continue;

    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;
      const parsed: ExtractedMemory[] = JSON.parse(jsonMatch[0]);
      allMemories.push(...parsed);
    } catch {
      // Skip unparseable
    }
  }

  return allMemories;
}

// --- Consolidation ---

async function runConsolidation(store: MemoryStore): Promise<void> {
  const grouped = store.getMemoriesForConsolidation();

  for (const [type, memories] of Object.entries(grouped)) {
    if (memories.length < 5) continue; // Not worth consolidating small groups

    const prompt = buildConsolidationPrompt(type, memories);
    const response = await callHaiku(prompt, 2048);
    if (!response) continue;

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;
      const result = JSON.parse(jsonMatch[0]);
      if (result.keep && result.merge && result.drop) {
        store.applyConsolidation(result);
      }
    } catch {
      // Skip
    }
  }
}

// --- Cursor ---

function getCursorPath(projectDir: string): string {
  return path.join(projectDir, ".memory", "cursor.json");
}

function getCursor(projectDir: string, sessionId: string): number {
  const cursorPath = getCursorPath(projectDir);
  if (!fs.existsSync(cursorPath)) return 0;
  try {
    const cursors = JSON.parse(fs.readFileSync(cursorPath, "utf-8"));
    return cursors[sessionId] || 0;
  } catch {
    return 0;
  }
}

function setCursor(projectDir: string, sessionId: string, line: number): void {
  const cursorPath = getCursorPath(projectDir);
  let cursors: Record<string, number> = {};
  if (fs.existsSync(cursorPath)) {
    try {
      cursors = JSON.parse(fs.readFileSync(cursorPath, "utf-8"));
    } catch {
      cursors = {};
    }
  }
  cursors[sessionId] = line;
  fs.writeFileSync(cursorPath, JSON.stringify(cursors, null, 2));
}

// --- CLAUDE.md Sync ---

function syncClaudeMd(projectDir: string, store: MemoryStore): void {
  const claudeMdPath = path.join(projectDir, "CLAUDE.md");
  const consciousness = store.generateConsciousness();

  const marker = { start: "<!-- MEMORY:START -->", end: "<!-- MEMORY:END -->" };
  const memoryBlock = `${marker.start}\n${consciousness}\n${marker.end}`;

  if (fs.existsSync(claudeMdPath)) {
    let existing = fs.readFileSync(claudeMdPath, "utf-8");
    if (existing.includes(marker.start) && existing.includes(marker.end)) {
      const regex = new RegExp(
        `${escapeRegex(marker.start)}[\\s\\S]*?${escapeRegex(marker.end)}`
      );
      existing = existing.replace(regex, memoryBlock);
    } else {
      existing = existing.trimEnd() + "\n\n" + memoryBlock + "\n";
    }
    fs.writeFileSync(claudeMdPath, existing);
  } else {
    fs.writeFileSync(claudeMdPath, memoryBlock + "\n");
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Main ---

async function main() {
  try {
    const stdinData = await readStdin();
    if (!stdinData.trim()) return;

    const input: HookInput = JSON.parse(stdinData);
    const { session_id, transcript_path, cwd } = input;
    const event = input.hook_event_name;

    if (!transcript_path || !cwd) return;

    // Ensure .memory dir exists
    const memDir = path.join(cwd, ".memory");
    if (!fs.existsSync(memDir)) {
      fs.mkdirSync(memDir, { recursive: true });
    }

    const store = new MemoryStore(cwd);

    // Acquire lock
    if (!store.acquireLock()) return;

    try {
      // Read new transcript lines
      const cursor = getCursor(cwd, session_id);
      const newLines = readTranscript(transcript_path, cursor);

      // Minimum threshold: need meaningful content
      const minLines = event === "PreCompact" ? 1 : 3;
      if (newLines.length < minLines) {
        setCursor(cwd, session_id, cursor + newLines.length);
        return;
      }

      // Summarize transcript
      const summary = summarizeTranscriptLines(newLines);
      if (!summary.trim()) return;

      // Extract memories (context-aware)
      const existingMemories = store.getActiveMemories();
      const extracted = await extractMemories(summary, existingMemories);

      // Save extracted memories
      for (const mem of extracted) {
        // If superseding an existing memory by content match
        if (mem.supersedes_content) {
          const { tokenize, jaccard } = require("./store");
          const superTokens = tokenize(mem.supersedes_content);
          for (const existing of existingMemories) {
            if (existing.type === mem.type) {
              const sim = jaccard(superTokens, tokenize(existing.content));
              if (sim > 0.5) {
                mem.tags = mem.tags || [];
                store.addMemory({
                  type: mem.type,
                  content: mem.content,
                  tags: mem.tags,
                  supersedes: existing.id,
                });
                break;
              }
            }
          }
        } else {
          store.addMemory({
            type: mem.type,
            content: mem.content,
            tags: mem.tags || [],
          });
        }
      }

      // Update cursor
      setCursor(cwd, session_id, cursor + newLines.length);

      // Increment extraction count
      store.incrementExtractionCount();

      // Decay confidence
      store.decayConfidence();

      // Consolidate if needed (always on SessionEnd, threshold otherwise)
      if (event === "SessionEnd" || store.needsConsolidation()) {
        await runConsolidation(store);
      }

      // Sync CLAUDE.md
      syncClaudeMd(cwd, store);
    } finally {
      store.releaseLock();
    }
  } catch {
    // Silent failure — never disrupt Claude's work
  }
}

main();
