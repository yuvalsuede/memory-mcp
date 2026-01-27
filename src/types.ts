export interface Memory {
  id: string;
  type: "decision" | "pattern" | "gotcha" | "architecture" | "progress" | "context";
  content: string;
  tags: string[];
  created: string;
  updated: string;
  supersedes?: string;
  confidence: number;       // 0-1, decays over time for progress/context
  accessCount: number;      // bumped on search/recall hits
  mergedFrom?: string[];    // IDs this memory was consolidated from
}

export type MemoryType = Memory["type"];

export interface ProjectState {
  version: number;          // schema version for future migrations
  project: string;
  description: string;
  memories: Memory[];
  lastUpdated: string;
  lastConsolidation?: string;
  extractionCount: number;
}

export interface ConsolidationResult {
  keep: string[];
  merge: { content: string; tags: string[]; sources: string[] }[];
  drop: string[];
}
