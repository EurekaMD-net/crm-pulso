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

## Phase 2 — Reliability tightening (queued, ~6–8 h, 2 sessions)

Concrete wins, each shippable independently. Run full test suite
after each.

| Item                                                                                                                                                                   | Effort | Value                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------- |
| `CONTAINER_MEMORY` / `CONTAINER_CPUS` / `CONTAINER_PIDS_LIMIT` env vars in `engine/config.ts`, threaded through `buildContainerArgs`. Closes audit `--pids-limit` gap. | ~30 m  | Per-deploy tuning + closes audit security gap                       |
| Container heartbeat + stuck-container reaper, ported from upstream's `host-sweep.ts` pattern but adapted to fit our `group-queue.ts` model.                            | ~3–4 h | Catches "container alive but silent" — doom-loop only catches loops |
| Split `engine/index.ts` (620 LOC) into `engine/bootstrap.ts` (engine startup) + thin `engine/index.ts` (entry point), keeping CRM hooks in `crm/src/bootstrap.ts`.     | ~2 h   | Reduces max-file complexity; cleaner review surface                 |
| Trim `engine/ipc.ts` to engine-only IPC. CRM handlers already live in `crm/src/ipc-handlers.ts`.                                                                       | ~1 h   | Same as above                                                       |

Cross-reference: the resource-limits work was also filed upstream as
[qwibitai/nanoclaw#2029](https://github.com/qwibitai/nanoclaw/issues/2029).
We can ship our local version regardless of upstream response — the
issue is just signal that the gap exists in the wild.

**Risk:** medium per item, low when batched. Each item has tests
covering it; run the full suite after each.

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
