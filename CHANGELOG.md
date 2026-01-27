# Changelog

## 1.0.0 (2026-01-27)

Initial release.

### Features

- Silent memory capture via Claude Code hooks (Stop, PreCompact, SessionEnd)
- Haiku-powered extraction — automatically identifies decisions, patterns, gotchas, architecture, progress, context
- Two-tier memory: compact CLAUDE.md (auto-read) + unlimited .memory/state.json (searchable)
- 10 MCP tools: search, ask (RAG), related, save, recall, delete, consolidate, consciousness, stats, init
- Jaccard similarity deduplication
- Confidence decay (progress: 7 days, context: 30 days)
- LLM-powered consolidation (auto every 10 extractions or 80+ memories)
- Line-budgeted CLAUDE.md (~150 lines max, most important first)
- CLI tool: setup, init, status, search, ask, consolidate, key
- Interactive setup wizard
- Global and per-project install modes
- API key resolution chain (env var, config files)
- Atomic writes and lock files for concurrent safety
