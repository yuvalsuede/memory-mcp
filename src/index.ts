#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MemoryStore } from "./store";
import { callHaiku, buildAskPrompt, buildConsolidationPrompt } from "./llm";
import * as fs from "fs";
import * as path from "path";

const projectDir = process.argv[2] || process.cwd();
const store = new MemoryStore(projectDir);

const server = new McpServer({
  name: "memory-mcp",
  version: "2.0.0",
});

const MEMORY_TYPE = z
  .enum(["decision", "pattern", "gotcha", "architecture", "progress", "context"])
  .describe(
    "Memory type: decision (why X over Y), pattern (conventions), gotcha (pitfalls), architecture (system structure), progress (what's done/in-flight), context (business context)"
  );

// --- Core Tools ---

server.tool(
  "memory_init",
  "Initialize project memory with name and description.",
  {
    name: z.string().describe("Project name"),
    description: z.string().describe("Brief project description"),
  },
  async ({ name, description }) => {
    store.setProject(name, description);
    syncClaudeMd();
    return { content: [{ type: "text", text: `Project "${name}" initialized.` }] };
  }
);

server.tool(
  "memory_save",
  "Save a memory about this project. Records decisions, patterns, architecture, gotchas, progress, or context for future sessions.",
  {
    type: MEMORY_TYPE,
    content: z.string().describe("The memory — be specific and concise"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
    supersedes: z.string().optional().describe("ID of memory this replaces"),
  },
  async ({ type, content, tags, supersedes }) => {
    const mem = store.addMemory({
      type,
      content,
      tags: tags || [],
      supersedes,
    });
    syncClaudeMd();
    return {
      content: [{ type: "text", text: mem ? `Saved: [${mem.id}] (${type}) ${content}` : "Duplicate detected, skipped." }],
    };
  }
);

server.tool(
  "memory_recall",
  "Recall all active memories, optionally filtered by type or tags.",
  {
    type: MEMORY_TYPE.optional(),
    tags: z.array(z.string()).optional().describe("Filter by tags"),
  },
  async ({ type, tags }) => {
    const memories = store.getMemories({ type, tags });
    if (memories.length === 0) {
      return { content: [{ type: "text", text: "No memories found." }] };
    }
    const text = memories
      .map((m) => {
        const tagStr = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
        return `[${m.id}] (${m.type}) ${m.content}${tagStr}`;
      })
      .join("\n\n");
    return { content: [{ type: "text", text: `${memories.length} memories:\n\n${text}` }] };
  }
);

server.tool(
  "memory_delete",
  "Delete a specific memory by ID.",
  { id: z.string().describe("Memory ID to delete") },
  async ({ id }) => {
    const ok = store.deleteMemory(id);
    if (ok) syncClaudeMd();
    return { content: [{ type: "text", text: ok ? `Deleted ${id}` : `Not found: ${id}` }] };
  }
);

// --- Search & Retrieval Tools ---

server.tool(
  "memory_search",
  "Search memories by keyword. Returns ranked results matching the query across content and tags.",
  {
    query: z.string().describe("Search query (keywords)"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ query, limit }) => {
    const results = store.searchMemories(query, limit || 20);
    if (results.length === 0) {
      return { content: [{ type: "text", text: `No memories matching "${query}".` }] };
    }
    const text = results
      .map((m) => {
        const tagStr = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
        return `[${m.id}] (${m.type}) ${m.content}${tagStr}`;
      })
      .join("\n\n");
    return { content: [{ type: "text", text: `${results.length} results for "${query}":\n\n${text}` }] };
  }
);

server.tool(
  "memory_related",
  "Get all memories related to specific tags/areas. Use to explore a topic in depth.",
  {
    tags: z.array(z.string()).describe("Tags to search for"),
    type: MEMORY_TYPE.optional(),
  },
  async ({ tags, type }) => {
    const results = store.getRelated(tags, type);
    if (results.length === 0) {
      return { content: [{ type: "text", text: `No memories tagged with: ${tags.join(", ")}` }] };
    }
    const text = results
      .map((m) => {
        const tagStr = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
        return `[${m.id}] (${m.type}) ${m.content}${tagStr}`;
      })
      .join("\n\n");
    return { content: [{ type: "text", text: `${results.length} related memories:\n\n${text}` }] };
  }
);

server.tool(
  "memory_ask",
  "Ask a question and get an answer synthesized from project memories. Like RAG over your project knowledge.",
  {
    question: z.string().describe("Question about the project"),
  },
  async ({ question }) => {
    // Search for relevant memories
    const results = store.searchMemories(question, 30);
    if (results.length === 0) {
      return { content: [{ type: "text", text: "No relevant memories found to answer this question." }] };
    }

    const prompt = buildAskPrompt(question, results);
    const answer = await callHaiku(prompt, 1024);

    if (!answer) {
      // Fallback: return raw memories
      const text = results
        .slice(0, 10)
        .map((m) => `- (${m.type}) ${m.content}`)
        .join("\n");
      return { content: [{ type: "text", text: `Could not synthesize answer. Relevant memories:\n${text}` }] };
    }

    return { content: [{ type: "text", text: answer }] };
  }
);

// --- Maintenance Tools ---

server.tool(
  "memory_consolidate",
  "Manually trigger memory consolidation. Merges duplicates, removes outdated memories, keeps memory sharp.",
  {},
  async () => {
    const grouped = store.getMemoriesForConsolidation();
    let consolidated = 0;

    for (const [type, memories] of Object.entries(grouped)) {
      if (memories.length < 3) continue;

      const prompt = buildConsolidationPrompt(type, memories);
      const response = await callHaiku(prompt, 2048);
      if (!response) continue;

      try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;
        const result = JSON.parse(jsonMatch[0]);
        if (result.keep && result.merge && result.drop) {
          store.applyConsolidation(result);
          consolidated += result.merge.length + result.drop.length;
        }
      } catch {
        // Skip
      }
    }

    syncClaudeMd();
    const counts = store.getAllMemoryCount();
    return {
      content: [{
        type: "text",
        text: `Consolidation complete. ${consolidated} memories merged/archived. Current: ${counts.active} active, ${counts.total} total.`,
      }],
    };
  }
);

