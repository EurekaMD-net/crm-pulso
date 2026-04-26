# Learnings — 2026-04-26 Cost Ledger Bug Chain

A single user question — _"how much headroom and token usage is fired
upon the agent on each call?"_ — surfaced six bugs stacked behind a
silent symptom: the `cost_ledger` table had been recording `0` tokens
and `$0` cost for every one of 22 inference calls over a week. None
of them generalized to "we wrote bad code" — they generalized to
recurring failure modes worth naming.

For the commit-by-commit details: `53f42da`, `a923eff`, `a38b228`.

## 1. The OpenAI streaming usage chunk is not a delta

OpenAI-compatible providers, when asked for usage stats via
`stream_options.include_usage: true`, send a _separate_ final SSE chunk
that looks like:

```json
{ "choices": [], "usage": { "prompt_tokens": 42, ... } }
```

Empty `choices` array, no `delta`. Our parser had:

```ts
const delta = chunk.choices?.[0]?.delta;
if (!delta) continue; // <-- skipped the usage chunk
// ...
if (chunk.usage) usage = chunk.usage; // never reached
```

So `usage` stayed at its `{0,0,0}` initial value forever. Cost ledger
recorded zeros for a month. Budget tracking was effectively blind.

**Rule:** When parsing OpenAI-compatible SSE, treat `usage` as a
chunk-level field that is independent of `choices/delta`. Capture it
_before_ any early-return guard that depends on `delta` being present.

**Anti-pattern:** Assuming spec'd metadata always rides on the same
shape as the content stream. Read the actual final-chunk shape from
the provider before writing the parser.

## 2. A single-writer for a multi-call architecture is a silent gap

`recordCost` only existed inside `inferWithTools`. But `infer()` had
_three_ direct callers: `inferWithTools`, `sentiment.ts`, and
`analysis/map-reduce-summarizer.ts`. The latter two ran on every
WhatsApp message (sentiment) and every overnight batch (summarizer)
and were completely invisible to the ledger. Even _if_ the SSE bug
hadn't existed, monthly spend would have been off by a meaningful
fraction with no error or log to indicate why.

**Rule:** Cross-cutting concerns — billing, metrics, audit logging —
belong on the _innermost_ function that does the work, not on a
high-level orchestration wrapper. Otherwise every new caller is a
silent gap.

We moved `recordCost` into `infer()` itself. Per-round attribution is
now finer-grained (one row per HTTP call instead of one per agent
turn) and impossible for new callers to bypass.

## 3. Write-only metrics are worse than no metrics

`getThreeWindowStatus`, `getDailySpend`, `getHourlySpend`, and
`getMonthlySpend` had been defined since the resilience port — and
never called from anywhere. No dashboard tile, no `/api/v1/budget`
endpoint, no enforcement guard. Even after the SSE fix, nothing in
the system would have _read_ the captured spend. We were collecting
data nobody looked at, and assuming we had cost control because the
table existed.

**Rule:** A metric without a consumer is technical debt that _feels_
like coverage. Ship the writer and at least one reader (dashboard,
alert, or guard) in the same change. Otherwise either delete the
writer or accept that you're keeping a journal nobody reads.

We added `GET /api/v1/budget` (visible in dashboard) and a hard
monthly-budget guard at the top of `infer()` that throws before any
HTTP call goes out (`BUDGET_ENFORCE=0` to disable for incident
response).

## 4. Per-round caps must respect the compression threshold

`INFERENCE_TOKEN_BUDGET` defaulted to **25000** while the context
compressor doesn't fire until **80000** (= 0.8 × `INFERENCE_CONTEXT_LIMIT`).
That meant a typical first turn (CRM persona + 71 tool defs + history
≈ 26k input tokens) tripped the per-round cap on round 0 _before_ the
compressor ever got a chance to free space. Agents returned
`"[max tool rounds reached]"` after exactly zero useful work, on every
fresh session.

