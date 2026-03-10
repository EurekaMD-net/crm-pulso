# Pulso — Project Status

> Quick-retrieval status file. Updated each `/session-wrap`.
> Last updated: 2026-03-09 (Pulso vision & technical plan defined)
> Companion docs: `VISION.md`, `TECHNICAL-EVOLUTION-PLAN.md`

## Phase Tracker

### Foundation (Complete)

| # | Phase | Status | Summary | Date |
|---|-------|--------|---------|------|
| 1 | Zero Data Entry | Done | Auto-capture from WhatsApp conversations | 2026-02 |
| 2 | Pipeline & Proposals | Done | Full sales pipeline with quota tracking | 2026-02 |
| 3 | Google Workspace | Done | Email, Calendar, Drive integration | 2026-03 |
| 4 | Scale & Reliability | Done | Parallel tools, Docker optimizations, web search | 2026-03 |
| 5 | Events & Inventory | Done | Event management, inventory tracking | 2026-03 |
| 6 | Escalation & Alerts | Done | Alert system, management escalation chain | 2026-03 |
| 7 | Intelligence Layer | Done | RAG + sqlite-vec + historical analysis + cross-sell + agent swarm (5 parallel recipes) | 2026-03 |

### Pulso Evolution (Planned)

| # | Phase | Status | Summary | Sessions | Weeks |
|---|-------|--------|---------|----------|-------|
| 8 | Exoskeleton Core | **In Progress** | Voice pipeline, EOD wrap-up, sentiment, confidence calibration, enhanced briefings, VP glance dashboard | 1–6 | 1–4 |
| 9 | Relationship Intelligence | Planned | Executive relationship tracking (3 new tables), warmth scoring, milestone alerts, contact opportunities | 7–10 | 5–8 |
| 10 | Workspace Abstraction | Planned | Provider interface + Google refactor (Phase A now). Microsoft 365 via MS Graph (Phase B when Azure AD ready) | 10.A–10.C | 7–9 |
| 11 | Creative Intelligence | Planned | Overnight analysis → autonomous proposal drafts, package builder, cross-agent pattern detection | 11–13 | 9–14 |
| 12 | Data Connectors | Planned | Cubo, inventory, contracts, programming schedule, SharePoint. Parallel with Phase 11 | 14–20 | 10–16 |
| 13 | A2A Foundation | Planned | Structured action layer + approval flow, REST API expansion, A2A protocol readiness | 21–23 | 15–20 |
| 14 | Polish & Scale | Planned | Adaptive personality, LLM migration (self-hosted Qwen 3.5), performance hardening, load testing | 24–26 | 18–24 |

---

## Phase 8: Exoskeleton Core — Session Breakdown

> Goal: Make the existing system feel like the cognitive partner described in VISION.md

| Session | Deliverable | Est. Hours | Dependencies | Status |
|---------|-------------|-----------|--------------|--------|
| 1 | Voice transcription pipeline — Whisper provider abstraction, Baileys media hook, `actividad` schema extension (`audio_ref`, `transcription`) | 2–3h | None | **Done** |
| 2 | EOD wrap-up workflow — 6:30 p.m. scheduled task, daily reflection prompt, consultar_resumen_dia tool, carry-over analysis | 1–2h | None | **Done** |
| 3 | Sentiment extraction — LLM-based classification on AE messages, `actividad` schema extension (`sentiment`, `sentiment_label`), `query_team_mood` manager tool, escalation evaluator | 2–3h | Session 2 | — |
| 4 | Confidence calibration — Persona updates across 4 CLAUDE.md templates, `data_freshness` metadata on key tool responses | 1h | None | — |
| 5 | Enhanced morning briefings — Wrap-up integration, contact recency analysis, quota path-to-close, manager mood aggregate, director relationship alerts | 2–3h | Sessions 2, 3 | — |
| 6 | VP glance dashboard — Single-screen mobile-friendly view: revenue pulse, pipeline health, quota heatmap, alerts & risks, inventory utilization. Builds on existing dashboard infra | 3–4h | None | — |

