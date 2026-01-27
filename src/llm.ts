import * as fs from "fs";
import * as path from "path";
import { Memory } from "./types";

/**
 * Shared LLM utilities: API key resolution and Anthropic API calls.
 */

export async function resolveApiKey(): Promise<string | null> {
  // 1. Explicit env var
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // 2. Global memory-mcp config
  const globalConfig = path.join(process.env.HOME || "", ".memory-mcp", "config.json");
  if (fs.existsSync(globalConfig)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(globalConfig, "utf-8"));
      if (cfg.apiKey) return cfg.apiKey;
    } catch {}
  }

  // 3. Claude CLI config paths
  const candidates = [
    path.join(process.env.HOME || "", ".config", "anthropic", "api_key"),
    path.join(process.env.HOME || "", ".anthropic", "api_key"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8").trim();
  }

  return null;
}

export async function callHaiku(prompt: string, maxTokens: number = 1024): Promise<string | null> {
  const key = await resolveApiKey();
  if (!key) return null;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-20241022",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as any;
  return data.content?.[0]?.text || null;
}

export function buildExtractionPrompt(existingMemories: Memory[], transcript: string): string {
  const existingSummary = existingMemories
    .filter((m) => !m.tags.includes("superseded") && (m.confidence ?? 1) > 0.3)
    .map((m) => `  [${m.type}] ${m.content}`)
    .join("\n");

  return `You are a memory extractor for a coding project. Analyze the conversation transcript and extract ONLY important new memories.

EXISTING MEMORIES (do NOT duplicate these — only add NEW info or UPDATES):
${existingSummary || "  (none yet)"}

Extract only memories that are:
- NEW information not covered above
- UPDATES to existing memories (something changed — include "supersedes_content" with the OLD text)
- CORRECTIONS to existing memories

Categories:
- architecture: System structure, components, tech stack
- decision: Why X was chosen over Y, trade-offs
- pattern: Codebase conventions (naming, structure, approach)
- gotcha: Non-obvious pitfalls, surprising bugs
- progress: Completed work, in-flight tasks, blockers
- context: Business context, deadlines, requirements, preferences

Rules:
- SKIP trivial operations (typo fixes, file reads, routine commands)
- SKIP things obvious from code itself
- Each memory: one clear, specific sentence with concrete details (file names, function names)
- If nothing new, return empty array
- Be VERY selective — 0-3 memories per extraction is typical
- Include relevant tags for categorization

Return JSON only:
[{"type": "decision", "content": "...", "tags": ["auth"], "supersedes_content": null}, ...]

Empty result: []

--- TRANSCRIPT ---
${transcript}`;
}

export function buildConsolidationPrompt(
  type: string,
  memories: { id: string; content: string }[]
): string {
  const memList = memories.map((m) => `  ${m.id}: ${m.content}`).join("\n");

  return `You are a memory consolidator. Below are ${memories.length} memories of type "${type}" from a coding project.

Merge memories that overlap or can be combined into one clearer memory.
Remove memories that are outdated or no longer relevant given later ones.
Keep memories that are unique and still valuable.

Return JSON only:
{
  "keep": ["mem_id1", "mem_id2"],
  "merge": [
    {"content": "merged text here", "tags": ["tag1"], "sources": ["mem_id3", "mem_id4"]}
  ],
  "drop": ["mem_id5"]
}

Every input memory ID must appear in exactly one of: keep, merge.sources, or drop.

MEMORIES:
${memList}`;
}

export function buildAskPrompt(question: string, memories: Memory[]): string {
  const memList = memories
    .map((m) => `  [${m.type}] ${m.content}`)
    .join("\n");

  return `You have access to project memories. Answer the question using ONLY the memories below. Be concise and specific. If the memories don't contain enough info, say so.

MEMORIES:
${memList}

QUESTION: ${question}`;
}
