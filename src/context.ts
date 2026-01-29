/**
 * context.ts - Context visualization and token counting
 *
 * Provides metrics about memory usage, token counts, and context distribution.
 */

import * as fs from "fs";
import * as path from "path";
import { MemoryStore } from "./store";
import { listSnapshots } from "./git-snapshot";

// Rough token estimation: ~4 chars per token for English text
const CHARS_PER_TOKEN = 4;

export interface ContextMetrics {
  // CLAUDE.md (Tier 1)
  claudeMd: {
    exists: boolean;
    lines: number;
    chars: number;
    tokens: number;
    memoryBlockLines: number;
    memoryBlockTokens: number;
  };

  // .memory/state.json (Tier 2)
  memoryStore: {
    exists: boolean;
    totalMemories: number;
    activeMemories: number;
    archivedMemories: number;
    supersededMemories: number;
    totalChars: number;
    totalTokens: number;
    byType: Record<string, { count: number; tokens: number }>;
  };

  // Git snapshots
  snapshots: {
    enabled: boolean;
    branch: string;
    remote: string | null;
    totalCommits: number;
    latestCommit: string | null;
    latestDate: string | null;
  };

  // Summary
  summary: {
    tier1Tokens: number;
    tier2Tokens: number;
    totalTokens: number;
    tier1Percentage: number;
    snapshotCount: number;
  };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function getContextMetrics(projectDir: string): ContextMetrics {
  const claudeMdPath = path.join(projectDir, "CLAUDE.md");
  const memDir = path.join(projectDir, ".memory");
  const statePath = path.join(memDir, "state.json");

  // CLAUDE.md metrics
  let claudeMd = {
    exists: false,
    lines: 0,
    chars: 0,
    tokens: 0,
    memoryBlockLines: 0,
    memoryBlockTokens: 0,
  };

  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, "utf-8");
    claudeMd.exists = true;
    claudeMd.lines = content.split("\n").length;
    claudeMd.chars = content.length;
    claudeMd.tokens = estimateTokens(content);

    // Extract memory block
    const startMarker = "<!-- MEMORY:START -->";
    const endMarker = "<!-- MEMORY:END -->";
    const startIdx = content.indexOf(startMarker);
    const endIdx = content.indexOf(endMarker);
    if (startIdx !== -1 && endIdx !== -1) {
      const memoryBlock = content.slice(startIdx, endIdx + endMarker.length);
      claudeMd.memoryBlockLines = memoryBlock.split("\n").length;
      claudeMd.memoryBlockTokens = estimateTokens(memoryBlock);
    }
  }

  // Memory store metrics
  let memoryStore = {
    exists: false,
    totalMemories: 0,
    activeMemories: 0,
    archivedMemories: 0,
    supersededMemories: 0,
    totalChars: 0,
    totalTokens: 0,
    byType: {} as Record<string, { count: number; tokens: number }>,
  };

  if (fs.existsSync(statePath)) {
    const store = new MemoryStore(projectDir);
    const state = store.getState();
    const counts = store.getAllMemoryCount();

    memoryStore.exists = true;
    memoryStore.totalMemories = counts.total;
    memoryStore.activeMemories = counts.active;
    memoryStore.archivedMemories = counts.archived;
    memoryStore.supersededMemories = counts.superseded;

    // Calculate tokens by type
    for (const memory of state.memories) {
      const tokens = estimateTokens(memory.content);
      memoryStore.totalChars += memory.content.length;
      memoryStore.totalTokens += tokens;

      if (!memoryStore.byType[memory.type]) {
        memoryStore.byType[memory.type] = { count: 0, tokens: 0 };
      }
      memoryStore.byType[memory.type].count++;
      memoryStore.byType[memory.type].tokens += tokens;
    }
  }

  // Snapshot metrics
  let snapshots = {
    enabled: false,
    branch: "__memory-snapshots",
    remote: null as string | null,
    totalCommits: 0,
    latestCommit: null as string | null,
    latestDate: null as string | null,
  };

  if (fs.existsSync(statePath)) {
    const store = new MemoryStore(projectDir);
    const config = store.getSnapshotConfig();
    if (config) {
      snapshots.enabled = config.enabled;
      snapshots.branch = config.branch;
      snapshots.remote = config.remote || null;

      if (config.enabled) {
        const snapshotList = listSnapshots(projectDir, config.branch, 100);
        snapshots.totalCommits = snapshotList.length;
        if (snapshotList.length > 0) {
          snapshots.latestCommit = snapshotList[0].hash.slice(0, 7);
          snapshots.latestDate = snapshotList[0].date.split(" ")[0];
        }
      }
    }
  }

  // Summary
  const tier1Tokens = claudeMd.tokens;
  const tier2Tokens = memoryStore.totalTokens;
  const totalTokens = tier1Tokens + tier2Tokens;

  return {
    claudeMd,
    memoryStore,
    snapshots,
    summary: {
      tier1Tokens,
      tier2Tokens,
      totalTokens,
      tier1Percentage: totalTokens > 0 ? Math.round((tier1Tokens / totalTokens) * 100) : 0,
      snapshotCount: snapshots.totalCommits,
    },
  };
}