**Schema changes:** +4 columns on `actividad` (audio_ref, transcription, sentiment, sentiment_label)
**New tools:** ~3 (voice processing, team mood query, sentiment tools)
**New tests:** ~60–80

---

## Phase 9: Relationship Intelligence — Session Breakdown

> Goal: The director and VP relationship agenda — net-new capability

| Session | Deliverable | Est. Hours | Dependencies | Status |
|---------|-------------|-----------|--------------|--------|
| 7 | Relationship schema — 3 new tables (`relacion_ejecutiva`, `hito_contacto`, `interaccion_ejecutiva`) + indexes, migration logic | 1–2h | None | — |
| 8 | Relationship tools — 6–8 new Dir/VP tools: `log_executive_interaction`, `query_relationship_health`, `query_upcoming_milestones`, `add_executive_contact`, `add_milestone`, `query_relationship_map`, `suggest_contact_opportunity`, `update_strategic_notes`. Warmth computation (decay + frequency) | 3–4h | Session 7 | — |
| 9 | Relationship-aware briefings + nightly monitor — Warmth recomputation batch, staleness alerts in director/VP briefings, milestone alerts, contact opportunity suggestions, briefing template updates | 2–3h | Sessions 7, 8 | — |
| 10 | Contacto enhancement — 6 new columns (`es_ejecutivo`, `titulo`, `organizacion`, `linkedin_url`, `notas_personales`, `fecha_nacimiento`), auto-milestone creation for birthdays | 1h | Session 7 | — |

**Schema changes:** +3 tables, +6 columns on `contacto`
**New tools:** ~6–8 (relationship management, Dir/VP only)
**New tests:** ~80–100

---

## Phase 10: Workspace Abstraction — Session Breakdown

> Goal: Unified provider interface for Google + Microsoft. Enables SharePoint connector in Phase 12.
> Plan detail: `docs/WORKSPACE-ABSTRACTION-PLAN.md`

| Session | Deliverable | Est. Hours | Dependencies | Status |
|---------|-------------|-----------|--------------|--------|
| 10.A | Provider interface + Google refactor — `WorkspaceProvider` interface, extract Google code behind abstraction, rewrite 8 tool handlers as thin wrappers. Zero behavioral change | 3–4h | None | — |
| 10.B | Schema + config cleanup — Rename `google_calendar_id` → `calendar_id`, `google_event_id` → `external_event_id`, generic terminology in CLAUDE.md templates | 1–2h | Session 10.A | — |
| 10.C | Microsoft 365 provider — Azure AD auth, Outlook mail/calendar via Graph, SharePoint files via Graph. **Blocked on Azure AD app registration** | 4–5h | Session 10.A + Azure AD | Blocked |

**Schema changes:** 2 column renames
**New tools:** 0 (same tools, different backend)
**New tests:** ~30–40

---

## Phase 11: Creative Intelligence — Session Breakdown

> Goal: The agent thinks commercially — proposing deals, not just tracking them

| Session | Deliverable | Est. Hours | Dependencies | Status |
|---------|-------------|-----------|--------------|--------|
| 11 | Overnight analysis engine — Nightly pipeline (2–4 a.m.): quota gap analysis, client opportunity scan, inventory matching, autonomous proposal drafting (`propuesta.estado = 'borrador_agente'`). Schema: +2 columns on `propuesta` (`agente_razonamiento`, `confianza`) | 4–5h | Phase 8 complete | — |
| 12 | Creative package builder — Combinatorial package composition across linear/digital/events, CPM optimization, 3 new tools (`build_package`, `query_inventory_opportunities`, `compare_packages`) | 3–4h | Session 11 | — |
| 13 | Cross-agent intelligence — Lateral pattern detection: holding-level shifts, category trends, competitive signals, win/loss patterns. New table `patron_detectado`, pattern injection into role-appropriate briefings | 3–4h | Session 11 | — |

**Schema changes:** +1 table (`patron_detectado`), +2 columns on `propuesta`
**New tools:** ~3 (package builder tools)
**New tests:** ~60–80

---

## Phase 12: Data Connectors — Session Breakdown

> Goal: Connect the agent to every data source it needs. Runs parallel with Phase 11.

