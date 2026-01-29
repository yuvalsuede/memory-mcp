#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { MemoryStore } from "./store";
import { callHaiku, buildAskPrompt, buildConsolidationPrompt } from "./llm";
import { isGitRepo, remoteExists, listSnapshots, diffSnapshots, restoreSnapshot } from "./git-snapshot";

// --- Colors (no dependencies) ---

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

function ok(msg: string) { console.log(`  ${c.green}✓${c.reset} ${msg}`); }
function skip(msg: string) { console.log(`  ${c.gray}·${c.reset} ${c.gray}${msg}${c.reset}`); }
function warn(msg: string) { console.log(`  ${c.yellow}!${c.reset} ${msg}`); }
function err(msg: string) { console.error(`  ${c.red}✗${c.reset} ${msg}`); }
function heading(msg: string) { console.log(`\n${c.bold}${msg}${c.reset}\n`); }

// --- Prompt ---

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function confirm(question: string): Promise<boolean> {
  const answer = await ask(`${question} (Y/n)`);
  return answer === "" || answer.toLowerCase().startsWith("y");
}

// --- Paths ---

const HOME = process.env.HOME || "";
const MEMORY_MCP_DIR = path.resolve(__dirname, "..");
const EXTRACTOR_PATH = path.join(MEMORY_MCP_DIR, "dist", "extractor.js");
const SERVER_PATH = path.join(MEMORY_MCP_DIR, "dist", "index.js");
const GLOBAL_CONFIG_DIR = path.join(HOME, ".memory-mcp");
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, "config.json");
const GLOBAL_CLAUDE_SETTINGS = path.join(HOME, ".claude", "settings.json");

// --- Config ---

function readGlobalConfig(): Record<string, any> {
  if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
    try { return JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, "utf-8")); } catch { }
  }
  return {};
}