server.tool(
  "memory_consciousness",
  "Generate the full consciousness document. This is what gets written to CLAUDE.md.",
  {},
  async () => {
    const doc = store.generateConsciousness();
    return { content: [{ type: "text", text: doc }] };
  }
);

server.tool(
  "memory_stats",
  "Show memory statistics: counts by type, active/archived/superseded, last consolidation.",
  {},
  async () => {
    const counts = store.getAllMemoryCount();
    const state = store.getState();
    const active = store.getActiveMemories();

    const byType: Record<string, number> = {};
    for (const m of active) {
      byType[m.type] = (byType[m.type] || 0) + 1;
    }

    const lines = [
      `Memory Stats:`,
      `  Active: ${counts.active}`,
      `  Archived: ${counts.archived}`,
      `  Superseded: ${counts.superseded}`,
      `  Total: ${counts.total}`,
      ``,
      `By type:`,
      ...Object.entries(byType).map(([t, n]) => `  ${t}: ${n}`),
      ``,
      `Extractions: ${state.extractionCount}`,
      `Last consolidation: ${state.lastConsolidation || "never"}`,
      `Last updated: ${state.lastUpdated}`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// --- CLAUDE.md Sync ---

function syncClaudeMd(): void {
  const claudeMdPath = path.join(projectDir, "CLAUDE.md");
  const consciousness = store.generateConsciousness();

  const marker = { start: "<!-- MEMORY:START -->", end: "<!-- MEMORY:END -->" };
  const memoryBlock = `${marker.start}\n${consciousness}\n${marker.end}`;

  if (fs.existsSync(claudeMdPath)) {
    let existing = fs.readFileSync(claudeMdPath, "utf-8");
    if (existing.includes(marker.start) && existing.includes(marker.end)) {
      const regex = new RegExp(`${escapeRegex(marker.start)}[\\s\\S]*?${escapeRegex(marker.end)}`);
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

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
