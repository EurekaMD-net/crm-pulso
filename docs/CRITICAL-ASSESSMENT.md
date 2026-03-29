# Pulso — Critical Assessment: 10 Flaws That Threaten Viability

> Written 2026-03-29. Brutally honest analysis of what must change before production.
> Purpose: Convert weaknesses into prioritized opportunities.
> Companion to: `COMPETITIVE-ASSESSMENT.md`, `VISION.md`, `TECHNICAL-EVOLUTION-PLAN.md`

---

## TL;DR

Pulso is architecturally impressive and functionally rich — 70 tools, 28 tables, 1004 tests, overnight intelligence, cross-agent patterns, warmth scoring, template evolution. But every component operates on assumptions, seed data, and prompt-engineered behavior that hasn't survived contact with a single real sales cycle. The common thread across all 10 flaws: the system is optimized for features instead of validated for reality.

---

## 1. Zero Production Hours Is Not a Gap — It's an Existential Risk

The competitive assessment says it plainly: "0 production hours, 0 real users, 0 validated outcomes." But the project behaves as if production validation is one of many items on the roadmap. It's not. It's the only item that matters.

70 tools, 28 tables, 1004 tests, overnight analyzers, cross-agent pattern detection, warmth scoring, template evolution, feedback engines. Phase 11 of a system that has never survived contact with a single real salesperson.

Every feature added before production validation is a bet that assumptions about sales behavior are correct. The overnight engine assumes salespeople want AI-generated proposals at 2 AM. The warmth scoring assumes recency decays linearly over 90 days. The approval workflow assumes managers will review records in WhatsApp. None of these have been tested against reality.

**Opportunity:** Stop building features. Deploy to 3-5 real AEs in one region with one manager. Run 60 days. The overnight engine, warmth scoring, and cross-intelligence will either prove themselves or reveal what actually matters. Everything learned in those 60 days is worth more than the next 5 phases combined.

---

## 2. The Feedback Loop Is Broken — The System Doesn't Learn

`feedback-engine.ts` captures draft-vs-final deltas beautifully. When a user modifies an AI-generated proposal, every change is recorded: original values, final values, delta percentages, result (accepted/modified/dismissed).

But nobody reads the feedback. `proposal-drafter.ts` generates new drafts without ever querying `feedback_propuesta`. The overnight engine scores templates without incorporating proposal acceptance data. The agent doesn't know that users consistently remove digital from its media mixes, or that it overshoots `valor_estimado` by 20% every time.

The sensory nervous system (capture) was built but not the motor cortex (act on what was captured). The feedback table grows, metrics are computed, and nothing changes. If dismissal rate hits 60%, an insight is generated saying "borradores no utiles" — but the agent keeps generating the same bad drafts.

**Opportunity:** Highest-leverage fix in the system. Wire `feedback_propuesta` into `proposal-drafter.ts` as a pre-generation query: "What do users in this vertical consistently change about my drafts?" Even a simple "users removed digital 4 of the last 5 times" injected into the drafting prompt would close the loop. The infrastructure is already there — just connect the output to the input.

---

## 3. Behavioral Rules Live in Prompts, Not Code — One LLM Drift Away from Disaster

The most critical business rules — scope guard, data confidentiality, competitive firewall, briefing triggers — are all enforced by prompt instructions in `global.md` and role templates. Zero code enforcement.

The confidentiality firewall is a paragraph in the system prompt: "La informacion de un cliente NUNCA se usa para beneficiar a su competencia directa." But nothing in code prevents this scenario:

1. AE calls `consultar_cuenta` on Coca-Cola — sees $50M TV, $30M digital
2. AE calls `investigar_prospecto` on Pepsi (competitor)
3. AE calls `construir_paquete` for Pepsi — package builder uses peer benchmarks from same vertical — Pepsi gets a pitch informed by Coca-Cola's confidential spend data

The system permits all of this. The LLM might refuse if it remembers the rule. Or it might not. This bug was already documented once (the Bimbo/La Costena incident). The fix was adding text to the prompt. Text that the LLM can ignore.

**Opportunity:** Move the top 3 business rules into code. Competitive firewall: `construir_paquete` should check if the target account's vertical overlaps with any account the AE queried in this session, and flag it. Scope guard: tool handlers should reject calls that violate hierarchy (`WHERE ae_id = context.persona_id` is already there for most tools — verify all 70). This doesn't require rewriting everything — just hardening the 3-4 rules where LLM drift causes real damage.

---

## 4. SQLite Under Concurrent Load Is a Time Bomb

The database uses DELETE journal mode (not WAL) because of Docker bind mount compatibility. This means every write locks the entire database. With 5 concurrent agent containers writing activities, proposals, and insights simultaneously, `SQLITE_BUSY` contention occurs.

