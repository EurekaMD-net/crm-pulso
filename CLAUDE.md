# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Quick Context

Agentic CRM for media ad sales. NanoClaw engine at `engine/`, all CRM code at `crm/`. Salespeople chat with AI agents via WhatsApp. Each group has an isolated agent with role-appropriate CRM access.

## Key Files

| File | Purpose |
|------|---------|
| `crm/src/bootstrap.ts` | CRM init: creates schema, registers hooks |
| `crm/src/schema.ts` | 16 CRM tables (12 core + crm_events + crm_documents + crm_embeddings + crm_vec_embeddings) |
| `crm/src/hierarchy.ts` | isManagerOf, isDirectorOf, isVp helpers |
| `crm/src/ipc-handlers.ts` | CRM IPC handler (crm_registrar_actividad, etc.) |
| `crm/src/doc-sync.ts` | Document sync + RAG pipeline (chunk, embed, search) |
| `crm/src/register.ts` | Batch hierarchy registration (CSV/JSON) |
| `crm/src/escalation.ts` | Real-time escalation (quota, coaching, pattern, systemic) |
| `crm/src/alerts.ts` | Alert evaluators (6 types + event countdown) |
| `crm/src/google-auth.ts` | Google Workspace JWT auth (Gmail, Drive, Calendar) |
| `crm/src/tools/index.ts` | Tool registry: 33 tools, role-based filtering |
| `crm/src/dashboard/server.ts` | Dashboard HTTP server + router (6 API endpoints) |
| `crm/src/dashboard/auth.ts` | Dashboard JWT auth (HMAC-SHA256, no external deps) |
| `crm/src/dashboard/api.ts` | Dashboard API handlers (reuses scopeFilter pattern) |
| `crm/groups/global.md` | Global CLAUDE.md template (schema, queries, rules) |
| `crm/groups/ae.md` | AE persona template (30 tools) |
| `crm/groups/manager.md` | Manager persona template (23 tools) |

### Engine Hook Points (DO NOT modify beyond these 5 files)

| File | Change |
|------|--------|
| `engine/src/db.ts` | `getDatabase()` export |
| `engine/src/index.ts` | `bootstrapCrm()` + schedulers + `startDashboardServer()` |
| `engine/src/ipc.ts` | CRM IPC delegation in default case |
| `engine/container/agent-runner/src/index.ts` | Allowed tools |
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
WhatsApp → engine (NanoClaw) → Direct tools (29 CRM tools via inference adapter)
                                    ├── Role-based tool filtering
                                    ├── Google Workspace (Gmail, Drive, Calendar)
                                    ├── RAG search (buscar_documentos)
                                    └── CRM CLAUDE.md (persona + schema + rules)
```

## CRM Patterns

### Adding a new tool
1. Create handler in `crm/src/tools/<module>.ts`
2. Add TOOL_* definition + role sets + handler in `crm/src/tools/index.ts`
3. Update role templates in `crm/groups/*.md`
4. Update tool count tests in `agent-runner.test.ts` and `templates.test.ts`

### Adding a new IPC type
1. Add the handler in `crm/src/ipc-handlers.ts`
2. It will be called by the engine's IPC watcher for unknown types

### Adding new schema tables
1. Add table definition in `crm/src/schema.ts`
2. Update CRM_TABLES array
3. Add tests in `crm/tests/schema.test.ts`

## Testing

```bash
npm run test         # All tests (505 CRM tests)
```

Tests live in:
- `engine/src/*.test.ts` — Engine tests
- `crm/tests/*.test.ts` — CRM tests (22 test files)

## Service Operations
- Always kill ALL `tsx.*engine` processes before starting fresh.
- Always rebuild container with `--no-cache` when source files change.
- After persona/config change, restart engine AND clear session history.
- `crm-ctl` at `/usr/local/bin/crm-ctl` is the canonical way to manage the service.
- Check systemd status BEFORE using pgrep (systemd-spawned processes also match).

## Terminology Protocol
When renaming any user-facing term, always update all 4 layers:
1. Template files (e.g., `crm/groups/*.md`)
2. Live generated files (e.g., `groups/*/CLAUDE.md`)
3. Source code: tool descriptions, response JSON keys, seed data, UI labels
4. Session history files: PURGE (delete), do not edit — LLM mimics its own prior messages

## Model-Specific Guards
- **Qwen 3.5**: `enable_thinking: false` only for `qwen3*` models. MiniMax rejects it → HTTP 400.
- **Qwen 3.5**: Text-only. No `image_url` content blocks. Vision requires a VL model.
- **Qwen 3.5**: Returns `content: null` with `tool_calls`. Generate acknowledgments locally (pre-written phrases, zero LLM tokens).
