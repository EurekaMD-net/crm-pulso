# Engine Evolution Plan — 2026-04-26

> Strategic plan for `engine/` now that we've stopped pulling from
> upstream NanoClaw. Phase 1 is shipped in the same commit as this
> doc; Phases 2 and 3 are queued. Open this doc first when picking
> up engine work in a future session.

## Where we are (2026-04-26 baseline)

- **Engine subtree:** 27 src files, ~7,200 LOC. Originally subtree'd
  from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw); as
  of today it is a **permanent fork**. We deliberately stopped pulling
  because upstream moved to a v2 architecture (channel-registry,
  provider-registry, OneCLI, session-manager) that's incompatible with
  our CRM glue without a multi-week refactor.

- **CRM-touching surface:** 5 of the 27 src files (`config.ts`,
  `container-runner.ts`, `db.ts`, `index.ts`, `ipc.ts`). The other
  22 are pure-engine — historically off-limits, now fair game.

- **What works (don't disturb without an obvious win):**
  - Container model + Docker isolation per group
  - WhatsApp adapter (`channels/whatsapp.ts`, `whatsapp-auth.ts`)
  - Credential proxy (keeps API keys out of containers)
  - Event-driven IPC loop (recent perf win, commit `60f00b3`)
  - Group queue (concurrency control per group)
  - Doom-loop / circuit breakers / parseBuffer cap (audit-shipped)
  - Backup architecture (15-min PG snapshots + daily pgloader mirror)

- **Test baseline:** 1,166 tests across 64 files, all green.

## What being "ours" unlocks

The "DO NOT modify engine files beyond 7 hook points" rule is gone.
Specifically:

- Refactor `engine/index.ts` (currently 620 LOC, mixes engine startup
  - CRM bootstrap + scheduler wiring)
- Split `engine/ipc.ts` (566 LOC; CRM handlers already live in
  `crm/src/ipc-handlers.ts`, so engine-side IPC can be thin)
- Rename / move freely
- Delete vestigial upstream artifacts (Phase 1)
- Unflag the "scope drift" markers from prior audits — the parseBuffer
  cap (commit `7c8faa9`) and hardcoded `--memory 512m --cpus 1` are no
  longer drift; they're first-class fork code

## What we should NOT do

- **Adopt upstream v2 architecture** (channel-registry,
  provider-registry, OneCLI, session-manager). Would break working
  code, no business benefit since we're single-channel +
  single-provider.
- **Add a provider registry.** We have `credential-proxy`, it works.
- **Multi-channel abstraction.** We're WhatsApp-only.
- **Big-bang rewrite of `engine/index.ts` or `engine/ipc.ts`.** Splits
  OK; rewrites no.
- **Rename `engine/` directory.** Breaks every import path; cost >
  benefit.
- **`git subtree pull` from upstream.** Would force-overwrite the fork.

---

## Phase 1 — Cleanup & re-anchor (shipped 2026-04-26)

Goal: remove confusion + reset the docs to reflect the new reality.
Pure deletions of unreferenced files + doc updates. No code paths
affected. Tests stay at 1,166 by construction.

**Deletions (84 files, ~13,777 lines):**

- `engine/setup.sh` + `engine/setup/` — installer machinery; we don't
  run installs
- `engine/skills-engine/` — already excluded from vitest; no runtime
  imports
- `engine/scripts/` — upstream skill management (apply, rebase,
  uninstall, post-update, run-migrations, validate, fix-skill-drift)
- `engine/launchd/com.nanoclaw.plist` — macOS service file (we're
  Linux/systemd)
- `engine/repo-tokens/` — GitHub Action template (not in our CI)
- `engine/CONTRIBUTING.md`, `CONTRIBUTORS.md`, `README_zh.md`,
  `CHANGELOG.md` — upstream contribution machinery
- `engine/docs/` — 8 upstream architecture docs; we maintain ours at
  root `docs/`

**Kept (attribution / actively used):**

- `engine/LICENSE`, `engine/README.md`, `engine/assets/`
- `engine/container/`, `engine/groups/`, `engine/src/`,
  `engine/config-examples/`, build configs

**Doc updates:**

- `engine/CLAUDE.md` — reframed as "CRM agent runtime"; dropped
  Skills table that referenced now-deleted `/setup`, `/customize`,
  `/debug`, `/update` skills
- Root `CLAUDE.md` — replaced "git subtree of NanoClaw, DO NOT modify
  beyond 7 hook points" with current ownership reality; the hook
  table stays as a current-surface map (not a fence)
- This doc, persisted at `docs/ENGINE-EVOLUTION-2026-04-26.md`

---

## Phase 2 — Reliability tightening

Concrete wins, each shippable independently. Run full test suite
after each.

| Item                                                                                                                                                                                                                                                                                               | Status                                                                                     | Effort | Value                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------- |
| `CONTAINER_MEMORY` / `CONTAINER_CPUS` / `CONTAINER_PIDS_LIMIT` env vars in `engine/config.ts`, threaded through `buildContainerArgs`. Closes audit `--pids-limit` gap.                                                                                                                             | **Shipped 2026-04-26** (Phase 2a)                                                          | ~1 h   | Per-deploy tuning + closes audit security gap                        |
| Trim `engine/ipc.ts` to engine-only IPC. CRM handlers already live in `crm/src/ipc-handlers.ts`.                                                                                                                                                                                                   | **N/A** — verified already partitioned (only the default-case CRM delegation at line 546). | —      | Was a false-positive guess from Phase 1 inventory                    |
| Extract bootstrap sequence from `engine/src/index.ts:main()` into `engine/src/bootstrap.ts`. Original plan called for a "thin index.ts" via dramatic split; revised to minimal extraction after closer reading.                                                                                    | **Shipped 2026-04-26** (Phase 2b)                                                          | ~1 h   | Clear semantic boundary (subsystem startup vs orchestration)         |
| Operator visibility into active containers — periodic log (5 min) + localhost-only dashboard endpoint. Original plan called for a full heartbeat reaper; revised to Option B after closer reading showed our existing `IDLE_TIMEOUT + reset-on-stream-output` already acts as effective heartbeat. | **Shipped 2026-04-26** (Phase 2c — Option B)                                               | ~1 h   | Catches "alive but silent" via operator inspection (rare wedge case) |

### Phase 2a — what shipped

- Three env vars in `engine/src/config.ts` (`CONTAINER_MEMORY`,
  `CONTAINER_CPUS`, `CONTAINER_PIDS_LIMIT`) with defaults
  `'512m'`/`'1'`/`'256'` matching the previously hardcoded values
  plus the new `--pids-limit` flag.
- `trimEnv()` helper to fall back to defaults for empty/whitespace
  env values (audit-caught: `process.env.X = ''` would otherwise
  push `--memory ''` and break docker spawn).
- Setting any var to `'0'` skips the corresponding flag entirely
  (Docker convention for `--memory` and `--pids-limit`; uniform
  behavior for `--cpus` since `--cpus 0` is rejected by Docker).
- 7 new tests: 6 in `engine/src/config.test.ts` covering the env
  matrix (unset, empty, whitespace, `'0'`, custom, trimmed-custom)
  - 1 in `engine/src/container-runner.test.ts` asserting the three
    flags appear in `spawn` args with the configured values.
- Cross-ref: filed upstream as
  [qwibitai/nanoclaw#2029](https://github.com/qwibitai/nanoclaw/issues/2029).
  Our local version shipped regardless of upstream response.
- Deferred from audit (low value):
  - Strict regex validation of values (audit-suggested `/^\d+(\.\d+)?[bkmg]?$/i` for memory etc.) — docker's own error on first spawn is sufficient signal; adding parser duplicates docker's validation.
  - Test that `'0'` escape hatch omits the flag at the spawn-args layer — covered by inspection at `container-runner.ts:298` (six lines of obvious conditionals); re-mocking config per-test would test the mock plumbing more than production code.

### Phase 2b — what shipped

- New `engine/src/bootstrap.ts` (~85 LOC) exporting
  `bootstrapEngine(): Promise<{ proxyServer }>`. Owns the boot sequence
  (container runtime + DB + CRM bootstrap + scheduler + briefings +
  dashboard + credential proxy) in the same load-bearing order as
  before, with the same `try/catch` fail-fast around `bootstrapCrm`.
- `engine/src/index.ts` `main()` collapsed lines 519-535 to one
  `const { proxyServer } = await bootstrapEngine();`. Removed the
  internal `ensureContainerSystemRunning` helper (now lives in
  bootstrap.ts) and dropped 11 imports that became unused after the
  extraction (`bootstrapCrm`, `seedBriefings`, `startScheduler`,
  `startDashboardServer`, `startCredentialProxy`, `cleanupOrphans`,
  `ensureContainerRuntimeRunning`, `initDatabase`, `PROXY_BIND_HOST`,
  `DATA_DIR`, `CREDENTIAL_PROXY_PORT`). `stopScheduler` retained — the
  shutdown handler still calls it.
- New `engine/src/bootstrap.test.ts` (2 tests):
  - "calls subsystems in the expected order and returns proxyServer" —
    asserts `invocationCallOrder` to pin the load-bearing ordering
  - "exits process when bootstrapCrm throws (fail-fast contract)" —
    asserts downstream subsystems do NOT fire when CRM bootstrap fails
- **Scope was smaller than the original plan implied.** The plan
  called for "thin index.ts via dramatic split." Closer reading
  showed index.ts is well-organized (state at top, helpers grouped,
  main(), entry guard); a bigger split would require passing module
  state across files (worse than current). The valuable extraction
  was just the boot sequence — clear semantic boundary, no shared
  mutable state, 25-line reduction in index.ts.

### Phase 2c — what shipped (Option B, observability-only)

The original Phase 2c plan called for a full container heartbeat
reaper ported from upstream's `host-sweep.ts`. On closer reading
(documented in the session log) this turned out to be the wrong
shape:

- Our existing `IDLE_TIMEOUT + reset-on-stream-output` at
  `engine/src/container-runner.ts:537-562` already acts as effective
  heartbeat: each chunk of streaming output resets a 30-min hard-kill
  timer.
- The actual gap is _operator visibility_ for the rare case where a
  container wedges before triggering the timer (e.g. silent lock-up
  mid-tool-call).
- Full reaper port would add agent-runner-internal heartbeat writes
  - a host-side sweep loop + group-queue integration — multi-file,
    container rebuild, real risk surface.
- Marginal value over the existing safety net: ~5 min vs ~30 min
  recovery on the rare wedge.

So we shipped Option B (observability-only):

- **`engine/src/group-queue.ts`** — added `startedAt: number | null`
  to `GroupState`. Set in `registerProcess()`, cleared in both
  `runForGroup` and `runTask` finally blocks. New
  `getActiveContainers(): ActiveContainerInfo[]` filters
  `state.process !== null` and returns `{groupJid, containerName,
groupFolder, startedAt, ageMs, idleWaiting, isTaskContainer}`.
- **`engine/src/container-stats-logger.ts`** (NEW, ~50 LOC) — periodic
  `logger.info({...}, 'container active')` every 5 min while at least
  one container runs. Empty list logs nothing. Wrapped in try/catch
  so a transient throw can't tear down the timer thread.
- **`engine/src/bootstrap.ts`** — `bootstrapEngine()` now accepts
  `BootstrapOptions = { getActiveContainers? }` and threads it to
  `startDashboardServer(undefined, { getActiveContainers })`.
- **`engine/src/index.ts`** — `main()` passes
  `() => queue.getActiveContainers()` as the getter; calls
  `startContainerStatsLogger(queue)` and tears down in shutdown.
- **`crm/src/dashboard/server.ts`** — new
  `GET /api/v1/containers/active` route, **localhost-only** (mirrors
  `/api/v1/token` pattern). Returns `{containers: [...]}` if a getter
  is wired, `503` otherwise. Verified post-deploy that public-IP
  access returns `403` while loopback returns the snapshot.

Tests: 1175 → 1183 (+8). 4 in `group-queue.test.ts` (empty/single/
multi/cleared-after-task), 3 in `container-stats-logger.test.ts`
(intervals/empty-quiet/teardown), 1 in `bootstrap.test.ts` (opts
threading).

If wedged-container frequency turns out to be a real production pain
point in the next few months (operator can grep journalctl for
`"container active"` lines with high `ageSec` + `idleWaiting=false`),
escalate to Option C (full heartbeat reaper) with concrete data.

---

## Phase 3 — CRM-driven evolution (open-ended)

Driven by features that hit walls. Don't pre-build. Likely candidates
based on current pain points:

- **Per-group resource quotas** — a noisy group container can't starve
  siblings (extension of Phase 2 limits)
- **Per-container observability** — container-level metrics (CPU,
  mem, fd count) into the dashboard alongside the budget ledger
- **Streaming responses end-to-end** — currently SSE inside the engine
  but agent → user is buffered
- **Image / voice pipeline improvements** — only when a CRM feature
  requires it

---

## Sequencing recommendation

1. **Phase 1 first** (DONE, this commit) — cleanup is immediate,
   low-risk, makes Phase 2 less confusing
2. **Phase 2 second** — pick items individually based on which
   reliability gap bites hardest. Likely order: env-var resource
   limits → `engine/index.ts` split → heartbeat reaper.
3. **Phase 3 third** — pull-driven, not push-driven.

## How to monitor upstream from now on

We're not pulling, but cherry-picking the occasional small security
fix is fine. Process:

1. Once a month, `git clone --depth 50 https://github.com/qwibitai/nanoclaw.git /tmp/nanoclaw`
2. Skim recent commits for `fix(security)` / `fix(*-injection)` /
   `fix(*-traversal)` patterns
3. Manually port only the ones where:
   - The vulnerable code path exists in our fork (most don't), AND
   - The patch is small enough to port without conflict
4. Reference the upstream commit hash in the port commit message
   (e.g. `port: upstream qwibitai/nanoclaw fd03b89 — ...`)

Anything bigger than a single-file fix isn't worth the merge
overhead — see "What we should NOT do" above.
