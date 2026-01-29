#!/usr/bin/env node

/**
 * install.ts - Set up memory-mcp for a project or globally.
 *
 * Usage:
 *   node dist/install.js <project-dir>           # Per-project install
 *   node dist/install.js --global                 # Global install (all projects)
 *   node dist/install.js --api-key <key>          # Store API key globally
 *   node dist/install.js --global --api-key <key> # Both
 */

import * as fs from "fs";
import * as path from "path";

const args = process.argv.slice(2);
const isGlobal = args.includes("--global");
const apiKeyIdx = args.indexOf("--api-key");
const apiKey = apiKeyIdx !== -1 ? args[apiKeyIdx + 1] : null;
const projectDir = args.find((a) => !a.startsWith("--") && a !== apiKey);

const memoryMcpDir = path.resolve(__dirname, "..");
const extractorPath = path.join(memoryMcpDir, "dist", "extractor.js");
const serverPath = path.join(memoryMcpDir, "dist", "index.js");
const homeDir = process.env.HOME || "";

if (!isGlobal && !projectDir && !apiKey) {
  console.error(`Usage:
  memory-mcp-install <project-dir>             Per-project install
  memory-mcp-install --global                  Global install (all projects)
  memory-mcp-install --api-key <key>           Store API key
  memory-mcp-install --global --api-key <key>  Both`);
  process.exit(1);
}

// --- Store API Key ---

if (apiKey) {
  const configDir = path.join(homeDir, ".memory-mcp");
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const configPath = path.join(configDir, "config.json");
  let config: any = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
  config.apiKey = apiKey;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`  ✓ API key stored in ~/.memory-mcp/config.json`);
}

// --- Hook Config ---

// Quote path to handle spaces (e.g., "Application Support" on macOS)
const hookCommand = `node "${extractorPath}"`;
const hookEntry = {
  hooks: [{ type: "command", command: hookCommand, timeout: 30 }],
};

function installHooks(settingsPath: string): void {
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  }

  if (!settings.hooks) settings.hooks = {};

  for (const event of ["Stop", "PreCompact", "SessionEnd"]) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }
    const alreadyInstalled = settings.hooks[event].some(
      (h: any) => h.hooks?.some((hh: any) => hh.command?.includes("memory-mcp"))
    );
    if (!alreadyInstalled) {
      settings.hooks[event].push(hookEntry);
      console.log(`  ✓ Added ${event} hook`);
    } else {
      console.log(`  · ${event} hook already exists`);
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// --- Global Install ---

if (isGlobal) {
  console.log(`\nInstalling memory-mcp globally\n`);

  // Hooks in ~/.claude/settings.json
  const globalSettingsPath = path.join(homeDir, ".claude", "settings.json");
  installHooks(globalSettingsPath);

  console.log(`
Done! memory-mcp hooks installed globally.

How it works:
  1. Claude works normally in any project — no commands needed
  2. After each response, a hook silently reads the transcript
  3. A fast LLM extracts important memories to .memory/ in the project
  4. Memories sync to CLAUDE.md automatically
  5. New sessions read CLAUDE.md → instant context recovery

To also add the MCP server (for search/ask tools), add to each project's .mcp.json:
  {
    "mcpServers": {
      "memory": {
        "command": "node",
        "args": ["${serverPath}"]
      }
    }
  }

Or run: memory-mcp-install <project-dir>  (for per-project MCP)
`);
}

// --- Per-Project Install ---

if (projectDir) {
  const absProjectDir = path.resolve(projectDir);
  console.log(`\nInstalling memory-mcp for: ${absProjectDir}\n`);

  // 1. Create .memory directory
  const memDir = path.join(absProjectDir, ".memory");
  if (!fs.existsSync(memDir)) {
    fs.mkdirSync(memDir, { recursive: true });
    console.log("  ✓ Created .memory/");
  } else {
    console.log("  · .memory/ already exists");
  }

  // 2. Hooks (project-level)
  const settingsPath = path.join(absProjectDir, ".claude", "settings.json");
  installHooks(settingsPath);

  // 3. MCP server config
  const mcpPath = path.join(absProjectDir, ".mcp.json");
  let mcpConfig: any = {};
  if (fs.existsSync(mcpPath)) {
    mcpConfig = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
  }

  if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};

  if (!mcpConfig.mcpServers.memory) {
    mcpConfig.mcpServers.memory = {
      command: "node",
      args: [serverPath, absProjectDir],
    };
    console.log("  ✓ Added MCP server to .mcp.json");
  } else {
    console.log("  · MCP server already in .mcp.json");
  }

  fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));

  // 4. .gitignore
  const gitignorePath = path.join(absProjectDir, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, "utf-8");
    if (!gitignore.includes(".memory")) {
      fs.appendFileSync(gitignorePath, "\n# Memory MCP\n.memory/\n");
      console.log("  ✓ Added .memory/ to .gitignore");
    } else {
      console.log("  · .memory/ already in .gitignore");
    }
  } else {
    fs.writeFileSync(gitignorePath, "# Memory MCP\n.memory/\n");
    console.log("  ✓ Created .gitignore with .memory/");
  }

  console.log(`
Done! memory-mcp installed for ${absProjectDir}.

MCP Tools available:
  memory_search   — keyword search across all memories
  memory_related  — get memories by tag/area
  memory_ask      — ask a question, get synthesized answer
  memory_save     — manually save a memory
  memory_recall   — list all memories
  memory_stats    — show memory statistics
  memory_consolidate — merge/prune memories
`);
}