**Rule:** Multi-stage limits must be ordered so the _cheaper_
mitigation runs first. If compression triggers at threshold C and the
hard abort triggers at threshold A, then `A ≥ C` — otherwise A
short-circuits C and you skip the recovery path.

We raised the budget default to 80000 so it backstops compression
instead of pre-empting it.

## 5. Generic fallback strings hide multiple failure modes

The post-loop fallback in `inferWithTools` always returned
`"[max tool rounds reached]"` regardless of why the loop exited —
genuine round-exhaustion, per-round token cap, or anything else. A
salesperson on WhatsApp got the same opaque English placeholder for
three different conditions, with no way to distinguish them in the
support channel either.

**Rule:** When multiple distinct failure modes funnel into the same
catch-all string, the user can't tell you which one fired and you
can't tell from the logs either. Track the exit reason and emit
distinct messages — even one extra string per branch pays for itself
the first time the user reports it.

## 6. Test isolation gaps surface when a write moves into a hot path

Moving `recordCost` into `infer()` exposed a pre-existing test
isolation problem: 5 test files exercise `infer()` without mocking
`db.js`, and the default `CRM_DB_PATH` resolves to the _production_
`data/store/crm.db`. The first test run after the change wrote 4
polluted rows (`fallback-model` provider) directly into prod.

The fix was a one-line `vitest.config.ts` change — add a `setupFiles`
entry that points `CRM_DB_PATH` at a per-run temp file. This was
worth fixing regardless of the budget change; it would have bitten
the next person to add any DB write to a hot path.

**Rule:** When a refactor moves a side effect into a more central
function, audit which existing tests now exercise that side effect
unintentionally. Test pollution into production data stores is a
class of bug that only appears when a previously-quiet code path
becomes loud — by then it's too late to notice without a comparison.

**Mechanically:** every test suite needs a deterministic answer to
"where does this run write to?" If the answer is "wherever
`process.cwd()` happens to be," the suite has no isolation guarantee.
Set the data-path env var in vitest setup, never in individual tests.

## 7. SQLite → Postgres backup: bytea is binary-safe, COPY TEXT is not

When the user asked whether we had a live backup of the CRM SQLite, the
honest answer was no — `.backups/` held only March 8 _code_ snapshots,
nothing automated, no replication, no off-host copy. We shipped two
components: bytea snapshots every 15 min for recovery (Component A)
and a daily `pgloader` schema-translated mirror for analytics
(Component B). Targets the existing Supabase Postgres at `localhost:5433`
(`db.mycommit.net` upstream) — no new infrastructure.

The non-obvious lesson surfaced _during_ implementation:

**`\copy` in TEXT format is not bytea-safe.** PostgreSQL's wire format
treats `\x` as a single-byte escape (the character with hex code in
the next two digits), _not_ as the bytea hex literal prefix that
SQL-level `INSERT ... '\xABCD'::bytea` recognizes. So a row built as
`<tab><tab>...<tab>\x1f8b08...` writes a single 0x1f byte followed by
the _ASCII characters_ `8b08...` into the bytea column. The first
backup looked successful (rows landed, sizes plausible) but every
restore failed with "not in gzip format."

**Rule:** For arbitrary binary into a `bytea` column, use PostgreSQL
large objects: `\lo_import 'path'` to load the file as a temporary
LOB, `INSERT ... lo_get(:oid)` to copy into bytea, `lo_unlink(:oid)`
to clean up. Symmetric on read: `lo_from_bytea(0, db_blob)` then
`\lo_export :oid 'path'`. No escape ambiguity, no command-line size
limits, no stdin protocol contortions.

**Also:** `\lo_import` sets the special `LASTOID` variable, but
`:LASTOID` only expands cleanly inside a `\set` indirection
(`\set blob_oid :LASTOID`), not directly in a subsequent SQL statement.
Without the indirection it silently expands to `0` and you get
`large object 0 does not exist`.