function writeGlobalConfig(config: Record<string, any>): void {
  if (!fs.existsSync(GLOBAL_CONFIG_DIR)) fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function hasApiKey(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  const config = readGlobalConfig();
  if (config.apiKey) return true;
  const candidates = [
    path.join(HOME, ".config", "anthropic", "api_key"),
    path.join(HOME, ".anthropic", "api_key"),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

// --- Hook Installation ---

function installHooks(settingsPath: string): { added: number } {
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch { settings = {}; }
  }

  if (!settings.hooks) settings.hooks = {};

  // Quote path to handle spaces (e.g., "Application Support" on macOS)
  const hookEntry = {
    hooks: [{ type: "command", command: `node "${EXTRACTOR_PATH}"`, timeout: 30 }],
  };

  let added = 0;
  for (const event of ["Stop", "PreCompact", "SessionEnd"]) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    const exists = settings.hooks[event].some(
      (h: any) => h.hooks?.some((hh: any) => hh.command?.includes("memory-mcp"))
    );

    if (!exists) {
      settings.hooks[event].push(hookEntry);
      added++;
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { added };
}

// --- Commands ---

async function cmdSetup() {
  console.log(`
${c.bold}${c.magenta}  memory-mcp${c.reset} ${c.dim}— persistent memory for Claude Code${c.reset}
`);

  // 1. API Key
  heading("Step 1: API Key");
  if (hasApiKey()) {
    ok("API key found");
  } else {
    console.log("  The extractor needs an Anthropic API key to analyze transcripts.");
    console.log("  It uses Haiku (very cheap — ~$0.001 per extraction).\n");
    const key = await ask("Paste your ANTHROPIC_API_KEY:");
    if (key) {
      const config = readGlobalConfig();
      config.apiKey = key;
      writeGlobalConfig(config);
      ok("API key saved to ~/.memory-mcp/config.json");
    } else {
      warn("No key provided. Set ANTHROPIC_API_KEY env var or run: memory-mcp setup");
    }
  }

  // 2. Install mode
  heading("Step 2: Install hooks");
  const global = await confirm("Install globally? (works for all projects)");

  if (global) {
    const { added } = installHooks(GLOBAL_CLAUDE_SETTINGS);
    if (added > 0) {
      ok(`Installed ${added} hooks in ~/.claude/settings.json`);
    } else {
      skip("Hooks already installed globally");
    }
  } else {
    const projectDir = await ask("Project directory (or . for current):");
    const absDir = path.resolve(projectDir || ".");
    if (!fs.existsSync(absDir)) {
      err(`Directory not found: ${absDir}`);
      return;
    }
    const settingsPath = path.join(absDir, ".claude", "settings.json");
    const { added } = installHooks(settingsPath);
    if (added > 0) {
      ok(`Installed ${added} hooks in ${settingsPath}`);
    } else {
      skip("Hooks already installed");
    }

    // Also add MCP server
    installMcpConfig(absDir);

    // Also add .gitignore
    installGitignore(absDir);
  }

  // 3. Done
  heading("Setup complete");
  console.log(`  How it works:
    ${c.cyan}1.${c.reset} Claude works normally — no commands needed
    ${c.cyan}2.${c.reset} After each response, a hook silently extracts memories
    ${c.cyan}3.${c.reset} Memories sync to CLAUDE.md automatically
    ${c.cyan}4.${c.reset} New session → reads CLAUDE.md → instant context

  To add MCP tools (search, ask) to a project:
    ${c.bold}memory-mcp init ${c.dim}/path/to/project${c.reset}
`);
}

async function setupGitSnapshots(absDir: string, store: MemoryStore): Promise<void> {
  heading("Step: Git Snapshots (automatic versioning)");

  // Check if already configured
  const existingConfig = store.getSnapshotConfig();
  if (existingConfig?.enabled) {
    skip(`Git snapshots already enabled (branch: ${existingConfig.branch}, remote: ${existingConfig.remote || "local only"})`);
    return;
  }

  // Check if this is a git repo
  if (!isGitRepo(absDir)) {
    skip("Not a git repository - skipping git snapshots");
    console.log(`  ${c.dim}Initialize git to enable automatic project versioning.${c.reset}`);
    return;
  }

  console.log(`  Git snapshots create automatic commits of your entire project`);
  console.log(`  on a hidden branch after each memory extraction.`);
  console.log(`  This gives you full project history tied to your working sessions.\n`);

  const enableSnapshots = await confirm("Enable git snapshots?");
  if (!enableSnapshots) {
    skip("Git snapshots disabled");
    store.setSnapshotConfig({ enabled: false, branch: "__memory-snapshots" });
    return;
  }

  // Ask for remote
  let remote: string | undefined;
  const hasOrigin = remoteExists(absDir, "origin");

  if (hasOrigin) {
    const useOrigin = await confirm("Push snapshots to 'origin' remote?");
    if (useOrigin) {
      remote = "origin";
    } else {
      const customRemote = await ask("Remote name (or leave empty for local only):");
      if (customRemote && remoteExists(absDir, customRemote)) {
        remote = customRemote;
      } else if (customRemote) {
        warn(`Remote '${customRemote}' not found - using local only`);
      }
    }
  } else {
    console.log(`  ${c.dim}No 'origin' remote found. Snapshots will be local only.${c.reset}`);
    const customRemote = await ask("Remote name (or leave empty for local only):");
    if (customRemote && remoteExists(absDir, customRemote)) {
      remote = customRemote;
    }
  }

  // Save config
  const config = {
    enabled: true,
    branch: "__memory-snapshots",
    remote,
  };
  store.setSnapshotConfig(config);

  ok(`Git snapshots enabled`);
  console.log(`  ${c.cyan}Branch:${c.reset} ${config.branch}`);
  console.log(`  ${c.cyan}Remote:${c.reset} ${remote || "local only"}`);
  console.log(`  ${c.dim}Every memory save will commit your project state.${c.reset}`);
}

async function cmdInit(projectDir?: string) {
  const absDir = path.resolve(projectDir || ".");
  if (!fs.existsSync(absDir)) {
    err(`Directory not found: ${absDir}`);
    process.exit(1);
  }

  heading(`Initializing memory-mcp for ${c.cyan}${absDir}${c.reset}`);

  // .memory dir
  const memDir = path.join(absDir, ".memory");
  if (!fs.existsSync(memDir)) {
    fs.mkdirSync(memDir, { recursive: true });
    ok("Created .memory/");
  } else {
    skip(".memory/ exists");
  }

  // Hooks
  const settingsPath = path.join(absDir, ".claude", "settings.json");
  const { added } = installHooks(settingsPath);
  if (added > 0) ok(`Installed ${added} hooks`);
  else skip("Hooks already installed");

  // MCP config
  installMcpConfig(absDir);

  // .gitignore
  installGitignore(absDir);

  // Project name
  const store = new MemoryStore(absDir);
  const state = store.getState();
  if (!state.description) {
    const name = await ask(`Project name [${path.basename(absDir)}]:`);
    const desc = await ask("Brief description:");
    store.setProject(name || path.basename(absDir), desc || "");
    ok("Project initialized");
  } else {
    skip(`Project already named: ${state.project}`);
  }

  // Git snapshots
  await setupGitSnapshots(absDir, store);

  console.log(`
  ${c.green}Done!${c.reset} MCP tools available next time Claude Code starts.
`);
}

function installMcpConfig(absDir: string): void {
  const mcpPath = path.join(absDir, ".mcp.json");
  let mcpConfig: any = {};
  if (fs.existsSync(mcpPath)) {
    try { mcpConfig = JSON.parse(fs.readFileSync(mcpPath, "utf-8")); } catch { mcpConfig = {}; }
  }
  if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};

  if (!mcpConfig.mcpServers.memory) {
    mcpConfig.mcpServers.memory = {
      command: "node",
      args: [SERVER_PATH, absDir],
    };
    fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));
    ok("Added MCP server to .mcp.json");
  } else {
    skip("MCP server already in .mcp.json");
  }
}

