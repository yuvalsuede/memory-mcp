# memory-mcp

Persistent memory for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Never lose context between sessions again.

## The Problem

Every few days, you start a new Claude Code session and have to re-explain your project — the architecture, the decisions you made, the patterns you follow, the gotchas you discovered. All that context is gone.

## The Solution

`memory-mcp` silently captures what matters during your sessions and makes it available to every future session — automatically.

```
Session 1: Claude works → hooks silently extract memories → saved
Session 2: Claude starts → reads CLAUDE.md → instantly knows everything
```

No commands to run. No "remember this". It just works.

## How It Works

```mermaid
graph TB
    subgraph "Phase 1: Silent Capture"
        A[Claude Code Session] -->|User sends message| B[Claude responds]
        B -->|Hook fires: Stop/PreCompact/SessionEnd| C[extractor.js]
        C --> D[Read transcript from cursor]
        D --> E[Chunk if >6000 chars]
        E --> F[Send to Haiku LLM]
        F -->|Extract memories as JSON| G[Dedup via Jaccard similarity]
        G --> H[Save to .memory/state.json]
        H --> I[Decay confidence scores]
        I --> J{Consolidation needed?}
        J -->|>80 memories or every 10 extractions| K[Haiku merges/drops]
        J -->|No| L[Sync CLAUDE.md]
        K --> L
    end

    subgraph "Phase 2: Recovery"
        M[New session starts] -->|Built-in behavior| N[Claude reads CLAUDE.md]
        N --> O[Claude has full project context]
    end

    subgraph "Phase 3: Deep Recall"
        O --> P{Need specific context?}
        P -->|memory_search| Q[Keyword search across memories]
        P -->|memory_ask| R[Haiku synthesizes answer from top 30 matches]
        P -->|memory_related| S[Tag-based retrieval]
    end

    subgraph "Data Store"
        H -.-> T[(.memory/state.json<br/>Full memory store)]
        L -.-> U[(CLAUDE.md<br/>~150 line summary)]
        T -.->|MCP tools read| Q
        T -.->|MCP tools read| R
        T -.->|MCP tools read| S
    end

    style A fill:#4a9eff,color:#fff
    style F fill:#ff6b6b,color:#fff
    style K fill:#ff6b6b,color:#fff
    style R fill:#ff6b6b,color:#fff
    style T fill:#ffd93d,color:#000
    style U fill:#6bcb77,color:#000
```

**Two-tier memory architecture:**

| Layer | Purpose | Size |
|-------|---------|------|
| `CLAUDE.md` | Auto-read on session start. Top ~150 lines of the most important context. | Compact |
| `.memory/state.json` | Full memory store. Searchable via MCP tools mid-conversation. | Unlimited |

**Silent capture via hooks:**

Claude Code hooks fire after every response (`Stop`), before context compaction (`PreCompact`), and at session end (`SessionEnd`). A fast LLM (Haiku) reads the transcript and extracts:

- **Architecture** — how the system is structured
- **Decisions** — why X was chosen over Y
- **Patterns** — conventions and how things are done
- **Gotchas** — non-obvious pitfalls
- **Progress** — what's done, what's in flight
- **Context** — business context, deadlines, preferences

**Smart memory management:**

- Jaccard similarity deduplication (no duplicate memories)
- Confidence decay (progress fades after 7 days, context after 30)
- LLM-powered consolidation (merges overlapping memories, prunes stale ones)
- Line-budgeted CLAUDE.md (stays under ~150 lines, most important first)

## Quick Start

```bash
# Install globally
npm install -g memory-mcp

# Interactive setup (API key + hooks)
memory-mcp setup

# Initialize a project
memory-mcp init ~/Projects/my-app
```

That's it. Start a Claude Code session and memories will begin accumulating automatically.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- Node.js 18+
- Anthropic API key (for the Haiku-based extractor, ~$0.001 per extraction)

## CLI Commands

```
memory-mcp setup              Interactive first-time setup
memory-mcp init [dir]          Initialize memory for a project
memory-mcp status [dir]        Show memory status and health
memory-mcp search <query>      Search memories by keyword
memory-mcp ask <question>      Ask a question, get answer from memory
memory-mcp consolidate [dir]   Merge duplicates, prune stale memories
memory-mcp key [api-key]       Set or check Anthropic API key
memory-mcp help                Show help
```

## MCP Tools (used by Claude mid-conversation)

When configured as an MCP server, Claude can access these tools during a session:

| Tool | Description |
|------|-------------|
| `memory_search` | Keyword search across all memories |
| `memory_related` | Get memories by tag or area |
| `memory_ask` | Ask a question, get an LLM-synthesized answer from memory |
| `memory_save` | Manually save a memory |
| `memory_recall` | List all memories with filters |
| `memory_delete` | Remove a memory |
| `memory_consolidate` | Trigger memory consolidation |
| `memory_consciousness` | Generate the full consciousness document |
| `memory_stats` | Show memory statistics |
| `memory_init` | Set project name and description |

## What Gets Stored

Memories are categorized into six types:

```
architecture   "Next.js 14 app router with Supabase backend, Stripe for billing"
decision       "Chose server components for public pages because of SEO requirements"
pattern        "All API routes validate input with zod and return NextResponse"
gotcha         "Supabase RLS policy on word_lists requires user_id OR org_id, not both"
progress       "Auth complete, billing webhook handling in progress"
context        "Client wants launch by March, focus on core features only"
```

## File Structure

After initialization, your project gets:

```
your-project/
├── CLAUDE.md              ← auto-updated memory summary (read on session start)
├── .memory/
│   ├── state.json         ← full memory store
│   └── cursor.json        ← tracks what's been processed
├── .mcp.json              ← MCP server configuration
└── .claude/
    └── settings.json      ← hook configuration
```

## CLAUDE.md Format

The memory block is inserted between markers, preserving any existing CLAUDE.md content:

```markdown
<!-- MEMORY:START -->
# MyProject
A brief description

_Last updated: 2026-01-27 | 45 active memories, 62 total_

## Architecture
- Next.js 14 app router with Supabase backend
- Auth via NextAuth with Google and email providers

## Key Decisions
- Chose server components for SEO pages
- Using Supabase RLS instead of API-level auth

## Patterns & Conventions
- All API routes use zod validation
- Tailwind only, no CSS modules

## Gotchas & Pitfalls
- RLS policy requires user_id OR org_id, not both

## Current Progress
- Auth: complete
- Billing: in progress

## Context
- Launch target: March

_For deeper context, use memory_search, memory_related, or memory_ask tools._
<!-- MEMORY:END -->
```

## Global vs Per-Project Install

**Global** (recommended): hooks work for all projects automatically.

```bash
memory-mcp setup  # select "global" when prompted
```

**Per-project**: hooks and MCP configured per project.

```bash
memory-mcp init /path/to/project
```

## Configuration

API key is resolved in order:
1. `ANTHROPIC_API_KEY` environment variable
2. `~/.memory-mcp/config.json`
3. `~/.config/anthropic/api_key`
4. `~/.anthropic/api_key`

## Cost

The extractor uses Claude Haiku for memory extraction and consolidation. Typical cost:

- ~$0.001 per extraction (after each Claude response)
- ~$0.005 per consolidation (every ~10 extractions)
- A full day of coding: ~$0.05–0.10

## License

MIT
