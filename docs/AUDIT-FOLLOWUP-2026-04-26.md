# Audit Follow-up — 2026-04-26 (post-batch review)

> Updated 2026-04-26 part 3: §2 security batch (B1, B2, B4 + A5)
> landed as a single commit. B3 (PG `~/.pgpass`) split out per user
> request. Remaining queue: B3, A1+A2 docstrings, A3 overnight test,
> S1 doom test.
>
> Source-of-truth audit: `docs/AUDIT-2026-04-26.md` (120 findings, 5
> batches). The audit-of-fixes review (Part A) and §2 design notes
> (Part B) are below.

## What landed today

| Commit    | Audit § | Summary                                                                       |
| --------- | ------- | ----------------------------------------------------------------------------- |
| `34411c0` | §5      | `getCurrentWeek` (6 divergent copies) + `dateCutoff` unified                  |
| `6703f85` | §4      | `Promise.allSettled`, overnight `errors[]`, SSE log, budget                   |
| `7c8faa9` | §1      | doom-loop LRU, providerBreakers cap, parseBuffer cap                          |
| `c0bd6f9` | §3      | bulk entity resolve, two composite indexes (one COVERING)                     |
| `6afe88d` | §6      | doom thresholds 3→2, immediate escalation, `validateEnv()`                    |
| `1e4ba9a` | docs    | this followup doc                                                             |
| _new_     | §2      | **B1 + B2 + B4 + A5** — aprobaciones allowlist, Drive escape, SSRF, JWT floor |

Test count: 1130 → 1153 (B1+B2+B4+A5 initial 23) → 1164 (post-audit 11
SSRF bypass-pinning sweep). All green. Container rebuilt + restarted
clean after each batch.

### Wiring gap discovered while deploying §2 batch

`NODE_ENV` is **not set** on the running `agentic-crm` systemd unit
(`/proc/<pid>/environ` shows only `TZ=America/Mexico_City`). The new
B4 SSRF + A5 JWT-length checks gate on `NODE_ENV === "production"`,
so they currently no-op in prod. Two paths forward:

1. Add `Environment=NODE_ENV=production` to
   `/etc/systemd/system/agentic-crm.service`. One line, one restart.
2. Drop the `NODE_ENV` gate and key the checks off something else
   (e.g. presence of `DASHBOARD_JWT_SECRET`, since dev rarely sets it).

Recommend (1) — it's the standard Node convention and makes other
production-only paths (logging, error handling) behave correctly too.
Defer to next session — touching the systemd unit is its own risk
window and shouldn't piggyback on a code change.

---

## Part A — Audit of the audit fixes

Critical re-read. Things I'd want a reviewer to push back on.

### Real concerns (worth a follow-up commit)

**A1. `getCurrentWeek` semantic drift.** The helper docstring at
`crm/src/tools/helpers.ts:6` still says "ISO week number" but the impl
uses US Sunday-week math `(dayOfYear + startDay + 1) / 7`. For
2026-04-26 (Sunday) that returns 18; ISO would return 17. The bug was
always this — I just unified everyone on the wrong convention. Either
fix the impl to ISO or fix the docstring + update LEARNINGS-2026-04-26
§5 to say "US-week" not "ISO week."

**A2. `dateCutoff` is now coarser.** Switched from second-precision
UTC to MX-day-precision (`YYYY-MM-DD`). `seedSentiment` had to move
8d → 9d back to survive. That's fine for tests, but it's a real
semantic shift: `dateCutoff(7)` now means "rows from the start of MX
day 7 days ago" (up to 7d 23h), not "exactly 7×86400000 ms ago." All
current callers use `>=` semantics so direction is right. A future
caller using `<` would silently invert. Add a JSDoc note.

**A3. Overnight `errors[]` field has no test.** Added the field, made
the IPC return false when populated, but no test covers
_(analyzer crash → errors populated → IPC returns false)_. The change
is mechanical but the contract is untested. ~15 min to add.