function installGitignore(absDir: string): void {
  const gitignorePath = path.join(absDir, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".memory")) {
      fs.appendFileSync(gitignorePath, "\n# Memory MCP\n.memory/\n");
      ok("Added .memory/ to .gitignore");
    } else {
      skip(".memory/ already in .gitignore");
    }
  } else {
    fs.writeFileSync(gitignorePath, "# Memory MCP\n.memory/\n");
    ok("Created .gitignore");
  }
}

async function cmdStatus(projectDir?: string) {
  const absDir = path.resolve(projectDir || ".");
  const memDir = path.join(absDir, ".memory");

  heading(`memory-mcp status`);

  // Check components
  const hasMemDir = fs.existsSync(memDir);
  const hasState = fs.existsSync(path.join(memDir, "state.json"));
  const hasMcp = fs.existsSync(path.join(absDir, ".mcp.json"));
  const hasHooks = checkHooksInstalled(absDir);
  const hasKey = hasApiKey();
  const hasClaudeMd = fs.existsSync(path.join(absDir, "CLAUDE.md"));

  console.log(`  ${c.bold}Project:${c.reset}    ${absDir}`);
  console.log(`  ${c.bold}.memory/:${c.reset}   ${hasMemDir ? c.green + "exists" : c.red + "missing"}${c.reset}`);
  console.log(`  ${c.bold}State:${c.reset}      ${hasState ? c.green + "exists" : c.yellow + "empty"}${c.reset}`);
  console.log(`  ${c.bold}.mcp.json:${c.reset}  ${hasMcp ? c.green + "configured" : c.red + "missing"}${c.reset}`);
  console.log(`  ${c.bold}Hooks:${c.reset}      ${hasHooks ? c.green + "installed" : c.red + "not installed"}${c.reset}`);
  console.log(`  ${c.bold}API key:${c.reset}    ${hasKey ? c.green + "found" : c.red + "missing"}${c.reset}`);
  console.log(`  ${c.bold}CLAUDE.md:${c.reset}  ${hasClaudeMd ? c.green + "exists" : c.yellow + "not yet created"}${c.reset}`);

  if (hasState) {
    const store = new MemoryStore(absDir);
    const counts = store.getAllMemoryCount();
    const state = store.getState();
    console.log("");
    console.log(`  ${c.bold}Memories:${c.reset}   ${c.cyan}${counts.active}${c.reset} active, ${c.gray}${counts.archived} archived, ${counts.superseded} superseded${c.reset}`);
    console.log(`  ${c.bold}Extractions:${c.reset} ${state.extractionCount}`);
    console.log(`  ${c.bold}Last update:${c.reset} ${state.lastUpdated}`);
    console.log(`  ${c.bold}Last consolidation:${c.reset} ${state.lastConsolidation || "never"}`);

    // Snapshot stats
    const snapshotConfig = store.getSnapshotConfig();
    if (snapshotConfig?.enabled) {
      const snapshots = listSnapshots(absDir, snapshotConfig.branch);
      console.log("");
      console.log(`  ${c.bold}Git Snapshots:${c.reset} ${c.green}enabled${c.reset}`);
      console.log(`  ${c.bold}Branch:${c.reset}     ${snapshotConfig.branch}`);
      console.log(`  ${c.bold}Remote:${c.reset}     ${snapshotConfig.remote || "local only"}`);
      console.log(`  ${c.bold}Commits:${c.reset}    ${c.cyan}${snapshots.length}${c.reset} snapshots`);
    } else if (snapshotConfig) {
      console.log("");
      console.log(`  ${c.bold}Git Snapshots:${c.reset} ${c.yellow}disabled${c.reset}`);
    } else if (isGitRepo(absDir)) {
      console.log("");
      console.log(`  ${c.bold}Git Snapshots:${c.reset} ${c.dim}not configured${c.reset} (run ${c.bold}memory-mcp snapshot-enable${c.reset})`);
    }
  }

  if (!hasMemDir || !hasHooks || !hasKey) {
    console.log(`\n  Run ${c.bold}memory-mcp setup${c.reset} to fix missing components.`);
  }

  console.log("");
}