| Session | Deliverable | Est. Hours | Dependencies | Status |
|---------|-------------|-----------|--------------|--------|
| 14 | Connector architecture — Base `CrmConnector` interface, connector registry, health monitoring, local cache strategy | 2h | None | — |
| 15 | Cubo connector — Descargas, financials, cross-area visibility. Discovery-first (API/DB view/file export?) | 3–4h | Session 14 | — |
| 16 | Inventory connector — Available slots, pricing, tentpoles. Discovery-first | 3–4h | Session 14 | — |
| 17 | Contracts connector — Closed contracts, remaining budget, spend velocity | 2–3h | Session 14 | — |
| 18 | Programming schedule connector — Linear media programming, special events | 2–3h | Session 14 | — |
| 19 | SharePoint connector — Decks, presentations, past proposals. Extends RAG pipeline. Benefits from Phase 10 workspace abstraction | 3–4h | Session 14, Phase 10.A | — |
| 20 | Connector-enriched briefings — Wire real connector data into briefing engine + overnight analysis. Actual inventory, real pricing, contract expiry dates | 2–3h | Sessions 15–19 | — |

**Schema changes:** None (connectors populate existing tables or use local cache)
**New tools:** ~5–8 (per-connector query tools)
**New tests:** ~40–60 per connector

---

## Phase 13: A2A Foundation — Session Breakdown

> Goal: Build the protocol layer now, activate later

| Session | Deliverable | Est. Hours | Dependencies | Status |
|---------|-------------|-----------|--------------|--------|
| 21 | Structured action layer — New table `accion_agente`, approval flow via WhatsApp (pending → approved → executed), audit logging. Human approval gate on all external actions | 3–4h | Phase 8 complete | — |
| 22 | REST API expansion — Full CRUD endpoints (contacts, proposals, activities, relationships, inventory, actions), JWT auth, role-based scoping. Extends existing dashboard API infra | 4–5h | Session 21 | — |
| 23 | A2A protocol readiness — Structured JSON serialization for proposals + actions, agent identity, `external_ref` columns on `propuesta`/`contrato`/`actividad` | 1–2h | Session 22 | — |

**Schema changes:** +1 table (`accion_agente`), +3 columns (`external_ref` on 3 tables)
**New tools:** ~3 (approve/reject/list pending actions)
**New tests:** ~60–80

---

## Phase 14: Polish & Scale — Session Breakdown

> Goal: Production hardening for the 70% adoption threshold

| Session | Deliverable | Est. Hours | Dependencies | Status |
|---------|-------------|-----------|--------------|--------|
| 24 | Adaptive personality — New table `preferencia_agente` (verbosity, formality, push frequency, briefing/wrap-up times), dynamic persona injection, preference learning from interaction patterns | 2–3h | Phase 8 complete | — |
| 25 | LLM migration prep — Benchmarking harness across providers, prefix caching strategy, vLLM deployment config for self-hosted Qwen 3.5-122B-A10B | 2–3h | None | — |
| 26 | Performance & reliability — Sub-3s latency for common queries, batch job monitoring, index optimization, WAL mode, connector error fallbacks, 45-agent load test harness | 3–4h | All phases | — |

**Schema changes:** +1 table (`preferencia_agente`)
**New tools:** 0
**New tests:** ~30–40

---

## Cumulative Evolution

| Metric | Phase 7 (Now) | Phase 14 (Target) | Delta |
|--------|---------------|-------------------|-------|
| SQLite tables | 17 | 23 | +6 |
| CRM tools | 31 | ~55 | +24 |
| Test files | 22 | ~35 | +13 |
| Tests passing | 481 | 900+ | +420 |
| Persona templates | 8 | 8 (dynamic) | — |
| Claude Code sessions | — | 26 | — |
| Estimated hours | — | 65–85h | — |

### New Tables by Phase

| Table | Phase | Purpose |
|-------|-------|---------|
| `relacion_ejecutiva` | 9 | Executive peer relationships (persona ↔ contacto) |
| `hito_contacto` | 9 | Contact milestones (birthdays, promotions, appointments) |
| `interaccion_ejecutiva` | 9 | Executive interaction log (calls, lunches, events) |
| `patron_detectado` | 11 | Cross-agent detected patterns (holding shifts, category trends) |
| `accion_agente` | 13 | Structured agent actions with human approval gate |
| `preferencia_agente` | 14 | Per-AE communication preferences |

