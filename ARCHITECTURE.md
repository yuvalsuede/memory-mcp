# memory-mcp Architecture

## Overview

memory-mcp gives Claude Code persistent memory across sessions. It has three components that work independently:

```
┌─────────────────────────────────────────────────────────────┐
│                    COMPONENT 1: HOOKS                       │
│              (Silent background capture)                    │
│                                                             │
│  Claude Code fires hooks → extractor.js reads transcript    │
│  → calls Haiku to extract memories → saves to state.json    │
│  → syncs CLAUDE.md                                          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                  COMPONENT 2: MCP SERVER                    │
│            (Mid-session search & retrieval)                 │
│                                                             │
│  Claude calls memory_search/memory_ask/memory_related       │
│  → reads state.json → returns results                       │
│  → memory_ask calls Haiku to synthesize answer              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    COMPONENT 3: CLI                         │
│              (Human management interface)                   │
│                                                             │
│  memory-mcp setup/init/status/search/ask/consolidate        │
│  → manages hooks, API keys, project config                  │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

### Phase 1: Capture (automatic, silent)

```
Claude Code session
│
├─ User sends message
├─ Claude responds (reads files, writes code, runs commands)
├─ Claude responds again
├─ ...
│
▼ Hook event fires (Stop / PreCompact / SessionEnd)
│
▼ Claude Code passes JSON to extractor.js via stdin:
│   {
│     "session_id": "abc-123",
│     "transcript_path": "/Users/x/.claude/projects/.../session.jsonl",
│     "cwd": "/Users/x/Projects/my-app",
│     "hook_event_name": "Stop"
│   }
│
▼ extractor.js runs:
│
│  1. LOCK
│  │  Acquire .memory/lock (PID-based, skip if another extractor running)
│  │
│  2. READ TRANSCRIPT
│  │  Read session.jsonl from cursor position (skip already-processed lines)
│  │  Parse JSONL → extract user messages, assistant messages, tool calls
│  │  Produce a human-readable summary:
│  │    "USER: add billing to the app"
│  │    "CLAUDE: I'll implement Stripe integration..."
│  │    "TOOL [Write]: src/lib/stripe.ts"
│  │    "TOOL [Bash]: npm install stripe"
│  │
│  3. CHUNK (if summary > 6000 chars)
│  │  Split into 6000-char chunks with 500-char overlap
│  │  Process each chunk separately
│  │
│  4. EXTRACT via LLM
│  │  Send to Haiku with context-aware prompt:
│  │  ┌──────────────────────────────────────────────┐
│  │  │ "Here are EXISTING memories: [...]            │
│  │  │  Here is the TRANSCRIPT: [...]                │
│  │  │  Extract only NEW or UPDATED memories.        │
│  │  │  Return JSON array."                          │
│  │  └──────────────────────────────────────────────┘
│  │  Haiku returns:
│  │  [
│  │    {"type": "architecture", "content": "Stripe integration via src/lib/stripe.ts",
│  │     "tags": ["billing", "stripe"], "supersedes_content": null},
│  │    {"type": "decision", "content": "Using Stripe Checkout instead of custom forms",
│  │     "tags": ["billing"], "supersedes_content": null}
│  │  ]
│  │
│  5. DEDUP & SAVE
│  │  For each extracted memory:
│  │    a. If supersedes_content set → find matching existing memory by Jaccard
│  │       similarity (>0.5 threshold) → mark old as superseded
│  │    b. Jaccard dedup against all active memories of same type
│  │       (>0.6 threshold) → auto-supersede if duplicate
│  │    c. Save to state.json
│  │
│  6. DECAY
│  │  Update confidence scores:
│  │    progress memories: confidence = max(0, 1 - age_days/7)
│  │    context memories:  confidence = max(0, 1 - age_days/30)
│  │    others: no decay
│  │
│  7. CONSOLIDATE (conditional)
│  │  If event=SessionEnd OR extractionCount%10==0 OR activeMemories>80:
│  │    For each memory type with 5+ memories:
│  │      Send to Haiku: "merge overlapping, drop outdated"
│  │      Apply result: keep/merge/drop
│  │      Prune archived memories older than 14 days
│  │
│  8. SYNC CLAUDE.md
│  │  Generate consciousness document (line-budgeted, ~150 lines)
│  │  Insert/replace between <!-- MEMORY:START --> and <!-- MEMORY:END --> markers
│  │  Preserves any existing CLAUDE.md content outside markers
│  │
│  9. UPDATE CURSOR
│  │  Save line number so next extraction starts where we left off
│  │
│  10. RELEASE LOCK
```

### Phase 2: Recovery (automatic, on session start)

```
New Claude Code session starts
│
▼ Claude reads CLAUDE.md (built-in behavior, no code needed)
│
▼ Claude sees:
│   # MyProject
│   ## Architecture
│   - Stripe integration via src/lib/stripe.ts
│   ## Key Decisions
│   - Using Stripe Checkout instead of custom forms
│   ## Gotchas
│   - Stripe webhook needs raw body parsing
│   ...
│   _For deeper context, use memory_search, memory_related, or memory_ask tools._
│
▼ Claude now has full project context
```

### Phase 3: Deep Recall (on demand, mid-session)

```
Claude is working and needs specific context
│
▼ Calls MCP tool: memory_search("stripe webhook")
│   → tokenizes query → scores against all active memories
│   → returns ranked results with content and tags
│
▼ Or calls: memory_ask("how does billing work?")
│   → searches memories → sends top 30 to Haiku
│   → Haiku synthesizes a coherent answer
│   → returns answer to Claude
│
▼ Or calls: memory_related(tags: ["billing", "stripe"])
│   → returns all memories tagged with billing or stripe
│
▼ Claude continues working with full context
```

## File Structure

```
project/
├── CLAUDE.md                    ← Tier 1: compact summary (auto-read)
│   └── <!-- MEMORY:START/END --> markers
├── .memory/
│   ├── state.json               ← Tier 2: full memory store
│   ├── cursor.json              ← per-session extraction progress
│   └── lock                     ← PID lock file (transient)
├── .mcp.json                    ← MCP server config
└── .claude/
    └── settings.json            ← hook config

