# Engine — CRM Agent Runtime

The agent runtime that the CRM is built on. Originally subtree'd from
[qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw); as of
2026-04-26 this is a permanent fork — no more `git subtree pull` from
upstream. Treat every file under `engine/` as ours to refactor.

## Quick Context

Single Node.js process (managed by systemd as `agentic-crm`) that
connects to WhatsApp, routes messages to a Claude Agent SDK running
in per-group Docker containers (Linux VMs). Each group has isolated
filesystem and memory.

## Key Files

| File                            | Purpose                                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                  | Orchestrator: state, message loop wiring, agent invocation. Boot sequence moved to `src/bootstrap.ts`.                                                          |
| `src/bootstrap.ts`              | Engine boot sequence: container runtime + DB + CRM bootstrap + scheduler + dashboard + credential proxy. Returns long-lived handles.                            |
| `src/container-stats-logger.ts` | Phase 2c — periodic log of active containers (every 5 min) for operator visibility. `GET /api/v1/containers/active` (localhost-only) exposes the same snapshot. |
| `src/channels/whatsapp.ts`      | WhatsApp connection, auth, send/receive                                                                                                                         |
| `src/ipc.ts`                    | IPC watcher; CRM IPC delegation in default case                                                                                                                 |
| `src/router.ts`                 | Message formatting and outbound routing                                                                                                                         |
| `src/config.ts`                 | Trigger pattern, paths, intervals, MX timezone, credential proxy                                                                                                |
| `src/container-runner.ts`       | Spawns agent containers with mounts + resource limits (`CONTAINER_MEMORY`/`CPUS`/`PIDS_LIMIT` env vars, defaults 512m/1/256)                                    |
| `src/container-runtime.ts`      | Container runtime detection + host gateway args                                                                                                                 |
| `src/task-scheduler.ts`         | Runs scheduled tasks (warmth, alerts, overnight, etc.)                                                                                                          |
| `src/db.ts`                     | Engine SQLite operations + `getDatabase()` export for CRM                                                                                                       |
| `src/credential-proxy.ts`       | Keeps Anthropic API keys out of agent containers                                                                                                                |
| `src/mount-security.ts`         | Validates additional mounts against `~/.config/nanoclaw/mount-allowlist.json`                                                                                   |
| `src/group-queue.ts`            | Per-group concurrency control                                                                                                                                   |
| `src/whatsapp-auth.ts`          | WhatsApp pairing + session storage                                                                                                                              |
| `groups/{name}/CLAUDE.md`       | Per-group memory (isolated)                                                                                                                                     |
| `container/skills/...`          | Container-side skills bundled into the agent image                                                                                                              |

## CRM Integration Surface

The CRM hooks into the engine at these points (no longer a "do not
touch beyond these" constraint — just a current map):

| File                                  | CRM Hook                                                              |
| ------------------------------------- | --------------------------------------------------------------------- |
| `src/db.ts`                           | `getDatabase()` shared with CRM                                       |
| `src/index.ts`                        | `bootstrapCrm()` + schedulers + `startDashboardServer()` + cred proxy |
| `src/ipc.ts`                          | CRM IPC delegation for unknown task types                             |
| `src/container-runner.ts`             | CRM document store mount + credential proxy env vars                  |
| `src/container-runtime.ts`            | `PROXY_BIND_HOST` + `hostGatewayArgs()`                               |
| `src/config.ts`                       | `CREDENTIAL_PROXY_PORT` + `America/Mexico_City` timezone default      |
| `container/agent-runner/src/index.ts` | Allowed tools list                                                    |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload (tsx watch)
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management (Linux only — we don't run macOS):

```bash
crm-ctl restart      # canonical restart wrapper
systemctl status agentic-crm
journalctl -u agentic-crm -f
```

## Container Build Cache

The container buildkit caches the build context aggressively.
`--no-cache` alone does NOT invalidate COPY steps — the builder's
volume retains stale files. To force a truly clean rebuild, prune
the builder then re-run `./container/build.sh` (or
`npm run build:container` from the repo root).

## Evolution Plan

See `docs/ENGINE-EVOLUTION-2026-04-26.md` (root `docs/`) for the
3-phase plan (Phase 1 = this cleanup; Phase 2 = reliability
tightening; Phase 3 = CRM-driven evolution).