---

## Adoption Alignment

| Adoption Phase (VISION.md) | Technical Phases | What Users Get |
|---------------------------|-----------------|----------------|
| **Pilot (Months 1–3)** | 8 complete, 9 started | Voice input, smart briefings, EOD wrap-ups, sentiment, confidence calibration, VP dashboard |
| **Evangelists (Months 3–6)** | 9–11 complete, 12 in progress | Relationship intelligence, overnight proposals, creative packages, cross-agent patterns |
| **Standard (Months 6–9)** | 10, 12–13 complete | Full data integration, workspace abstraction, action layer, approval flow, API foundation |
| **Ecosystem (Months 9–12+)** | 14 complete | Adaptive personality, self-hosted LLM, production hardening, A2A readiness |

---

## Architectural Invariants

These rules hold across ALL phases:

1. **`engine/` is never modified** beyond the 5 documented hook points. All CRM code lives in `crm/`.
2. **Schema migrations are additive.** `ALTER TABLE ADD COLUMN`, `CREATE TABLE`. Never `DROP` or modify existing columns.
3. **Tools follow the existing registration pattern.** Every new tool goes through the same inference adapter.
4. **Role scoping is mandatory.** Every new tool, endpoint, and data query respects `hierarchy.ts`.
5. **Tests accompany every change.** No session ends without tests for the new code.
6. **CLAUDE.md personas are updated with every capability change.** A tool the agent doesn't know about doesn't exist.
7. **External actions require human approval.** No exceptions in any phase.
8. **All data has provenance.** Every number the agent cites is traceable to a source table and timestamp.

---

## Blocked Items

| Item | Waiting On | Affects Phase |
|------|-----------|---------------|
| Workspace Abstraction Phase B (Microsoft 365) | Azure AD app registration (IT admin) | 10.C |
| Multimodal vision | VL model endpoint (Qwen-VL or similar) | — |
| Data connector specifics | Discovery of cubo/inventory/contracts system interfaces | 12 (sessions 15–18) |

---

## External Dependencies

| Service | Status | Notes |
|---------|--------|-------|
| Dashscope (Qwen 3.5 Plus) | Active | Primary inference + text-embedding-v3 for RAG |
| MiniMax | Active | Fallback inference |
| Brave Search API | Active | Web search tool |
| Google Workspace | Active | Email, Calendar, Drive |
| WhatsApp (Baileys) | Active | Main risk — unofficial API |
| Whisper (transcription) | **Active** | Groq `whisper-large-v3` configured |
| Azure AD | Not started | Needed for Phase 10.C |

---

## Infrastructure

- **Server**: Test VPS, Node 22.22.0, Docker 29.3.0
- **Service**: `agentic-crm.service` (systemd), managed via `crm-ctl`
- **Container**: `agentic-crm-agent:latest` (rebuilt 2026-03-08)
- **WhatsApp**: Authenticated (5215530331051)
- **Dashboard**: Port 3000 open (UFW), short links via Bitly

---

## Recent Changes

| Commit | Description |
|--------|-------------|
| `b0162d4` | feat: Phase 8 Session 1 — voice transcription pipeline (Groq Whisper) |
| `4989428` | feat: add crm-add-tool and crm-deploy Claude Code skills |
| `8e39a40` | fix: replace TinyURL with Bitly for dashboard link shortening |
| `7082d1b` | feat: agent swarm + codebase audit fixes (31 tools, 481 CRM tests) |
| `ad29d4d` | docs: update README with dashboard feature and table count |
| `3469285` | feat: analytics tools, comprehensive seed data, agent runner fixes |
| `fd580b4` | fix: dashboard public access, short links, hierarchical cuota, clean alerts |
| `8375926` | feat: manager and director dashboards with role-based routing |
| `79489cb` | feat: VP dashboard UI with pipeline funnel, cuota bars, risk table |
| `b57e149` | feat: dashboard REST API with JWT auth and 6 endpoints |