function checkHooksInstalled(absDir: string): boolean {
  // Check project-level
  const projectSettings = path.join(absDir, ".claude", "settings.json");
  if (checkHooksInFile(projectSettings)) return true;
  // Check global
  return checkHooksInFile(GLOBAL_CLAUDE_SETTINGS);
}

function checkHooksInFile(settingsPath: string): boolean {
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    return settings.hooks?.Stop?.some(
      (h: any) => h.hooks?.some((hh: any) => hh.command?.includes("memory-mcp"))
    ) ?? false;
  } catch {
    return false;
  }
}

async function cmdSearch(query: string, projectDir?: string) {
  const absDir = path.resolve(projectDir || ".");
  const store = new MemoryStore(absDir);
  const results = store.searchMemories(query, 20);

  if (results.length === 0) {
    console.log(`  No memories matching "${query}".`);
    return;
  }

  heading(`${results.length} results for "${query}"`);
  for (const m of results) {
    const tags = m.tags.length ? ` ${c.dim}[${m.tags.join(", ")}]${c.reset}` : "";
    const conf = m.confidence < 1 ? ` ${c.yellow}(${Math.round(m.confidence * 100)}%)${c.reset}` : "";
    console.log(`  ${c.cyan}${m.type}${c.reset} ${m.content}${tags}${conf}`);
    console.log(`  ${c.gray}${m.id}${c.reset}`);
    console.log("");
  }
}

async function cmdAsk(question: string, projectDir?: string) {
  const absDir = path.resolve(projectDir || ".");
  const store = new MemoryStore(absDir);
  const results = store.searchMemories(question, 30);

  if (results.length === 0) {
    console.log("  No relevant memories found.");
    return;
  }

  heading("Thinking...");
  const prompt = buildAskPrompt(question, results);
  const answer = await callHaiku(prompt, 1024);

  if (answer) {
    console.log(`  ${answer}`);
  } else {
    err("Could not reach LLM. Showing raw matches:");
    for (const m of results.slice(0, 5)) {
      console.log(`  - (${m.type}) ${m.content}`);
    }
  }
  console.log("");
}

async function cmdConsolidate(projectDir?: string) {
  const absDir = path.resolve(projectDir || ".");
  const store = new MemoryStore(absDir);
  const grouped = store.getMemoriesForConsolidation();

  heading("Consolidating memories...");

  let totalMerged = 0;
  for (const [type, memories] of Object.entries(grouped)) {
    if (memories.length < 3) continue;

    console.log(`  ${c.cyan}${type}${c.reset}: ${memories.length} memories`);
    const prompt = buildConsolidationPrompt(type, memories);
    const response = await callHaiku(prompt, 2048);
    if (!response) { warn(`  Failed for ${type}`); continue; }

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;
      const result = JSON.parse(jsonMatch[0]);
      if (result.keep && result.merge && result.drop) {
        store.applyConsolidation(result);
        const count = result.merge.length + result.drop.length;
        totalMerged += count;
        ok(`${count} merged/archived`);
      }
    } catch {
      warn(`Parse error for ${type}`);
    }
  }

  // Sync CLAUDE.md
  syncClaudeMd(absDir, store);

  const counts = store.getAllMemoryCount();
  console.log(`\n  ${c.green}Done.${c.reset} ${totalMerged} memories consolidated. ${counts.active} active, ${counts.total} total.\n`);
}

