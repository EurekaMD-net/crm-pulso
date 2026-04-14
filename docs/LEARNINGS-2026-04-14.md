# Learnings — 2026-04-14 Full System Audit

Distilled, cross-cutting patterns from the 6-dimension audit. These are
the lessons worth re-reading before the next architectural change, not a
rehash of individual fixes (for those see `docs/AUDIT-2026-04-14.md`).

## 1. Parallel audit agents produce ~20% false positives

Six specialist agents returned 71 findings. 13 (18%) did not survive
direct file verification. Common classes of false positive:

- **"SQL injection via `${col}` interpolation"** — almost always gated
  by an explicit whitelist check earlier in the same function. The
  right severity is LOW (defense-in-depth via explicit map lookup),
  not CRITICAL.
- **"Secret file world-readable"** — always verify with `ls -la
<file>` and `git ls-files | grep <file>` before believing it.
- **"Async import with unhandled rejection"** — check whether the
  imported function is `export function` (sync) or `export async
function`. If sync, the surrounding try/catch already covers it.
- **"Inverted boolean logic"** — on careful reading, "return X if any
  pair differs" is often equivalent to "return Y only if all pairs
  match." Write out the negation explicitly before declaring a bug.
- **"Already-cached lookup recomputed per call"** — grep for the
  symbol in the file; an existing Set/Map may be in another module.

**Rule:** For every CRITICAL and every verification-cheap HIGH, read
the exact file:line before writing a fix. Verification cost is one
turn; mis-fix cost is hours of debugging plus a broken test suite.

## 2. Mexico City timezone in SQLite

The canonical pattern is `datetime('now','-6 hours')` in SQL DEFAULTs
and UPDATEs, **not** switching to JS-generated `new Date().toISOString()`.

Why:

- MX is UTC-6 year-round (DST abolished for most states in 2023), so a
  whole-hour offset is stable.
- The existing schema uses `datetime('now')` DEFAULTs — format is
  `YYYY-MM-DD HH:MM:SS`. Mixing JS ISO strings (`...Z` suffix, `T`
  separator, millisecond precision) makes SQL comparisons fragile.
- Hourly windows align automatically (MX hour = UTC hour − 6, both at
  :00). Daily windows (`datetime('now','-1 day')`) are relative, also
  safe. Only **monthly** and **yearly** boundaries need explicit MX
  handling: `datetime('now','-6 hours','start of month','+6 hours')`.

For JS code paths that need an MX datetime as a string, use
`getMxDateTimeStr()` in `crm/src/tools/helpers.ts` — produces the same
`YYYY-MM-DD HH:MM:SS` format via `toLocaleString("sv-SE", { timeZone:
"America/Mexico_City" })`.

**Anti-pattern:** `new Date().getFullYear()` / `.getMonth()` /
`.toISOString()` anywhere user-facing. Always use `getMxYear()` or
`getMxDateStr()`.

## 3. Async-port a hot-path FS module all at once

When a module uses sync FS calls on the inference loop, partial
conversion is worse than no conversion:

1. Port **every** `fs` call to `fs/promises` in the same commit.
2. Make the primary function `async` and update the single call site
   to `await`. If the call site is already inside a `Promise.all(...map
(async toolCall => ...))`, just adding the `await` is enough.
3. **Delete** any probabilistic cleanup — it just makes latency
   unpredictable (most calls cheap, 10% spike). Replace with a
   `setInterval` from `bootstrap.ts`, `.unref?.()` so the process can
   exit cleanly.
4. Build any derived preview (TOC, summary) from the **full content**,
   not the preview slice. A preview-derived TOC lies about the document.
5. Update all tests to `await` the new API. Vitest will silently
   compare a `Promise` to a string otherwise and fail with a confusing
   `Promise {} !== "value"` message.

Reference: `crm/src/tool-eviction.ts` 2026-04-14.

## 4. Scope-check every LLM-supplied name parameter

Any tool that accepts a `persona_nombre`, `cuenta_nombre`, or
`ejecutivo_nombre` and resolves it to an id via fuzzy lookup MUST
re-apply the caller's scope before using the resolved id in a filter.

Without this, a director asking "pipeline de Juan" can see **any**
Juan in the org, not just Juans in their subtree. The role-scoped
team filter is completely bypassed.

Pattern (from `crm/src/tools/analytics.ts`):

```ts
function isInScope(ctx: ToolContext, targetId: string): boolean {
  if (ctx.rol === "vp") return true;
  if (targetId === ctx.persona_id) return true;
  if (ctx.rol === "director") return ctx.full_team_ids.includes(targetId);
  if (ctx.rol === "gerente") return ctx.team_ids.includes(targetId);
  return false; // AE: only self
}

function resolveNameInScope(ctx, name): string | null {
  const pid = personaIdFromName(name);
  if (!pid || !isInScope(ctx, pid)) return null;
  return pid;
}
```