**Operationally**, two patterns worth keeping:

- **Atomic schema swap for queryable mirrors.** pgloader loads into
  a `crm_mirror_loading` schema, then a single transaction does
  `DROP SCHEMA crm_mirror CASCADE; ALTER SCHEMA crm_mirror_loading RENAME TO crm_mirror;`.
  Readers either see the previous full mirror or the new full mirror,
  never an empty or half-loaded state.
- **Operate on a snapshot, not the live DB.** Both Component A
  (`sqlite3 .backup` → gzip → bytea) and Component B (snapshot →
  pgloader) take an atomic offline copy first. `.backup` uses
  SQLite's online backup API — no reader lock against the live agent.

---

# Engine Evolution Arc (same day, evening session)

After the §2 security batch landed, the day continued into a
strategic decision: stop pulling from upstream NanoClaw (they've
moved to a v2 architecture incompatible with our CRM glue) and
treat `engine/` as a permanent fork. From that one decision came
five shippable phases: `799b6b9` (P1 cleanup), `24dcec6` (P2a
resource limits), `3ee0c7e` (P2b bootstrap split), `38dbf53` (P2c
observability), `3265b2e` (P3 arc closure).

Seven durable learnings worth naming.

## 8. Plans shrink under closer reading

The Phase 2 plan looked substantial on paper. Two of the three
sub-phases shrank dramatically once I actually read the code:

- **Phase 2b (index.ts split)** — original plan called for a "thin
  index.ts via dramatic split." Closer reading showed index.ts is
  well-organized (state at top, helpers grouped, main(), entry
  guard); a bigger split would require passing module state across
  files, which is _worse_ than the current shape. The valuable
  extraction was just the boot sequence — 25-line reduction +
  ~85-line new file.

- **Phase 2c (heartbeat reaper)** — original plan called for a full
  port of upstream's `host-sweep.ts`. Closer reading of
  `engine/src/container-runner.ts:537-562` showed our existing
  `IDLE_TIMEOUT + reset-on-stream-output` already acts as effective
  heartbeat. The actual gap was just _operator visibility_ for the
  rare wedge case. Picked Option B (5-min log + localhost endpoint,
  ~50 LOC) over Option C (full reaper, ~4h multi-file).

**The pattern:** don't trust the high-level plan. Read the actual
code _before_ committing to scope. The "look at the file, it's
600 LOC, must be a mess" instinct is wrong about half the time.

## 9. Honest pushback is engineering work

Three times this evening I pushed back on planned scope before
shipping (Phase 2b → minimal extraction; Phase 2c → observability
only; Phase 3 → close arc deferred). Each time the user accepted
with brief instruction ("Go for B," "Close the arc"). The lesson:
when a plan implies more work than the cost-benefit warrants,
_saying so_ is part of the job. Not preachy, just direct: "I read
the code and the gap is smaller than the plan implied; here are
three options."

The user explicitly invited this with phrases like "plan
thoughtfully" and "double check if necessary." That's a license,
not a hint.

## 10. `process.env.X = ""` defeats `??`

Audit-caught Phase 2a regression risk:
`process.env.CONTAINER_MEMORY ?? '512m'` only catches `undefined`.
If an operator drafts `CONTAINER_MEMORY=` in the systemd
Environment line and forgets the value, `??` keeps the empty
string, the runtime pushes `docker run --memory ''`, and docker
rejects — container fails to start (worse than no limit).

Fix: a tiny `trimEnv()` helper that treats empty/whitespace as
"use default." Pattern worth using anywhere env vars feed config
defaults:

```ts
const trimEnv = (v: string | undefined, fallback: string): string => {
  const t = (v ?? "").trim();
  return t === "" ? fallback : t;
};
```

The `??` operator is _almost_ what you want for env vars; never
quite is.

