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