~/.memory-mcp/
└── config.json                  ← global API key storage

~/.claude/
└── settings.json                ← global hooks (if --global install)
```

## Memory Data Model

```
Memory {
  id: "mem_1706345600000_a1b2c3"    // unique, timestamp-based
  type: "architecture" | "decision" | "pattern" | "gotcha" | "progress" | "context"
  content: "Stripe integration via src/lib/stripe.ts"
  tags: ["billing", "stripe"]
  created: "2026-01-27T09:00:00Z"
  updated: "2026-01-27T09:00:00Z"
  confidence: 1.0                    // decays for progress/context
  accessCount: 0                     // bumped on search/recall hits
  supersedes?: "mem_..."             // ID of memory this replaces
  mergedFrom?: ["mem_...", "mem_..."] // consolidation lineage
}
```

**Lifecycle of a memory:**

```
                  ┌──────────┐
                  │  Created  │  confidence = 1.0
                  └────┬─────┘
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
    [active]     [superseded]   [archived]
    normal       replaced by     dropped by
    state        newer memory    consolidation
         │                            │
         ▼                            ▼
    [decayed]                    [pruned]
    confidence < 0.3             deleted after
    hidden from CLAUDE.md        14 days
    still searchable
```

## Intelligence Layer

### Jaccard Similarity (dedup)

```
tokenize("Using Next.js app router") → {"next", "app", "router"}
tokenize("Project uses Next.js app router") → {"project", "uses", "next", "app", "router"}

jaccard = |intersection| / |union| = |{"next","app","router"}| / |{"project","uses","next","app","router"}|
        = 3/5 = 0.6

Threshold: >0.6 = duplicate → supersede old with new
```

Stop words removed: the, a, an, is, are, with, for, to, in, on, of, and, etc.

### Confidence Decay

```
Progress memories:  confidence = max(0, 1 - age_days / 7)
  Day 0: 1.0  →  Day 3: 0.57  →  Day 7: 0.0

Context memories:   confidence = max(0, 1 - age_days / 30)
  Day 0: 1.0  →  Day 15: 0.5  →  Day 30: 0.0

Architecture, Decision, Pattern, Gotcha: no decay (permanent knowledge)
```

Memories with confidence < 0.3 are hidden from CLAUDE.md but still searchable via MCP tools.

### Line-Budgeted CLAUDE.md

```
Total budget: ~150 lines

Per-type allocation:
  architecture: 25 lines
  decision:     25 lines
  pattern:      25 lines
  gotcha:       20 lines
  progress:     30 lines
  context:      15 lines

Sorting: confidence × (1 + accessCount/10) descending
Overflow: "...and N more (use memory_search to find them)"
Unused budget redistributed to over-budget types
```

### Consolidation

Triggered: every 10 extractions, or >80 active memories, or on SessionEnd.

Per memory type, sends to Haiku:
```
"Here are 25 'progress' memories. Merge overlapping ones,
drop outdated ones. Return {keep: [...], merge: [...], drop: [...]}"
```

Result applied atomically: sources marked superseded, merged memories created, dropped memories archived.

## API Key Resolution

Checked in order, first found wins:

```
1. ANTHROPIC_API_KEY environment variable
2. ~/.memory-mcp/config.json → apiKey field
3. ~/.config/anthropic/api_key (file contents)
4. ~/.anthropic/api_key (file contents)
```

## Cost Model

Haiku is used for:
- Extraction: ~1 call per Claude response (when hook fires), ~$0.001
- Consolidation: ~1 call per memory type per 10 extractions, ~$0.002
- memory_ask: 1 call per question, ~$0.001

Typical daily cost for active development: $0.05–0.10

## Hook Events

| Event | When | Extractor behavior |
|-------|------|-------------------|
| Stop | After each Claude response | Normal extraction (min 3 transcript lines) |
| PreCompact | Before context compaction | Lower threshold (min 1 line) — context about to be lost |
| SessionEnd | Session terminates | Extract + always consolidate |

## Concurrency Safety

- **Lock file**: `.memory/lock` contains PID. If process alive, skip extraction.
- **Atomic writes**: state.json written to `.tmp` then renamed.
- **Cursor per session**: each session tracks its own position in the transcript.