The IPC handler catches `SQLITE_BUSY` — and silently returns `true` (success). The agent thinks the activity was logged. It wasn't. Silent data loss under load.

There's no `busy_timeout` pragma. No write queue. No retry mechanism. The single lazy-loaded `better-sqlite3` connection is synchronous, meaning long queries block the Node.js event loop for all agents.

With 5 AEs this might never surface. With 50, it will.

**Opportunity:** Two-phase fix. Short term: add `busy_timeout = 5000` pragma (SQLite will retry internally for 5 seconds before failing). Fix the silent success bug — if `SQLITE_BUSY` persists, return failure to the agent so it can retry or inform the user. Long term: evaluate WAL mode with a Docker-compatible SHM directory, or move the write path to a queue processed by a single writer. The 50-AE scenario is the target — solve it now while the codebase is small.

---

## 5. The Overnight Engine Doesn't Scale Past 100 Accounts

The overnight engine runs 6 analyzers in a single transaction. Classic N+1 query patterns throughout:

- Analyzer 1 (calendar): 1 query + N dedup checks per account
- Analyzer 2 (inventory): E events x N account queries per event
- Analyzer 4 (cross-sell): N accounts x 3 queries each via `comparePeers`
- Analyzer 5 (market): N accounts x 1 `getDaysSinceActivity` each

For 200 accounts: ~2,200 queries per run. For 500 accounts: ~6,000+. All in a single transaction, during the same hours when nightly warmth recomputation and document sync are also running.

Worse: the all-or-nothing transaction means if analyzer 3 throws (say, a null field hits `JSON.parse`), analyzers 1-2's valid results are rolled back. The entire night's intelligence work is lost.

And `insight_comercial` never purges. Expired insights are marked `expirado` but never deleted. After a year: 100K+ rows clogging queries.

**Opportunity:** Three changes. (1) Run each analyzer in its own transaction — partial results are better than no results. (2) Batch the dedup checks (one `WHERE (tipo, cuenta_id, titulo) IN (...)` query instead of N individual queries). (3) Add a purge job: delete insights older than 90 days with status `expirado`. These are 2-3 hours of work that buy 10x headroom.

---

## 6. No Container Resource Limits — A Runaway Agent Can Kill Everything

Docker containers run with zero resource constraints. No `--memory`, no `--cpus`, no OOM configuration. If an agent enters an infinite tool-calling loop (which has happened — "poisoned thread" incidents are documented), it consumes unbounded CPU and memory until it kills the engine process.

With 5 concurrent containers and no limits, a single misbehaving agent can OOM-kill the host. The entire CRM goes down because one AE sent a message that triggered a pathological tool chain.

**Opportunity:** Add `--memory 512m --cpus 1` to container args in `container-runtime.ts`. One line change. Then add OOM monitoring: if a container is OOM-killed, log it as a critical error and don't retry the same message. Pure operational hygiene — high impact, low effort.

---

## 7. Cross-Agent Intelligence Is Architecturally Trapped

The cross-intelligence system detects patterns (vertical trends, holding movements, inventory conflicts) and stores them in `patron_detectado`. But patterns are role-gated: `nivel_minimo='director'` means AEs never see them. Only Directors and VPs have `consultar_patrones`.

The system detects "Vertical Automotive: 30% growth" — valuable intelligence that should inform every AE selling to automotive accounts. Instead, it sits in a table that AEs can't query.

Worse: agent containers are fully isolated. They share the database but not learned context. If Agent-AE1 learns through conversation that "Prospect X is price-sensitive," Agent-AE2 in the same vertical will never know. Memory banks are per-agent, not shared.

Intelligence flows up (AE to Manager to Director to VP) and never sideways (AE to AE). In a real sales org, the most valuable intelligence is lateral — what's working for peers in the same vertical.

**Opportunity:** Add a lightweight "intelligence briefing" to AE morning briefings. Don't expose the raw `patron_detectado` table — that's management-level data. Instead, have the overnight engine generate AE-appropriate summaries: "Tu vertical (Automotive) crecio 30% el ultimo trimestre. 3 cuentas de tu portafolio aun no tienen propuesta para Q2." Intelligence flowing down, filtered by role. One new briefing section, zero new tools.

---

## 8. 70 Tools Is Already Context-Heavy — And It Only Grows

Each tool definition consumes 200-500 tokens in the context window (name, description, JSON schema, enum values). 70 tools = 14-35K tokens injected into every single conversation turn. Add the system prompt templates (5K tokens), conversation history (40-100K for deep conversations), and 60-140K of a 200K context window is consumed before the LLM starts reasoning.

This works today. But tools are added every phase. At 100 tools, context pressure becomes real. At 150, it's acute. And there's no dynamic filtering — an AE asking "que hora es?" gets all 51 tools injected whether relevant or not.