function syncClaudeMd(projectDir: string, store: MemoryStore): void {
  const claudeMdPath = path.join(projectDir, "CLAUDE.md");
  const consciousness = store.generateConsciousness();
  const marker = { start: "<!-- MEMORY:START -->", end: "<!-- MEMORY:END -->" };
  const memoryBlock = `${marker.start}\n${consciousness}\n${marker.end}`;

  if (fs.existsSync(claudeMdPath)) {
    let existing = fs.readFileSync(claudeMdPath, "utf-8");
    if (existing.includes(marker.start) && existing.includes(marker.end)) {
      const regex = new RegExp(`${marker.start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${marker.end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
      existing = existing.replace(regex, memoryBlock);
    } else {
      existing = existing.trimEnd() + "\n\n" + memoryBlock + "\n";
    }
    fs.writeFileSync(claudeMdPath, existing);
  } else {
    fs.writeFileSync(claudeMdPath, memoryBlock + "\n");
  }
}

async function cmdKey(key?: string) {
  if (key) {
    const config = readGlobalConfig();
    config.apiKey = key;
    writeGlobalConfig(config);
    ok("API key saved to ~/.memory-mcp/config.json");
  } else if (hasApiKey()) {
    ok("API key is configured");
  } else {
    err("No API key found");
    console.log(`\n  Set it with: ${c.bold}memory-mcp key <your-api-key>${c.reset}`);
    console.log(`  Or set ANTHROPIC_API_KEY environment variable.\n`);
  }
}

// --- Snapshot Commands ---

async function cmdSnapshots(projectDir?: string) {
  const absDir = path.resolve(projectDir || ".");
  const store = new MemoryStore(absDir);
  const config = store.getSnapshotConfig();

  heading("Git Snapshots");

  if (!config?.enabled) {
    console.log(`  ${c.yellow}Snapshots not enabled for this project.${c.reset}`);
    console.log(`  Run ${c.bold}memory-mcp init${c.reset} to enable.\n`);
    return;
  }

  console.log(`  ${c.bold}Branch:${c.reset} ${config.branch}`);
  console.log(`  ${c.bold}Remote:${c.reset} ${config.remote || "local only"}\n`);

  const snapshots = listSnapshots(absDir, config.branch, 15);

  if (snapshots.length === 0) {
    console.log(`  ${c.dim}No snapshots yet. They'll be created after memory extractions.${c.reset}\n`);
    return;
  }

  console.log(`  ${c.bold}Recent snapshots:${c.reset}\n`);
  for (const snap of snapshots) {
    const shortHash = snap.hash.slice(0, 7);
    const date = snap.date.split(" ")[0];
    console.log(`  ${c.cyan}${shortHash}${c.reset} ${date} ${c.dim}${snap.message}${c.reset}`);
  }

  console.log(`\n  ${c.dim}Use 'memory-mcp snapshot-diff <hash1> <hash2>' to compare versions.${c.reset}`);
  console.log(`  ${c.dim}Use 'memory-mcp snapshot-restore <hash>' to restore a version.${c.reset}\n`);
}

async function cmdSnapshotDiff(hash1: string, hash2: string, projectDir?: string) {
  const absDir = path.resolve(projectDir || ".");

  heading(`Diff: ${hash1.slice(0, 7)} → ${hash2.slice(0, 7)}`);

  const diff = diffSnapshots(absDir, hash1, hash2);
  console.log(diff);
}

async function cmdSnapshotRestore(hash: string, projectDir?: string) {
  const absDir = path.resolve(projectDir || ".");

  console.log(`\n  ${c.yellow}Warning:${c.reset} This will overwrite your current project files`);
  console.log(`  with the state from snapshot ${c.cyan}${hash.slice(0, 7)}${c.reset}.\n`);

  const confirmed = await confirm("Continue?");
  if (!confirmed) {
    console.log("  Cancelled.\n");
    return;
  }

  const result = restoreSnapshot(absDir, hash);
  if (result.success) {
    ok(`Restored project to snapshot ${hash.slice(0, 7)}`);
    console.log(`  ${c.dim}Files have been updated. Review changes with 'git status'.${c.reset}\n`);
  } else {
    err(`Failed to restore: ${result.error}`);
  }
}

async function cmdSnapshotEnable(projectDir?: string) {
  const absDir = path.resolve(projectDir || ".");
  const memDir = path.join(absDir, ".memory");

  if (!fs.existsSync(memDir)) {
    err("No .memory directory found. Run 'memory-mcp init' first.");
    return;
  }

  const store = new MemoryStore(absDir);
  await setupGitSnapshots(absDir, store);
}

async function cmdSnapshotDisable(projectDir?: string) {
  const absDir = path.resolve(projectDir || ".");
  const store = new MemoryStore(absDir);
  const config = store.getSnapshotConfig();

  if (!config?.enabled) {
    skip("Snapshots already disabled");
    return;
  }

  store.setSnapshotConfig({ ...config, enabled: false });
  ok("Git snapshots disabled");
  console.log(`  ${c.dim}Existing snapshots on branch '${config.branch}' are preserved.${c.reset}\n`);
}

// --- Help ---

function printHelp() {
  console.log(`
${c.bold}${c.magenta}memory-mcp${c.reset} — persistent memory for Claude Code

${c.bold}USAGE${c.reset}
  memory-mcp <command> [options]

${c.bold}COMMANDS${c.reset}
  ${c.cyan}setup${c.reset}                  Interactive first-time setup (API key + hooks)
  ${c.cyan}init${c.reset} [dir]              Initialize memory for a project
  ${c.cyan}status${c.reset} [dir]            Show memory status and health
  ${c.cyan}search${c.reset} <query> [dir]    Search memories by keyword
  ${c.cyan}ask${c.reset} <question> [dir]    Ask a question, get answer from memory
  ${c.cyan}consolidate${c.reset} [dir]       Merge duplicates, prune stale memories
  ${c.cyan}key${c.reset} [api-key]           Set or check Anthropic API key
  ${c.cyan}snapshots${c.reset} [dir]         List git snapshot history
  ${c.cyan}snapshot-enable${c.reset} [dir]   Enable git snapshots (after git init)
  ${c.cyan}snapshot-disable${c.reset} [dir]  Disable git snapshots
  ${c.cyan}snapshot-diff${c.reset} <h1> <h2> Compare two snapshots
  ${c.cyan}snapshot-restore${c.reset} <hash> Restore project to a snapshot
  ${c.cyan}help${c.reset}                    Show this help

${c.bold}EXAMPLES${c.reset}
  ${c.dim}# First time setup${c.reset}
  memory-mcp setup

  ${c.dim}# Add memory to a project${c.reset}
  memory-mcp init ~/Projects/my-app

  ${c.dim}# Check what's remembered${c.reset}
  memory-mcp search "auth flow"

  ${c.dim}# Ask your project's memory a question${c.reset}
  memory-mcp ask "how does billing work?"

${c.bold}HOW IT WORKS${c.reset}
  1. Claude Code hooks silently capture what happens each session
  2. A fast LLM (Haiku) extracts important memories automatically
  3. Memories sync to CLAUDE.md — read on every new session
  4. MCP tools let Claude search/ask memory mid-conversation
`);
}

function printVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(MEMORY_MCP_DIR, "package.json"), "utf-8"));
  console.log(`memory-mcp v${pkg.version}`);
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "setup":
      return cmdSetup();
    case "init":
      return cmdInit(args[1]);
    case "status":
      return cmdStatus(args[1]);
    case "search":
      if (!args[1]) { err("Usage: memory-mcp search <query>"); process.exit(1); }
      return cmdSearch(args[1], args[2]);
    case "ask":
      if (!args[1]) { err("Usage: memory-mcp ask <question>"); process.exit(1); }
      return cmdAsk(args[1], args[2]);
    case "consolidate":
      return cmdConsolidate(args[1]);
    case "key":
      return cmdKey(args[1]);
    case "snapshots":
      return cmdSnapshots(args[1]);
    case "snapshot-enable":
      return cmdSnapshotEnable(args[1]);
    case "snapshot-disable":
      return cmdSnapshotDisable(args[1]);
    case "snapshot-diff":
      if (!args[1] || !args[2]) { err("Usage: memory-mcp snapshot-diff <hash1> <hash2>"); process.exit(1); }
      return cmdSnapshotDiff(args[1], args[2], args[3]);
    case "snapshot-restore":
      if (!args[1]) { err("Usage: memory-mcp snapshot-restore <hash>"); process.exit(1); }
      return cmdSnapshotRestore(args[1], args[2]);
    case "help":
    case "--help":
    case "-h":
      return printHelp();
    case "version":
    case "--version":
    case "-v":
      return printVersion();
    default:
      if (!command) {
        printHelp();
      } else {
        err(`Unknown command: ${command}`);
        console.log(`  Run ${c.bold}memory-mcp help${c.reset} for usage.\n`);
        process.exit(1);
      }
  }
}

main().catch((e) => {
  err(e.message || String(e));
  process.exit(1);
});