**A4. `engine/src/container-runner.ts` parseBuffer cap is outside
documented hook scope.** Project CLAUDE.md says container-runner.ts
is allowed for "CRM document store mount + credential proxy env vars"
only. The parseBuffer cap is neither. Next `git subtree pull` from
NanoClaw will probably conflict. Audit said do it; I did; but flag in
LEARNINGS that engine-divergence surface widened.

**A5. `validateEnv` was the easy half of the JWT fix.** It asserts
`DASHBOARD_JWT_SECRET` is _set_ in production but doesn't check the
value. Original incident (commit `4eee0e3`) was about a _random
fallback_ being silently minted. My validation catches missing-var
but not `DASHBOARD_JWT_SECRET=changeme`. Add a 32-char minimum-length
floor (matches the `openssl rand -hex 32` recommendation in
`.env.example`).

### Skipped against the spec

**S1. Audit §7 Batch 5 said "add a test that asserts escalation by
call N=2 not N=3."** I lowered the threshold but didn't add the
test. Integration test at `crm/tests/doom-loop.test.ts:217` loops up
to 5 rounds without checking _which_ round triggered. Trivial.

**S2. Audit §3 schema gap "(`cuenta_id, semana, año`) on `descarga`"
was a false positive.** That index already exists at
`crm/src/schema.ts:149` (`idx_descarga_cuenta_semana`). Not adding a
duplicate. Worth noting in LEARNINGS so future audits don't re-flag.

### Things that survived but I'd want a second look on

**O1. `Promise.allSettled` mapping uses non-null assertion.**
`response.tool_calls![i]` works because the early-return guarantees
non-null, but the assertion is brittle to refactors of the early
return. Capture `const calls = response.tool_calls!;` once before the
`.map` for safety.

**O2. `resolveAlertEntities` IN-list has no chunking.** SQLite
`SQLITE_LIMIT_VARIABLE_NUMBER` default is 999. Current callers pass
max 50. A future caller passing 1000+ silently breaks. Cheap to chunk
in groups of 500.

**O3. doom-loop LRU "touch on hit" conflates frequency and recency.**
A key hit 2× and one hit 100× both move to the tail equally. Doesn't
matter for current detection logic (count threshold doesn't care
about insertion order) but worth noting in case detection logic
changes.

---

## Part B — §2 security (deferred items, fix proposals)

Audit §2 had 4 CRITICAL items I deferred because they need design
calls, not patches. Each is small in code; the design calls are what
made them deferral-worthy.

### B1. Aprobaciones table-name interpolation

**Suspected pattern:** `db.prepare(\`SELECT \* FROM ${table} WHERE id =
?\`).get(id)`somewhere in`crm/src/tools/aprobaciones.ts`, where
`table`derives (transitively) from a tool argument like`entidad_tipo: 'propuesta' | 'descarga' | …`.

**Why parameters can't fix it:** SQLite doesn't bind table or column
names — only values. Allowlisting is the only safe pattern.

**Fix:**

```ts
const APPROVAL_TABLES = {
  propuesta: "propuesta",
  descarga: "descarga",
  // ... full list from union type
} as const;
const table = APPROVAL_TABLES[args.entidad_tipo];
if (!table) throw new Error("invalid entidad_tipo");
```

**Effort:** 30 min including a regression test.
**Risk:** low.
**Severity:** CRITICAL — if reachable from tool input, SQL execution.
**Recommendation:** do first.

### B2. Drive query injection

**Pattern:** `q: \`name contains '${userInput}'\``against Google
Drive Files API in`crm/src/tools/drive.ts`. Drive's query syntax
uses `'`as string delimiter; an attacker types`'; trashed = false
or '` and broadens scope.

**Fix:** escape single quotes (`\\'`) and backslashes per Drive
syntax. One helper, applied at every Drive query construction site.

**Catch:** must _escape_, not _reject_. Mexican account names like
`O'Brien` are valid input. Add a regression test for apostrophe names
specifically.

**Effort:** 1 h with tests.
**Risk:** low.
**Severity:** CRITICAL but bounded — attacker can only see more drive
files than they should within the _same_ OAuth scope. No
cross-tenant.
**Recommendation:** do second.

### B3. PG password env-var → `/proc/<pid>/environ`