## 11. `--cpus 0` is rejected; `--memory 0` and `--pids-limit 0` mean unlimited

Docker's escape-hatch convention is uneven. `--memory 0` and
`--pids-limit 0` mean "no limit." `--cpus 0` is _rejected_ with
`range of cpus is from 0.01 to <ncpu>`.

Phase 2a sidestepped this by using the same _skip-the-flag_ pattern
for all three: `if (X !== '0') args.push('--<flag>', X);`. Setting
any to `'0'` omits the flag entirely (which Docker treats as
"unlimited" for memory + pids; for cpus, omission also = unlimited).
Uniform across the three.

The takeaway: when a tool's escape-hatch convention is partially
broken, abstract _away_ from the tool's convention rather than
papering over the gap.

## 12. Localhost socket check, not header check, is the right operator-endpoint defense

Phase 2c's `/api/v1/containers/active` is operator-only. The
defense is `req.socket.remoteAddress === '127.0.0.1' || '::1' ||
'::ffff:127.0.0.1'`. **Not** `X-Forwarded-For`, which an attacker
can spoof.

Threat model verification I should always run on a "localhost-only"
claim:

1. Does any reverse proxy front this listener? (Caddy, nginx,
   HAProxy.) If yes, every request will socket-arrive from the
   proxy's loopback → "localhost-only" silently becomes "everyone."
2. What does `ufw status` say about the port? If open, public IPs
   reach the listener directly — verify by `curl`ing from
   `hostname -I` (the public iface).

In our case Caddy only proxies db/studio/grafana subdomains, none
point at port 3000, UFW allows 3000 publicly. The socket check
correctly rejects external clients. Verified post-deploy:
`curl http://<public-ip>:3000/api/v1/containers/active` → 403.

If we ever add Caddy in front of port 3000, both `/api/v1/token`
and `/api/v1/containers/active` will silently flip to public.
Worth a comment on those routes; deferred for now.

## 13. `vitest`'s `resetModules` is `vi.resetModules()`, not a named export

Trivially small but cost a test run. `import { resetModules } from
'vitest'` doesn't exist. The correct API is on the `vi` global:
`vi.resetModules()`. Used inside test bodies that need to re-import
a module after mutating `process.env` so module-level constants
reflect the new state.

## 14. Existing safety nets often already cover the "obvious" gap

Phase 2c was queued as "container heartbeat + stuck-container
reaper, ported from upstream's host-sweep.ts" — a ~4h multi-file
port. Reading the actual container-runner code revealed:

- A 30-min hard-kill timer (`IDLE_TIMEOUT + 30s`) that gets reset
  on every streaming output chunk
- A "had streaming output" branch that distinguishes legitimate
  idle from never-responded
- The `--rm` flag that auto-cleans on exit
- group-queue's `idleWaiting` state that knows when a container
  is _supposed_ to be quiet

The composition of these is _already_ effective heartbeat behavior
for everything except the genuinely-wedged-mid-execution case
(rare, hard to distinguish from legitimate idle without
container-internal heartbeat).

**The pattern:** before adding a defensive layer because "we
should detect X," read the existing code and ask whether X is
_already_ detected by a composition of existing layers under a
different name. Often it is.

---

## Cross-cutting meta-pattern from the day

Two extended sessions, ~2,500 lines of code shipped, ~14k lines
removed (the engine/setup et al cleanup), 17 new tests across
Phase 2, six audit-on-audit fix loops. The thread that runs
through all of them: **scope discipline beats velocity**.

Each ship-it batch:

1. Plan the scope explicitly before invoking
2. Read the actual code (not the high-level plan) before locking
3. Push back if the plan and the code disagree
4. Audit-on-audit pre-commit, fix any non-trivial findings
5. Ship the smaller-than-planned version with explicit
   documentation of _why_ it's smaller

Repeated mechanically, this beats "just ship the plan." Speed
comes from not having to revert.