/**
 * Generate ASCII bar chart
 */
export function asciiBar(value: number, max: number, width: number = 20): string {
  const filled = Math.round((value / max) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

/**
 * Format token count with K suffix
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return String(tokens);
}

/**
 * Generate HTML dashboard
 */
export function generateHtmlDashboard(projectDir: string, metrics: ContextMetrics): string {
  const projectName = path.basename(projectDir);

  const typeColors: Record<string, string> = {
    architecture: "#4a9eff",
    decision: "#ff6b6b",
    pattern: "#6bcb77",
    gotcha: "#ffd93d",
    progress: "#9b59b6",
    context: "#1abc9c",
  };

  const typeData = Object.entries(metrics.memoryStore.byType)
    .map(([type, data]) => ({
      type,
      count: data.count,
      tokens: data.tokens,
      color: typeColors[type] || "#888",
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>memory-mcp Context Dashboard - ${projectName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      min-height: 100vh;
      padding: 2rem;
    }
    .dashboard {
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 {
      font-size: 2rem;
      margin-bottom: 0.5rem;
      background: linear-gradient(90deg, #4a9eff, #6bcb77);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      color: #888;
      margin-bottom: 2rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }
    .card {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 1.5rem;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .card h2 {
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #888;
      margin-bottom: 1rem;
    }
    .big-number {
      font-size: 3rem;
      font-weight: bold;
      line-height: 1;
    }
    .big-number.blue { color: #4a9eff; }
    .big-number.green { color: #6bcb77; }
    .big-number.yellow { color: #ffd93d; }
    .big-number.purple { color: #9b59b6; }
    .label {
      color: #888;
      font-size: 0.875rem;
      margin-top: 0.5rem;
    }
    .progress-bar {
      height: 8px;
      background: rgba(255,255,255,0.1);
      border-radius: 4px;
      overflow: hidden;
      margin: 1rem 0;
    }
    .progress-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s ease;
    }
    .tier-breakdown {
      display: flex;
      gap: 1rem;
      margin-top: 1rem;
    }
    .tier {
      flex: 1;
      padding: 1rem;
      background: rgba(255,255,255,0.05);
      border-radius: 8px;
    }
    .tier-name {
      font-size: 0.75rem;
      text-transform: uppercase;
      color: #888;
    }
    .tier-value {
      font-size: 1.5rem;
      font-weight: bold;
      margin-top: 0.25rem;
    }
    .type-list {
      margin-top: 1rem;
    }
    .type-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.5rem 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .type-color {
      width: 12px;
      height: 12px;
      border-radius: 3px;
    }
    .type-name {
      flex: 1;
    }
    .type-count {
      color: #888;
      font-size: 0.875rem;
    }
    .type-tokens {
      font-weight: bold;
      min-width: 60px;
      text-align: right;
    }
    .snapshot-info {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .snapshot-row {
      display: flex;
      justify-content: space-between;
      padding: 0.5rem 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .snapshot-label { color: #888; }
    .snapshot-value { font-weight: 500; }
    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 500;
    }
    .status-badge.enabled {
      background: rgba(107, 203, 119, 0.2);
      color: #6bcb77;
    }
    .status-badge.disabled {
      background: rgba(255, 107, 107, 0.2);
      color: #ff6b6b;
    }
    .footer {
      text-align: center;
      color: #555;
      font-size: 0.875rem;
      margin-top: 2rem;
    }
    .footer a {
      color: #4a9eff;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="dashboard">
    <h1>🧠 memory-mcp</h1>
    <p class="subtitle">${projectName} - Context Dashboard</p>

    <div class="grid">
      <!-- Total Tokens -->
      <div class="card">
        <h2>Total Context</h2>
        <div class="big-number blue">${formatTokens(metrics.summary.totalTokens)}</div>
        <div class="label">estimated tokens</div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${metrics.summary.tier1Percentage}%; background: linear-gradient(90deg, #4a9eff, #6bcb77);"></div>
        </div>
        <div class="tier-breakdown">
          <div class="tier">
            <div class="tier-name">Tier 1 (CLAUDE.md)</div>
            <div class="tier-value" style="color: #4a9eff;">${formatTokens(metrics.summary.tier1Tokens)}</div>
          </div>
          <div class="tier">
            <div class="tier-name">Tier 2 (state.json)</div>
            <div class="tier-value" style="color: #6bcb77;">${formatTokens(metrics.summary.tier2Tokens)}</div>
          </div>
        </div>
      </div>

      <!-- Memories -->
      <div class="card">
        <h2>Memories</h2>
        <div class="big-number green">${metrics.memoryStore.activeMemories}</div>
        <div class="label">active memories</div>
        <div class="type-list">
          ${typeData.map(t => `
            <div class="type-item">
              <div class="type-color" style="background: ${t.color};"></div>
              <div class="type-name">${t.type}</div>
              <div class="type-count">${t.count}</div>
              <div class="type-tokens">${formatTokens(t.tokens)}</div>
            </div>
          `).join("")}
        </div>
      </div>

      <!-- CLAUDE.md -->
      <div class="card">
        <h2>CLAUDE.md (Tier 1)</h2>
        <div class="big-number purple">${metrics.claudeMd.lines}</div>
        <div class="label">lines</div>
        <div class="snapshot-info" style="margin-top: 1rem;">
          <div class="snapshot-row">
            <span class="snapshot-label">Memory block</span>
            <span class="snapshot-value">${metrics.claudeMd.memoryBlockLines} lines</span>
          </div>
          <div class="snapshot-row">
            <span class="snapshot-label">Tokens</span>
            <span class="snapshot-value">${formatTokens(metrics.claudeMd.tokens)}</span>
          </div>
          <div class="snapshot-row">
            <span class="snapshot-label">Characters</span>
            <span class="snapshot-value">${metrics.claudeMd.chars.toLocaleString()}</span>
          </div>
        </div>
      </div>

      <!-- Snapshots -->
      <div class="card">
        <h2>Git Snapshots</h2>
        <div class="big-number yellow">${metrics.snapshots.totalCommits}</div>
        <div class="label">commits</div>
        <div class="snapshot-info" style="margin-top: 1rem;">
          <div class="snapshot-row">
            <span class="snapshot-label">Status</span>
            <span class="status-badge ${metrics.snapshots.enabled ? 'enabled' : 'disabled'}">
              ${metrics.snapshots.enabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <div class="snapshot-row">
            <span class="snapshot-label">Branch</span>
            <span class="snapshot-value">${metrics.snapshots.branch}</span>
          </div>
          <div class="snapshot-row">
            <span class="snapshot-label">Remote</span>
            <span class="snapshot-value">${metrics.snapshots.remote || 'local only'}</span>
          </div>
          ${metrics.snapshots.latestCommit ? `
          <div class="snapshot-row">
            <span class="snapshot-label">Latest</span>
            <span class="snapshot-value">${metrics.snapshots.latestCommit} (${metrics.snapshots.latestDate})</span>
          </div>
          ` : ''}
        </div>
      </div>
    </div>

    <div class="footer">
      Generated by <a href="https://github.com/yuvalsuede/memory-mcp">memory-mcp</a> |
      <code>npm install -g claude-code-memory</code>
    </div>
  </div>
</body>
</html>`;
}