**Reality:** `/etc/crm-backup.env` ships `PG_PASSWORD=...` (mode 600,
fine on disk). The backup/mirror scripts source it into `PGPASSWORD`,
which is readable via `/proc/<pid>/environ` by any process running
as the same user (or root) — including anything the agent itself
spawns.

**Standard fixes, in order of preference:**

- **`~/.pgpass`** (mode 600). `psql`/`pg_dump`/`pgloader` read it
  automatically. No env var. Cleanest. _Recommended._
- **`PGPASSFILE=/etc/crm-pgpass`** with mode 600 — keeps credential
  out of `$HOME` if that matters.
- **Peer auth** (Unix socket + matching OS user). Best but doesn't
  apply to Supabase-in-Docker which talks TCP.

**Scope:** the exposure window is the cron-driven backup/mirror
processes, not the long-running agent (which already keeps PG creds
out of its env). So the fix only touches `crm-backup`, `crm-restore`,
`crm-mirror`, and `/etc/crm-backup.env`.

**Effort:** ~1 h including walking through `crm-backup` →
`crm-backup-list` → `crm-restore` → `crm-mirror` to verify each
honors `~/.pgpass`.
**Risk:** medium (touches ops scripts that auto-fire every 15 min).
Test by running each command manually before relying on the timer.
**Severity:** HIGH (audit headline #5). Real but bounded.
**Recommendation:** do third.

### B4. `INFERENCE_PRIMARY_URL` SSRF

**Threat model:** if env-var write is compromised, attacker repoints
inference URL at `http://169.254.169.254/latest/meta-data/...` (cloud
metadata), `http://localhost:5433/` (local PG over HTTP probe), or
`http://localhost:8100/` (Supabase Kong) and reads sensitive
responses back through the inference stream.

**Honest take:** if env-var write is compromised, the attacker also
has `DASHBOARD_JWT_SECRET`, the Supabase admin password (per B3),
and the cloud metadata directly. SSRF defense here is
defense-in-depth, not primary mitigation.

**Cheap hardening that's still worth it** — slot into the new
`validateEnv()` from Batch 5:

- Allowlist hostnames at process start (the providers we actually
  use: `siliconflow.cn`, `bigmodel.cn`, etc.).
- Reject `127.0.0.0/8`, `10.0.0.0/8`, `169.254.0.0/16`,
  `172.16.0.0/12`, `192.168.0.0/16` at fetch time.
- Require `https://`.

**Effort:** 30 min.
**Risk:** low — `validateEnv()` already runs at bootstrap so this is
additive.
**Severity:** HIGH (audit headline #6).
**Recommendation:** do fourth (same effort as B1, but smaller blast
radius).

---

## Suggested next-session order

**Done in part 3** (single commit): ~~B1, B2, B4, A5~~. SSRF guard came
out fatter than spec — also rejects integer/hex IPs, IPv6 loopback +
link-local + unique-local + IPv4-mapped IPv6. Bypass-pinning sweep (11
extra tests) lives in `bootstrap.test.ts`.

**Remaining queue:**

1. **NODE_ENV wiring** — `Environment=NODE_ENV=production` in the
   systemd unit. Without this, B4/A5 are no-ops in prod. ~5 min + restart.
2. **B3** PG `~/.pgpass` migration for backup scripts (split from §2
   batch per user — touches systemd timer, separate run). ~1 h.
3. **A1 + A2** docstring fixes for `getCurrentWeek` + `dateCutoff`. ~10 min.
4. **A3** add overnight `errors[]` test. ~15 min.
5. **S1** add doom-loop N=2 escalation test. ~15 min.

Total ~2 h to fully close the audit + audit-of-audit backlog.

After that, only `BUDGET_ENFORCE` default flip remains (explicitly
flagged "discuss before flipping" in audit §7, not in this list).

## Cross-cuts to remember

- All §1-§6 commits + the §2 batch are now pushed to `origin/main`.
- After any §2 fix, write a `LEARNINGS-2026-MM-DD.md` entry on the
  underlying anti-pattern (interpolated table names, query-string
  escaping, env-var credentials) so the next audit doesn't surface
  re-drifted versions of the same.
