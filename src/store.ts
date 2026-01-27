import * as fs from "fs";
import * as path from "path";
import { Memory, MemoryType, ProjectState } from "./types";

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "using", "with", "for",
  "to", "in", "on", "of", "and", "that", "this", "it", "be", "as", "at",
  "by", "from", "or", "not", "but", "have", "has", "had", "do", "does",
  "did", "will", "would", "could", "should", "may", "might", "can",
  "we", "our", "they", "them", "its", "use", "used", "all", "each",
]);

const TYPE_LINE_BUDGET: Record<MemoryType, number> = {
  architecture: 25,
  decision: 25,
  pattern: 25,
  gotcha: 20,
  progress: 30,
  context: 15,
};

const TYPE_ORDER: MemoryType[] = [
  "architecture", "decision", "pattern", "gotcha", "progress", "context",
];

const TYPE_LABELS: Record<MemoryType, string> = {
  architecture: "## Architecture",
  decision: "## Key Decisions",
  pattern: "## Patterns & Conventions",
  gotcha: "## Gotchas & Pitfalls",
  progress: "## Current Progress",
  context: "## Context",
};

// --- Tokenization & Similarity ---

export function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) {
    if (b.has(x)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function scoreSearch(query: Set<string>, memory: Memory): number {
  const contentTokens = tokenize(memory.content);
  const tagTokens = new Set(memory.tags.map((t) => t.toLowerCase()));
  let score = 0;
  for (const q of query) {
    if (contentTokens.has(q)) score += 2;
    if (tagTokens.has(q)) score += 3;
  }
  return score;
}

// --- Atomic File Operations ---

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

// --- Lock ---

function acquireLock(memDir: string): boolean {
  const lockPath = path.join(memDir, "lock");
  if (fs.existsSync(lockPath)) {
    try {
      const pid = parseInt(fs.readFileSync(lockPath, "utf-8").trim());
      process.kill(pid, 0); // throws if process doesn't exist
      return false; // process alive, can't lock
    } catch {
      // stale lock, proceed
    }
  }
  fs.writeFileSync(lockPath, String(process.pid));
  return true;
}

function releaseLock(memDir: string): void {
  const lockPath = path.join(memDir, "lock");
  try {
    fs.unlinkSync(lockPath);
  } catch {}
}

// --- Store ---

export class MemoryStore {
  private storePath: string;
  private memDir: string;
  private state: ProjectState;

  constructor(projectDir: string) {
    this.memDir = path.join(projectDir, ".memory");
    if (!fs.existsSync(this.memDir)) {
      fs.mkdirSync(this.memDir, { recursive: true });
    }
    this.storePath = path.join(this.memDir, "state.json");
    this.state = this.load();
  }

  private load(): ProjectState {
    if (fs.existsSync(this.storePath)) {
      const raw = JSON.parse(fs.readFileSync(this.storePath, "utf-8"));
      // Migrate from v1
      if (!raw.version) {
        raw.version = 2;
        raw.extractionCount = raw.extractionCount || 0;
        for (const m of raw.memories) {
          if (m.confidence === undefined) m.confidence = 1;
          if (m.accessCount === undefined) m.accessCount = 0;
        }
      }
      return raw;
    }
    return {
      version: 2,
      project: path.basename(path.resolve(this.memDir, "..")),
      description: "",
      memories: [],
      lastUpdated: new Date().toISOString(),
      extractionCount: 0,
    };
  }

  private save(): void {
    this.state.lastUpdated = new Date().toISOString();
    atomicWrite(this.storePath, JSON.stringify(this.state, null, 2));
  }

  acquireLock(): boolean {
    return acquireLock(this.memDir);
  }

  releaseLock(): void {
    releaseLock(this.memDir);
  }

  setProject(name: string, description: string): void {
    this.state.project = name;
    this.state.description = description;
    this.save();
  }

  incrementExtractionCount(): number {
    this.state.extractionCount++;
    this.save();
    return this.state.extractionCount;
  }

  getExtractionCount(): number {
    return this.state.extractionCount;
  }

  // --- Memory CRUD ---

  addMemory(memory: Omit<Memory, "id" | "created" | "updated" | "confidence" | "accessCount">): Memory | null {
    const now = new Date().toISOString();
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Dedup: check if similar memory already exists
    const newTokens = tokenize(memory.content);
    const active = this.getActiveMemories();
    for (const existing of active) {
      if (existing.type !== memory.type) continue;
      const sim = jaccard(newTokens, tokenize(existing.content));
      if (sim > 0.6) {
        // Supersede the old one with the newer content
        existing.tags.push("superseded");
        existing.updated = now;
        break;
      }
    }

    // If superseding by explicit ID
    if (memory.supersedes) {
      const old = this.state.memories.find((m) => m.id === memory.supersedes);
      if (old && !old.tags.includes("superseded")) {
        old.tags.push("superseded");
        old.updated = now;
      }
    }

    const full: Memory = {
      ...memory,
      id,
      confidence: 1,
      accessCount: 0,
      created: now,
      updated: now,
    };

    this.state.memories.push(full);
    this.save();
    return full;
  }

  deleteMemory(id: string): boolean {
    const idx = this.state.memories.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.state.memories.splice(idx, 1);
    this.save();
    return true;
  }

  // --- Queries ---

  getActiveMemories(): Memory[] {
    return this.state.memories.filter(
      (m) => !m.tags.includes("superseded") && !m.tags.includes("archived")
    );
  }

  getMemories(opts?: { type?: string; tags?: string[]; active?: boolean }): Memory[] {
    let mems = opts?.active === false
      ? this.state.memories
      : this.getActiveMemories();

    if (opts?.type) {
      mems = mems.filter((m) => m.type === opts.type);
    }
    if (opts?.tags?.length) {
      mems = mems.filter((m) => opts.tags!.some((t) => m.tags.includes(t)));
    }
    return mems;
  }

  searchMemories(query: string, limit: number = 20): Memory[] {
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return [];

    const active = this.getActiveMemories();
    const scored = active
      .map((m) => ({ memory: m, score: scoreSearch(queryTokens, m) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Bump access count
    for (const s of scored) {
      s.memory.accessCount++;
    }
    if (scored.length > 0) this.save();

    return scored.map((s) => s.memory);
  }

  getRelated(tags: string[], type?: MemoryType): Memory[] {
    const lowerTags = tags.map((t) => t.toLowerCase());
    let mems = this.getActiveMemories().filter((m) =>
      m.tags.some((t) => lowerTags.includes(t.toLowerCase()))
    );
    if (type) {
      mems = mems.filter((m) => m.type === type);
    }
    // Bump access count
    for (const m of mems) {
      m.accessCount++;
    }
    if (mems.length > 0) this.save();
    return mems;
  }

  // --- Decay ---

  decayConfidence(): void {
    const now = Date.now();
    for (const m of this.state.memories) {
      if (m.tags.includes("superseded") || m.tags.includes("archived")) continue;
      const ageDays = (now - new Date(m.updated).getTime()) / 86400000;

      if (m.type === "progress") {
        m.confidence = Math.max(0, 1 - ageDays / 7);
      } else if (m.type === "context") {
        m.confidence = Math.max(0, 1 - ageDays / 30);
      }
      // architecture, decision, pattern, gotcha don't decay
    }
    this.save();
  }

  // --- Consolidation ---

  needsConsolidation(): boolean {
    const active = this.getActiveMemories();
    return active.length > 80 || (this.state.extractionCount > 0 && this.state.extractionCount % 10 === 0);
  }

  /**
   * Apply consolidation results from LLM.
   * Called by extractor after getting LLM consolidation response.
   */
  applyConsolidation(results: { keep: string[]; merge: { content: string; tags: string[]; sources: string[] }[]; drop: string[] }): void {
    const now = new Date().toISOString();

    // Drop
    for (const id of results.drop) {
      const m = this.state.memories.find((mem) => mem.id === id);
      if (m) {
        m.tags.push("archived");
        m.updated = now;
      }
    }

    // Merge
    for (const merge of results.merge) {
      // Archive sources
      for (const srcId of merge.sources) {
        const m = this.state.memories.find((mem) => mem.id === srcId);
        if (m) {
          m.tags.push("superseded");
          m.updated = now;
        }
      }

      // Determine type from first source
      const firstSource = this.state.memories.find((m) => m.id === merge.sources[0]);
      const type = firstSource?.type || "context";

      const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.state.memories.push({
        id,
        type: type as MemoryType,
        content: merge.content,
        tags: merge.tags,
        created: now,
        updated: now,
        confidence: 1,
        accessCount: 0,
        mergedFrom: merge.sources,
      });
    }

    // Prune old archived memories (>14 days)
    const fourteenDaysAgo = Date.now() - 14 * 86400000;
    this.state.memories = this.state.memories.filter((m) => {
      if (m.tags.includes("archived") && new Date(m.updated).getTime() < fourteenDaysAgo) {
        return false;
      }
      return true;
    });

    this.state.lastConsolidation = now;
    this.save();
  }

  /**
   * Get memories formatted for consolidation LLM prompt (grouped by type).
   */
  getMemoriesForConsolidation(): Record<string, { id: string; content: string }[]> {
    const active = this.getActiveMemories();
    const grouped: Record<string, { id: string; content: string }[]> = {};
    for (const m of active) {
      if (!grouped[m.type]) grouped[m.type] = [];
      grouped[m.type].push({ id: m.id, content: m.content });
    }
    return grouped;
  }

  getState(): ProjectState {
    return this.state;
  }

  getAllMemoryCount(): { active: number; archived: number; superseded: number; total: number } {
    const active = this.state.memories.filter(
      (m) => !m.tags.includes("superseded") && !m.tags.includes("archived")
    ).length;
    const archived = this.state.memories.filter((m) => m.tags.includes("archived")).length;
    const superseded = this.state.memories.filter((m) => m.tags.includes("superseded")).length;
    return { active, archived, superseded, total: this.state.memories.length };
  }

  // --- Consciousness Generation (Line-Budgeted) ---

  generateConsciousness(): string {
    const s = this.state;
    const active = this.getActiveMemories().filter((m) => m.confidence > 0.3);

    const sections: string[] = [];
    const counts = this.getAllMemoryCount();

    // Header
    sections.push(`# ${s.project}`);
    if (s.description) {
      sections.push(s.description);
    }
    sections.push(
      `\n_Last updated: ${s.lastUpdated.split("T")[0]} | ${counts.active} active memories, ${counts.total} total_\n`
    );

    // Group by type
    const grouped: Record<string, Memory[]> = {};
    for (const m of active) {
      if (!grouped[m.type]) grouped[m.type] = [];
      grouped[m.type].push(m);
    }

    // Sort each group by importance: confidence * (1 + accessCount/10)
    for (const type of Object.keys(grouped)) {
      grouped[type].sort((a, b) => {
        const scoreA = a.confidence * (1 + a.accessCount / 10);
        const scoreB = b.confidence * (1 + b.accessCount / 10);
        return scoreB - scoreA;
      });
    }

    // Calculate budgets - redistribute unused lines
    const budgets = { ...TYPE_LINE_BUDGET };
    let surplus = 0;
    const overBudget: MemoryType[] = [];

    for (const type of TYPE_ORDER) {
      const count = grouped[type]?.length || 0;
      if (count < budgets[type]) {
        surplus += budgets[type] - count;
        budgets[type] = count;
      } else if (count > budgets[type]) {
        overBudget.push(type);
      }
    }

    // Redistribute surplus to over-budget types
    if (overBudget.length > 0 && surplus > 0) {
      const extra = Math.floor(surplus / overBudget.length);
      for (const type of overBudget) {
        budgets[type] += extra;
      }
    }

    // Render
    for (const type of TYPE_ORDER) {
      const mems = grouped[type];
      if (!mems?.length) continue;

      sections.push(TYPE_LABELS[type]);

      const limit = budgets[type];
      for (let i = 0; i < Math.min(mems.length, limit); i++) {
        const m = mems[i];
        let line = m.content;
        if (line.length > 120) {
          line = line.slice(0, 117) + "...";
        }
        const tagStr = m.tags.filter((t) => t !== "superseded" && t !== "archived").length
          ? ` [${m.tags.filter((t) => t !== "superseded" && t !== "archived").join(", ")}]`
          : "";
        sections.push(`- ${line}${tagStr}`);
      }

      if (mems.length > limit) {
        sections.push(`- _...and ${mems.length - limit} more (use memory_search to find them)_`);
      }

      sections.push("");
    }

    sections.push("_For deeper context, use memory_search, memory_related, or memory_ask tools._");

    return sections.join("\n");
  }
}
