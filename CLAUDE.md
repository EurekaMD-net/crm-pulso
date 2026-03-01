# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Quick Context

Agentic CRM for media ad sales. NanoClaw engine at `engine/`, all CRM code at `crm/`. Salespeople chat with AI agents via WhatsApp. Each group has an isolated agent with role-appropriate CRM access.

## Key Files

| File | Purpose |
|------|---------|
| `crm/src/bootstrap.ts` | CRM init: creates schema, registers hooks |
| `crm/src/schema.ts` | 11 CRM tables + 2 RAG tables |
| `crm/src/hierarchy.ts` | isManagerOf, isDirectorOf, isVp helpers |
| `crm/src/ipc-handlers.ts` | CRM IPC handler (crm_log_interaction, etc.) |
| `crm/src/doc-sync.ts` | Document sync pipeline (Phase 7) |
| `crm/src/register.ts` | Batch hierarchy registration |
| `crm/container/mcp/src/crm-tools.ts` | CRM write tools MCP server |
| `crm/container/mcp/src/google-workspace.ts` | Gmail, Drive, Calendar MCP server |
| `crm/container/mcp/src/rag-search.ts` | Semantic document search MCP server |
| `crm/groups/global.md` | Global CLAUDE.md template (schema, queries, rules) |
| `crm/groups/ae.md` | AE persona template |
| `crm/groups/manager.md` | Manager persona template |

### Engine Hook Points (DO NOT modify beyond these 5 files)

| File | Change |
|------|--------|
| `engine/src/db.ts` | `getDatabase()` export |
| `engine/src/index.ts` | `bootstrapCrm()` call in main() |
| `engine/src/ipc.ts` | CRM IPC delegation in default case |
| `engine/container/agent-runner/src/index.ts` | CRM MCP servers + allowed tools |
| `engine/src/container-runner.ts` | CRM document store mount |

## Development

```bash
npm run dev          # Run with hot reload (tsx watch)
npm run build        # Compile TypeScript
npm run typecheck    # Type check
npm run test         # Run all tests (engine + CRM)
npm run bootstrap    # First-time CRM setup
npm run register-team # Register team from CSV/JSON
```

Container management:
```bash
npm run build:container   # Build CRM container (extends engine image)
```

Service management (Linux):
```bash
systemctl --user start agentic-crm
systemctl --user stop agentic-crm
systemctl --user restart agentic-crm
```

## Git Operations

**Pre-flight checks (run before any git push, merge, or upstream sync):**
- Run `git status` and `git branch` to confirm the working state and active branch
- Run `git remote -v` to confirm the correct remote before pushing

**Pushing:**
- Always confirm the current branch matches the intended remote branch before running `git push`
- After pushing, verify by running `git log origin/<branch> --oneline -3` and confirm the commits match
- Explicitly echo the branch name that was pushed to in the completion summary

**Upstream sync (NanoClaw engine):**
- Always confirm active branch and clean working tree before running `git subtree pull`
- After merging, verify the merge commit appears on the correct branch before pushing

## Architecture

`engine/` is a **git subtree** of [NanoClaw](https://github.com/qwibitai/nanoclaw). DO NOT modify engine files beyond the 5 documented hook points above. All CRM logic lives in `crm/`.

To pull upstream NanoClaw updates:
```bash
git subtree pull --prefix=engine https://github.com/qwibitai/nanoclaw.git main --squash
```

### Message Flow

```
WhatsApp → engine (NanoClaw) → CRM container (extends engine image)
                                    ├── Claude Agent SDK
                                    ├── CRM MCP tools (crm-tools, google-workspace, rag-search)
                                    └── CRM CLAUDE.md (persona + schema + rules)
```

## CRM Patterns

### Adding a new MCP tool
1. Add the tool handler in the appropriate MCP server (`crm/container/mcp/src/`)
2. The tool is automatically available to agents (allowed via `mcp__crm_tools__*` wildcard)

### Adding a new IPC type
1. Add the handler in `crm/src/ipc-handlers.ts`
2. It will be called by the engine's IPC watcher for unknown types

### Adding new schema tables
1. Add table definition in `crm/src/schema.ts`
2. Call creation in `crm/src/bootstrap.ts`
3. Add tests in `crm/tests/schema.test.ts`

## Testing

```bash
npm run test         # All tests
```

Tests live in:
- `engine/src/*.test.ts` — Engine tests
- `crm/tests/*.test.ts` — CRM tests
