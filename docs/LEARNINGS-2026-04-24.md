# Learnings — 2026-04-24 jarvis_pull "no respondió en tiempo"

A user-facing feature ("pregúntale a Jarvis") had been failing
reliably for weeks. Seven prior commits tried to fix it — every one
addressing a downstream symptom. The actual root cause was a budget
inversion: the outer caller had a shorter wallclock cap than the
inner request needed.

Patterns distilled here generalize beyond this CRM.

## 1. The inverted-budget anti-pattern

When a tool wraps a request in `AbortSignal.timeout(N)`, that N is
only meaningful if the **outer caller's wallclock cap ≥ N**. Otherwise
the AbortSignal never fires; the outer caller guillotines the call
first and the inner timeout is dead code.

The CRM's `agent-runner` enforced a 15s `Promise.race`-based
wallclock cap on every tool. The `jarvis_pull` tool wrapped its fetch
in `AbortSignal.timeout(90_000)`. **The 90s budget never ran** —
every tool call was killed at 15s. Mission-control's
`/api/jarvis-pull` cascade routinely lands at 30-90s, so the agent
declared "Jarvis no respondió en tiempo" while mc was still mid-cascade.

Three symptoms-of-symptoms got "fixed" before the budget inversion
was found:

| Commit         | What was changed                                | Why it didn't help                                                              |
| -------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `81b3a55`      | Bumped fetch timeout to 90s                     | Runner cap is 15s — the 90s never runs                                          |
| `12a9e9e` (mc) | Trim KB context to 1500 chars to avoid timeouts | Trimming saves <1s; cap is still 15s                                            |
| `12a9e9e` (mc) | Retry once on near-empty response               | Adds a 30-90s second `infer()` call, which made the inversion worse, not better |

**Rule**: when adding a tool with a known long-tail (LLM cascade,
external API with retries, anything where the inner request's
worst-case is in the same order of magnitude as the outer cap),
state the budget chain explicitly and verify each layer permits it.

```
fetch-side AbortSignal (primary budget):    110_000ms (in jarvis.ts)
agent-runner cap (defense-in-depth, +10s):  120_000ms (TOOL_TIMEOUTS)
mc /api/jarvis-pull double-infer worst:     ~110_000ms
```

The 10s gap between the fetch cap and the runner cap is intentional —
it ensures the fetch's AbortSignal fires first, producing a clean
tool-result error rather than a runner-level guillotine.

## 2. LLM confabulation masks the real failure

The 14:48 production failure log read:

> Agent output: Consultando con Jarvis... El sistema Jarvis no
> respondió en tiempo. Procedo a investigar directamente con
> herramientas de búsqueda web…

This text appears nowhere in the source code. The LLM **synthesized
it from the tool description's FLUJO step** ("Confirma al usuario:
'Consultando con Jarvis…'") combined with whatever error JSON the
tool returned. There was no actual "no respondió en tiempo" string
returned anywhere.

Worse: the cross-system trace **disagreed**. CRM logs said "no
respondió en tiempo" at 14:48:21. Mission-control logs showed the
fallback inference completing successfully at 14:48:22. The CRM had
given up 1 second before the answer arrived.

**Rule**: when an LLM-synthesized error narrative is the only
diagnostic signal, never trust it. Always cross-reference with the
upstream service's actual logs at the same timestamp. Discrepancies
between "what the LLM said happened" and "what the server logged"
are diagnostic gold — they tell you which side of the boundary the
real failure lives on.

## 3. Each setTimeout in Promise.race is a hidden event-loop ref

The original executor pattern:

```ts
return Promise.race([
  executeTool(name, args, toolCtx),
  new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error(...)), TOOL_TIMEOUT_MS),
  ),
]);
```

When `executeTool` resolves first, the `setTimeout` is still pending.
For a 100-call session at 15s default with most tools resolving in
<1s, the event loop holds ~1500s of pending timer refs simultaneously.
Not a leak (timers fire and are cleared eventually) but unnecessary
pressure that grows with session length.

Fix: capture the timer handle and `clearTimeout` it in `.finally()`:

```ts
let timer: NodeJS.Timeout | undefined;
const timeoutP = new Promise<string>((_, reject) => {
  timer = setTimeout(() => reject(new Error(...)), timeoutMs);
});
try {
  return await Promise.race([executeTool(...), timeoutP]);
} finally {
  if (timer) clearTimeout(timer);
}
```

**Rule**: any `Promise.race([work, timeout])` pattern needs a
`clearTimeout` on the resolve path. If you never plan to clear, use
`AbortController` instead — same shape, same coverage, but the
timer is bound to the controller and gets cleaned up automatically
on `abort()`.

## 4. Container rebuild + service restart is mandatory after any

`crm/container/` change

Reiterated from `LEARNINGS-2026-04-21.md` §1 — but worth re-stating
because the CRM ships compiled-into-container code. Source edits to
`crm/container/agent-runner/index.ts` have **zero effect** on running
containers until:

1. `npm run build:container`
2. `systemctl restart agentic-crm`
3. End-to-end smoke against the real image on `crm-net`

The `agentic-crm-agent:latest` image hash before this fix:
`b9d6960b7e8f`. After: `94ed9fbb6b87`. If you don't see a new sha,
your edit isn't running.