There's no tool discovery either. The LLM can't ask "what tools do I have for email?" — it must scan all 51 definitions on every turn. Research shows LLM tool selection accuracy degrades significantly past ~30 tools.

**Opportunity:** Implement context-aware tool filtering. Not dynamic loading (complex), but simple intent-based subsetting: if the message mentions email, inject email tools + core tools. If it mentions pipeline, inject pipeline tools + core tools. A 15-tool subset per turn instead of 51 would halve context consumption and improve tool selection accuracy. The `scopeFilter` infrastructure in `helpers.ts` is already there — extend it from role-based to intent-based.

---

## 9. The Warmth Scoring Algorithm Is Arbitrary

The warmth score (0-100) uses three components:

- **Recency** (0-40): linear decay over 90 days
- **Frequency** (0-30): step function at arbitrary thresholds (0, 1, 2-3, 4-6, 7+)
- **Quality** (0-30): type x quality weights (comida=3, llamada=1.5, email=1)

Every weight is invented. Why is a `comida` exactly 2x more valuable than a `llamada`? Why does recency decay linearly (not exponentially, which is how real relationships cool)? Why is the frequency step from 1 to 2 interactions worth the same 5 points as the step from 4 to 7?

There's no longitudinal trend (is this relationship warming or cooling?), no negative signal (a lost deal doesn't reduce warmth), and no account context (VP's warmth with a Fortune 500 decision-maker uses the same formula as an AE's warmth with a mid-market planner).

**Opportunity:** Don't solve this theoretically. Deploy the current algorithm, track what Directors/VPs actually do with warmth data, and calibrate. After 60 days of real usage: Which warmth scores correlated with actual deals? Which contacts marked "caliente" went cold? Use the feedback to tune weights empirically. The algorithm is fine as a v1 — the problem is treating arbitrary weights as ground truth without validation.

---

## 10. Baileys Is a Business Dependency on Reverse-Engineered Software

Baileys is an unofficial, reverse-engineered WhatsApp library. It breaks when Meta updates their protocol. It violates WhatsApp's Terms of Service. Meta can (and has) banned numbers using unofficial APIs.

Every feature built — 70 tools, overnight intelligence, warmth scoring, cross-agent patterns — sits on top of a dependency that could stop working tomorrow with one Meta policy change. The competitive assessment frames this as a "medium-term risk." It's not. It's the single point of failure for the entire business.

The engine is called NanoClaw and is designed as a platform. But it has exactly one channel: WhatsApp via Baileys. If Baileys breaks, Pulso is dead.

**Opportunity:** NanoClaw already supports multi-channel architecture. Adding Telegram as a secondary channel removes the existential single-channel dependency. For a pilot with 5 AEs, Telegram is a perfectly viable primary channel. Longer term, migration to WhatsApp Business API (official, compliant, reliable) is the real answer — but a Telegram fallback buys time and proves the system is channel-agnostic.

---

## Priority Matrix

| #   | Flaw                               | Severity    | Fix Effort         | When                        |
| --- | ---------------------------------- | ----------- | ------------------ | --------------------------- |
| 1   | No production validation           | EXISTENTIAL | Operational        | Before anything else        |
| 10  | Baileys single point of failure    | EXISTENTIAL | Low (add Telegram) | Before pilot                |
| 3   | Prompt-only business rules         | CRITICAL    | Medium             | Before pilot                |
| 4   | SQLite concurrent write failure    | CRITICAL    | Low                | Before pilot                |
| 6   | No container resource limits       | CRITICAL    | Trivial            | Before pilot                |
| 2   | Feedback loop not closed           | HIGH        | Medium             | During pilot                |
| 5   | Overnight engine N+1 scaling       | HIGH        | Medium             | During pilot                |
| 7   | Cross-intelligence trapped by role | MEDIUM      | Low                | After pilot insights        |
| 8   | Tool context pressure at 70+       | MEDIUM      | Medium             | When adding Phase 12+ tools |
| 9   | Warmth weights unvalidated         | LOW         | Low (needs data)   | After 60 days of real data  |

---

## The Bottom Line

The highest-leverage move is not building Phase 12. It's deploying what exists to 5 real humans for 60 real days. Half of these 10 flaws will either prove irrelevant (warmth weights don't matter if nobody uses warmth) or become urgent with clear direction (SQLite contention matters exactly when you know the actual concurrent load).

The 5 fixes that should happen before that pilot: add Telegram fallback channel (#10), harden the confidentiality firewall in code (#3), add `busy_timeout` and fix silent SQLITE_BUSY failures (#4), add container resource limits (#6), and — the existential one — actually deploy (#1).

Everything else can wait for production data to guide the investment.
