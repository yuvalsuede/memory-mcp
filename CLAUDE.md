<!-- MEMORY:START -->
# memory-mcp

_Last updated: 2026-01-27 | 28 active memories, 28 total_

## Architecture
- Memory system needs two modes: instant session recovery and mid-session deep context recall for large projects [memory-design, context-management]
- Two-tier memory system with CLAUDE.md (top 150 lines) and `.memory/state.json` (unlimited storage) for project contex... [memory, architecture]
- Renamed npm package from `memory-mcp` to `claude-memory-mcp` [packaging, branding]
- Official MCP registry publisher requires manual cloning and building from GitHub source repository, not a standard np... [deployment, mcp-registry]

## Key Decisions
- Project memory must be scalable beyond typical 2-5K token context window limits [scaling, context-management]
- Created a CLI tool for memory-mcp with commands like setup, init, status, search, ask, consolidate, and key management [cli, tooling]
- Memory extractor modified to handle new transcript format with nested message content and tool interactions within as... [memory-mcp, architecture]
- Corrected Anthropic Claude model ID from `claude-haiku-4-20250414` to `claude-3-5-haiku-20241022` [llm, configuration]
- Prepared documentation including README.md, ARCHITECTURE.md, LICENSE, CHANGELOG.md for project release [documentation, release-prep]
- Renamed npm package from `claude-memory-mcp` to `claude-code-memory` after verifying availability and selecting the m... [npm, packaging]
- Resolved MCP SDK compatibility by switching back to zod v4 after initially attempting zod v3 [dependency, typescript]
- Proposed version bump to 1.0.1 to distribute clean build with zod v4 to npm users [versioning, npm]
- Bumped package version to 1.0.2 to support MCP registry validation requirements [versioning, deployment]
- Identified two separate publish workflows: one for Smithery using `npx @smithery/cli deploy` and another for official... [deployment, registry]

## Gotchas & Pitfalls
- Transcript parsing originally failed due to mismatched entry types: expected 'human/user' but actual format uses 'use... [memory-mcp, parsing]
- MCP server communication fails due to zod version incompatibility between zod v3 and v4, causing JSON parsing errors ... [dependency, typescript]
- Zod v3 causes infinite type recursion with MCP SDK's `server.tool()`, requiring a downgrade to zod v4 [typescript, dependency, sdk]
- Smithery CLI deploy fails for stdio-based local servers, which cannot be published through their current web UI desig... [deployment, registry]

## Current Progress
- Explored alternative MCP project submission methods, including potential web submission or PR acceptance [research, deployment]
- Official MCP registry publication process is not straightforward, with `mcp-publisher` not existing as a simple npm p... [publishing, registry]
- Attempted to use Smithery CLI `publish` command, which does not exist, with the correct command being `deploy` [cli, deployment]
- Submitted MCP project listings to multiple awesome-mcp-servers repositories via PRs and issues [community, visibility]
- Successfully added MCP registry support by including `mcpName` in package.json and creating server.json and smithery.... [npm, registry, deployment]
- Verified MCP server responds correctly with valid JSON-RPC after dependency fix [server, testing]
- Successfully published `claude-code-memory` npm package version 1.0.0 [npm, release]
- Prepared package for npm publish, but encountered expired authentication token requiring manual login [deployment, npm]
- Created GitHub repository for memory-mcp project at https://github.com/yuvalsuede/memory-mcp [repository, version-control]
- Prepared the project for open-source release with README, LICENSE, CHANGELOG, and npm package configuration [release, open-source]

_For deeper context, use memory_search, memory_related, or memory_ask tools._
<!-- MEMORY:END -->