## 5. The audit found the real ceiling, not me

I shipped with `jarvis_pull: 100_000ms`. The qa-auditor agent's first
pass flagged it: mc's worst case is two infer() cascades
back-to-back (the route retries on near-empty response), so 100s
leaves zero headroom. Bumped to 120s runner / 110s fetch.

The auditor also found a `setTimeout` leak (#3 above) and a
no-test-coverage gap on the new branching logic — both real.

**Rule**: every fix that rewires a critical path gets an audit pass
before it ships. The audit doesn't have to be a different person —
the qa-auditor agent works with `--brief` against the diff and
catches things you stopped seeing five hours into the session.

## 6. Cross-cutting: tool description "FLUJO" with conversational

step-1 is an LLM trap

The `jarvis_pull` description includes a numbered FLUJO:

```
1. Confirma al usuario: "Consultando con Jarvis..."
2. Envía la consulta a Jarvis
3. Crea un Google Doc con el análisis formateado
4. Comparte el enlace del documento
```

In streaming mode, models tend to output Step 1 (the user-facing
phrase) and then sometimes fail to emit the actual `tool_use` block
for Step 2. The user sees "Consultando con Jarvis…" followed by an
unrelated answer, with no indication the tool wasn't called.

This was a contributing factor in early reports of "Jarvis didn't
work". The 14:48 failure on the other hand was a real call that
landed in mc — not a confabulation — but the conversational-step-1
pattern probably caused several other "silent skip" failures that
were never logged because no tool fired.

**Rule**: tool descriptions should NOT instruct the model to "say
something to the user before calling the tool". Confirmation
narrative belongs in the post-tool-result phase, not as an
instruction inside the tool description. If you want a user-facing
"please wait" indicator, render it in the tool's handler as a
streaming status update, not as a prompt instruction.

## 7. JWT signing secret with "random fallback for dev" is a

production hazard

Same session, second incident. Right after the `jarvis_pull` deploy
restarted `agentic-crm` at 23:13, mission-control reported "Jarvis
says token expired" when fetching CRM status. The mc `CRM_API_TOKEN`
JWT had a 30-day `exp` claim — checked at the boundary, valid until
May 24. But the CRM kept rejecting it with `401 {"error":"Invalid or
expired token"}`.

Root cause was **`crm/src/dashboard/auth.ts:18-22`**:

```ts
const SECRET =
  process.env.DASHBOARD_JWT_SECRET ||
  (process.env.NODE_ENV === "production"
    ? (() => { throw ... })()
    : crypto.randomBytes(32).toString("hex"));
```

`DASHBOARD_JWT_SECRET` was unset in `agentic-crm/.env` AND `NODE_ENV`
was unset, so the dev branch fired: a fresh random secret on every
process start. Every `systemctl restart agentic-crm` rotated the
secret silently — every previously-issued JWT (mc's, the dashboard's,
internal callers') instantly failed signature verification while
their `exp` claims still looked fine.

This pattern has three independent failure modes that compound:

1. **Silent state mutation across restarts.** No log line on boot
   said "regenerated random secret because DASHBOARD_JWT_SECRET was
   unset". The behavior was invisible until a downstream caller hit 401.
2. **`NODE_ENV` not set + production = dev-fallback active in prod.**
   The "production guard" only fires when `NODE_ENV === "production"`.
   Most systemd units don't set NODE_ENV. So the safety throw never
   ran, and prod ran with dev semantics.
3. **Error message conflates two failure modes.** `verify()` returns
   the same string `"Invalid or expired token"` whether the signature
   is wrong (secret rotated) or the `exp` is past. The diagnostic
   signal is lost — you cannot tell from the error which branch you
   need to fix. Distinguishing them is a 5-line edit.

**Rule**: any "use ENV_VAR if set, else generate randomly for dev"
pattern is a tripwire when ENV_VAR is silently absent in production.
If the value matters for cross-process consistency (signing secrets,
encryption keys, session keys, CSRF tokens), the dev branch should
either:

- Persist the random value to disk on first boot and reuse it on
  restart (so dev still works without an env var, but the value is
  stable across restarts), OR
- Log a loud `console.warn("⚠️  DASHBOARD_JWT_SECRET unset — using
random per-process value, all tokens will be invalidated on next
restart")` on boot so the operator sees it once.

**Fix shipped**:

- Generated 64-hex-char secret via `openssl rand -hex 32`.
- Pinned to `agentic-crm/.env` as `DASHBOARD_JWT_SECRET=<hex>`.
- Documented requirement in `.env.example` (commit `0d9d65e`) so the
  next operator who clones this won't recreate the trap.
- Re-minted `CRM_API_TOKEN` for `per-001 / vp` against the new pinned
  secret, locally signature-verified before deploy, written to
  `mission-control/.env`, mc restarted.
- Tightened `mission-control/.env` and `COMMIT-AI/.env` from mode 644
  to 600 (audit caught both as world-readable despite holding API
  keys + bot tokens — same single-user box, but principle of least
  privilege).

**Diagnostic signal — error-message disambiguation is debugging gold.**
If `auth.ts:verify` had returned `"Token signature invalid (secret
mismatch)"` vs `"Token expired (exp past)"` separately, this would
have been a 30-second diagnosis instead of 30 minutes. The fix
remains an open follow-up.
