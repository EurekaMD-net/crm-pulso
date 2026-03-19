# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Quick Context

Agentic CRM for media ad sales. NanoClaw engine at `engine/`, all CRM code at `crm/`. Salespeople chat with AI agents via WhatsApp. Each group has an isolated agent with role-appropriate CRM access.

## Key Files

| File | Purpose |
|------|---------|
| `crm/src/bootstrap.ts` | CRM init: creates schema, registers hooks |
| `crm/src/schema.ts` | 27 CRM tables (15 core + crm_events + docs/embeddings/vec/fts + crm_memories + 3 relationship tables + aprobacion_registro + insight_comercial + patron_detectado + feedback_propuesta + perfil_usuario + template_score) |
| `crm/src/hierarchy.ts` | isManagerOf, isDirectorOf, isVp helpers |
| `crm/src/ipc-handlers.ts` | CRM IPC handler (crm_registrar_actividad, warmth_recompute, etc.) |
| `crm/src/doc-sync.ts` | Document sync + hybrid RAG (vector KNN + FTS5 keyword + RRF fusion) |
| `crm/src/circuit-breaker.ts` | Reusable circuit breaker (inference, embedding, Hindsight) |
| `crm/src/warmth.ts` | Executive relationship warmth scoring (recency + frequency + quality) |
| `crm/src/warmth-scheduler.ts` | Nightly warmth recomputation (4 AM MX via IPC) |
| `crm/src/memory/` | Pluggable memory service (Hindsight sidecar or SQLite fallback) |
| `crm/src/tools/index.ts` | Tool registry: 69 tools, role-based filtering |
| `crm/src/tools/perfil.ts` | User profile tool (actualizar_perfil + getUserProfile + formatProfileSection) |
| `crm/src/package-builder.ts` | Creative package composition (historical mix, peers, inventory, rate cards) |
| `crm/src/tools/package-tools.ts` | 3 package tools (construir_paquete, consultar_oportunidades_inventario, comparar_paquetes) |
| `crm/src/tools/aprobaciones.ts` | 6 approval workflow tools (solicitar, aprobar, rechazar, impugnar, pendientes) |
| `crm/src/tools/insight-tools.ts` | 5 insight/draft tools (consultar_insights, actuar_insight, consultar_insights_equipo, revisar_borrador, modificar_borrador) |
| `crm/src/overnight-engine.ts` | 5 overnight analyzers + cross-agent pattern detection |
| `crm/src/proposal-drafter.ts` | Insight → borrador_agente propuesta (value/media derivation) |
| `crm/src/cross-intelligence.ts` | 5 cross-agent pattern detectors (vertical, holding, inventory, winloss, concentration) |
| `crm/src/feedback-engine.ts` | Draft-vs-final delta tracking for system learning |
| `crm/src/analysis/` | Shared analysis modules (peer-comparison.ts, media-mix.ts) |
| `crm/src/tools/relaciones.ts` | 7 Dir/VP relationship tools (warmth, milestones, interactions) |
| `crm/src/tools/memoria.ts` | 3 memory tools (guardar, buscar, reflexionar) |
| `crm/src/tools/drive.ts` | Drive tools: list, read, create docs/sheets/slides with content |
| `crm/src/workspace/` | WorkspaceProvider interface + Google implementation (mail, files, calendar) |
| `crm/src/google-auth.ts` | Re-export shim for workspace/google/auth.ts (backward compat) |
| `crm/src/dashboard/server.ts` | Dashboard HTTP server + router (7 API endpoints) |
| `crm/groups/global.md` | Global CLAUDE.md template (schema, queries, rules, scope guard, disambiguation) |
| `crm/groups/ae.md` | AE persona template (50 tools) |
| `crm/groups/manager.md` | Manager persona template (53 tools) |
| `crm/groups/director.md` | Director persona template (62 tools, incl. 7 relationship + 4 email) |
| `crm/groups/vp.md` | VP persona template (60 tools, incl. 7 relationship + 4 email) |

### Engine Hook Points (DO NOT modify beyond these 7 files)

| File | Change |
|------|--------|
| `engine/src/db.ts` | `getDatabase()` export |
| `engine/src/index.ts` | `bootstrapCrm()` + schedulers + `startDashboardServer()` + credential proxy |
| `engine/src/ipc.ts` | CRM IPC delegation in default case |
| `engine/container/agent-runner/src/index.ts` | Allowed tools |
| `engine/src/container-runner.ts` | CRM document store mount + credential proxy env vars |
| `engine/src/container-runtime.ts` | `PROXY_BIND_HOST` + `hostGatewayArgs()` + `CONTAINER_HOST_GATEWAY` |
| `engine/src/config.ts` | `CREDENTIAL_PROXY_PORT` + `America/Mexico_City` timezone default |

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
WhatsApp → engine (NanoClaw) → Direct tools (65 CRM tools via inference adapter)
                                    ├── Role-based tool filtering (AE:50, Ger:53, Dir:62, VP:60)
                                    ├── Google Workspace (Gmail, Drive, Calendar)
                                    ├── Hybrid RAG (vector + FTS5 keyword + RRF fusion)
                                    ├── Long-term memory (Hindsight or SQLite fallback)
                                    ├── Relationship intelligence (Dir/VP: warmth, milestones)
                                    └── CRM CLAUDE.md (persona + schema + rules + date/time)
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
npm run test         # All tests (783 CRM + 640 engine)
```

Tests live in:
- `engine/src/*.test.ts` — Engine tests
- `crm/tests/*.test.ts` — CRM tests (33 test files)

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