If `resolveNameInScope` returns `null`, fall through to the default
role-scoped filter — don't error. The user still gets their own
team's data, just not the out-of-scope stranger.

## 5. Every external call has a timeout, every breaker-skip is logged

The audit found two classes of silent failure:

- **Missing timeouts:** Google Workspace clients with no explicit
  bound could hang 2+ minutes on a partial GCP outage. The fix is
  `withTimeout(apiCall, 15_000, "drive.files.list")` wrapping every
  call site. 15s for reads, 30s for writes.
- **Silent circuit-breaker skips:** `HindsightMemoryBackend.retain()`
  returned early when the breaker was open with no log line. Users
  lost observations for hours without noticing.

**Rules:**

- No `await externalApi.call()` without a timeout wrapper.
- Every `if (breaker.isOpen()) return ...` also logs a `warn` with
  the operation name. Make degradation visible.
- Every `catch (err)` on an external call logs the error with
  structured fields, not bare `console.warn(err.message)`.

## 6. Spanish-aware homoglyph detection needs more than Cyrillic

The original injection guard covered only Cyrillic lookalikes
(15 entries) — the classic Russian jailbreak vector. Spanish-speaking
attackers have different tooling:

- **Latin Extended-A**: macron/caron variants like `ā ē ī ō ū ǎ ě`
  render visually identical to plain letters in most fonts.
- **Greek lowercase**: `α ο ε ρ υ ν κ` all have obvious ASCII twins.
- **Mathematical Alphanumeric**: `𝑎 𝑒 𝑖 𝑜 𝑢` (U+1D44E+) bypass most
  string filters.

These are all now in `HOMOGLYPHS` in `crm/src/injection-guard.ts`.
Critically, the map does **not** include Spanish diacritics (`á é í ó
ú ñ ü`) — those are legitimate characters in the language and
normalizing them would produce false positives on every other
sentence. Keep regional diacritics separate from visual spoof maps.

NFKC normalization (already in `normalizeForDetection`) handles
fullwidth / compatibility forms automatically — no need to add
`ａ` / `ｅ` to the map.

## 7. The ACI principle: tool descriptions teach WHEN, not just WHAT

Two nearly-identical `"Busca en..."` descriptions (`buscar_web` vs
`buscar_documentos`) produced unpredictable routing from the LLM.
The fix was not a schema change — it was rewriting each description
to explicitly teach:

- **WHEN to use** (concrete scenarios, not generic use cases)
- **WHEN NOT to use** (the negative cases matter more than the
  positive ones — they prevent the lazy wrong call)
- **WHAT the data source actually is** (internal corpus vs public
  web)
- **WHAT to expect back** (format, max size, freshness guarantees)

A LLM reading a tool definition should never need to guess. If two
tools have overlapping triggers, one or both descriptions are wrong.

## 8. Persona templates must teach proactive triggers, not just list tools

Memory tools were present in every persona file but had zero organic
use in production after a month — because the personas only _listed_
them, they didn't teach _when to fire them unprompted_.

Pattern that works (added to `crm/groups/ae.md`):

> **Después de PERDER una propuesta** → primero `buscar_memoria({...})`,
> luego `guardar_observacion({...})`.
>
> **Antes de una primera reunión con un stakeholder nuevo** →
> `buscar_memoria({consulta: "[nombre] preferencias"})`.

Concrete triggers with tool call shape, not abstract "use memory when
relevant." Same pattern for Jarvis escalation in `manager.md`: list
the specific conditions (3+ propuestas perdidas with same reason,
large account stalled 3+ weeks) that should prompt the agent to
proactively suggest `jarvis_pull`.

## 9. `console.log` is not logging, it's debugging

Three `console.log` / `console.warn` calls in `crm/src/tools/jarvis.ts`
were producing unstructured stdout that wasn't searchable, wasn't
sampleable, and didn't show up in any dashboard. Replaced with
`parentLogger.child({ component: "jarvis-pull" })` and structured
fields.

**Rule:** No `console.*` in `crm/src/`. Every module that needs to
log creates a child logger at module load time. Every log line has
structured fields, not interpolated strings.

## 10. Verify a completed test suite, not a spec-compliant one

My p95 linear-interpolation "fix" was more technically correct than
the nearest-rank shipped behavior — but it broke a test that asserted
the nearest-rank value. The test was **correct** for operational
intent (capture the tail), my "improvement" was correct for textbook
percentile definition. Two different things.

**Rule:** When "fixing" statistical math, read the test assertions
first. If the test expects the tail value (not the interpolated one),
the old code was correctly encoding an operational convention, not a
bug. Keep nearest-rank with `Math.floor(p * N)` for dashboard p95
metrics; use linear interpolation only when writing stats code for
data scientists.

---

Full before/after numbers and the complete fix list are in
`docs/AUDIT-2026-04-14.md`. These 10 lessons are the ones worth
reviewing before the next architectural change.
