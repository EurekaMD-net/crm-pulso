# Pulso — Project Status

> Quick-retrieval status file. Updated each `/session-wrap`.
> Last updated: 2026-03-16 (Session 11.1 live — overnight analysis engine, 55 tools, 23 tables, 681 CRM tests)
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
| 8 | Exoskeleton Core | **Done** | Voice pipeline, EOD wrap-up, sentiment, confidence calibration, enhanced briefings, VP glance dashboard | 1–6 | 1–4 |
| — | Hindsight Adaptations | **Done** | Circuit breaker (inference + embedding), Hindsight long-term memory (3 banks, 3 tools), hybrid RAG (FTS5 + reciprocal rank fusion) | — | — |
| 9 | Relationship Intelligence | **Done** | 3 tables, 6 contacto columns, 7 Dir/VP tools, warmth engine, briefing integration, nightly recomputation | 7–10 | 5–8 |
| 10 | Workspace Abstraction | Planned | Provider interface + Google refactor (Phase A now). Microsoft 365 via MS Graph (Phase B when Azure AD ready) | 10.A–10.C | 7–9 |
| 11 | Creative Intelligence | **11.1 Done** | Overnight analysis engine (5 analyzers), insight table, 3 tools, briefing integration. Next: 11.2–11.5 | 11–13 | 9–14 |
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
| 3 | Sentiment extraction — LLM auto-classification on activities, `sentimiento_score` column, `consultar_sentimiento_equipo` tool (Gerente+), coaching escalation includes urgente | 2–3h | Session 2 | **Done** |
| 4 | Confidence calibration — `dataFreshness` helper, `data_freshness` metadata on pipeline/descarga/cuota responses, calibration section in all 5 persona templates | 1h | None | **Done** |
| 5 | Enhanced morning briefings — `generar_briefing` tool (4 role dispatchers), rewritten briefing prompts, carry-over/recency/path-to-close/sentiment/compliance/revenue-at-risk | 2–3h | Sessions 2, 3 | **Done** |
| 6 | VP glance dashboard — Single-screen mobile-friendly view: revenue pulse, pipeline health, quota heatmap, sentiment pulse, alerts, inventory utilization. Single `/api/v1/vp-glance` endpoint + `glance.html` | 3–4h | None | **Done** |

**Schema changes:** +4 columns on `actividad` (audio_ref, transcripcion, sentimiento_score, tipo_mensaje)
**New tools:** +3 (consultar_resumen_dia, consultar_sentimiento_equipo, generar_briefing) — 34 total
**New API endpoints:** +1 (`/api/v1/vp-glance`) — 7 total
**New dashboard pages:** +1 (`glance.html`) — VP mobile glance view
**New tests:** +78 so far (543 CRM tests passing)

---

## Hindsight Adaptations (2026-03-14) — Cross-cutting improvements

> Goal: Port resilience, memory, and retrieval patterns from mission-control's Hindsight integration (v2.8)

| Deliverable | Description | Status |
|-------------|-------------|--------|
| Circuit breaker | Reusable `CircuitBreaker` class (3 failures → 60s cooldown → half-open). Per-provider breaker in `inference-adapter.ts` (skips open Dashscope, falls to MiniMax). Module-level breaker in `embedding.ts` (fast-forwards to local trigram fallback) | **Done** |
| Hindsight sidecar | `HindsightClient` HTTP wrapper, `HindsightMemoryBackend` with circuit breaker + lazy bank creation, `SqliteMemoryBackend` fallback, singleton factory. Docker sidecar managed via `crm-ctl hindsight-*`. Container networking via `--add-host` | **Done** |
| Agent memory tools | 3 new tools: `guardar_observacion`, `buscar_memoria`, `reflexionar_memoria`. 3 CRM-specific memory banks: `crm-sales` (patterns, objections, client preferences), `crm-accounts` (relationship history, stakeholder preferences), `crm-team` (coaching, performance patterns). ACI-quality descriptions in Spanish | **Done** |
| Hybrid RAG | FTS5 virtual table (`unicode61 remove_diacritics 2` tokenizer for Spanish) alongside sqlite-vec KNN. `searchDocumentsKeyword()` with query sanitization. `reciprocalRankFusion()` (k=60, ported from Hindsight). `searchDocuments()` runs both strategies in parallel, fuses via RRF. Graceful degradation: FTS5 compensates when embedding API circuit breaker is open | **Done** |

**Schema changes:** +2 tables (`crm_memories`, `crm_fts_embeddings`) — 18 total
**New tools:** +3 (guardar_observacion, buscar_memoria, reflexionar_memoria) — 37 total
**New tests:** +35 (578 CRM tests passing, 27 test files)
**New files:** 10 (circuit-breaker, 5 memory service, memoria tools, 3 test files)
**Modified files:** 17 (inference-adapter, embedding, schema, doc-sync, tools/index, bootstrap, container-runner, agent-runner, crm-ctl, 5 group templates, 3 test files)

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

## Record Creation Approval Workflow (2026-03-16)

> Goal: Prevent duplicates and ensure data quality — AE→Gerente→Director approval chain with cascading assignment

| Deliverable | Description | Status |
|-------------|-------------|--------|
| Schema | +1 table (`aprobacion_registro`), +3 cols each on `cuenta`/`contacto` (`estado`, `creado_por`, `fecha_activacion`), +2 indexes | **Done** |
| 6 approval tools | `solicitar_cuenta`, `solicitar_contacto`, `aprobar_registro`, `rechazar_registro`, `consultar_pendientes`, `impugnar_registro` | **Done** |
| Cascading assignment | Gerente assigns AE, Director assigns Gerente (Ger then assigns AE), VP assigns Director (chain cascades down) | **Done** |
| Estado filtering | `estadoFilter()` hides non-active records except from creator. Applied to pipeline, cuentas, cuenta detail, findCuentaId | **Done** |
| IPC notifications | `crm_approval_notification` IPC type routes to specific folders or `__ALL__` | **Done** |
| Alert evaluators | `alertAprobacion24hExpiry()` auto-promotes after 24h, `alertPendientesAprobacion()` reminds approvers | **Done** |

**Schema changes:** +1 table, +6 columns, +2 indexes — 22 tables total
**New tools:** +6 (solicitar_cuenta, solicitar_contacto, aprobar_registro, rechazar_registro, consultar_pendientes, impugnar_registro) — 52 total
**Role counts:** AE:38, Gerente:35, Director:45, VP:43
**New tests:** +52 (660 CRM tests passing, 30 test files)
**New files:** 2 (`crm/src/tools/aprobaciones.ts`, `crm/tests/aprobaciones.test.ts`)
**Modified files:** 16 (schema, tools/index, tools/helpers, tools/consulta, alerts, ipc-handlers, 5 group templates, CLAUDE.md, 3 test files, global CLAUDE.md)

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

| Metric | Current (Now) | Phase 14 (Target) | Remaining |
|--------|--------------|-------------------|-----------|
| SQLite tables | 21 | 23 | +2 |
| CRM tools | 46 | ~55 | +9 |
| Test files | 29 | ~35 | +6 |
| Tests passing | 608 | 900+ | +292 |
| Persona templates | 8 | 8 (dynamic) | — |
| Claude Code sessions | ~14 | 26 | ~12 |
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
| **Pilot (Months 1–3)** | 8 + Hindsight + 9 complete | Voice, briefings, sentiment, VP dashboard, long-term memory (Hindsight), hybrid RAG, relationship intelligence, Google Workspace (Gmail+Drive+Slides+Sheets+Calendar), agency data model |
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
| Google Workspace | **Active** | Email (send+read), Calendar (events+read), Drive (full), Slides API, Sheets API. Service account: crm-azteca-agent@crm-azteca.iam.gserviceaccount.com. Test user: fede@eurekamd.net |
| WhatsApp (Baileys) | Active | Main risk — unofficial API |
| Whisper (transcription) | **Active** | Groq `whisper-large-v3` configured |
| Hindsight | **Active** | Long-term memory sidecar running on crm-net Docker network. 3 banks (crm-sales, crm-accounts, crm-team). 29+ memories seeded |
| Azure AD | Not started | Needed for Phase 10.C |

---

## Infrastructure

- **Server**: Test VPS, Node 22.22.0, Docker 29.3.0
- **Service**: `agentic-crm.service` (systemd), managed via `crm-ctl`
- **Container**: `agentic-crm-agent:latest` (rebuilt 2026-03-16)
- **Hindsight**: `crm-hindsight` Docker sidecar on `crm-net` network (port 8888 API, 9998 UI), persistent volume at `data/hindsight/`. Qwen LLM + local embeddings
- **WhatsApp**: Authenticated (5215530331051)
- **Dashboard**: Port 3000 open (UFW), short links via Bitly

---

## Recent Changes

| Commit | Description |
|--------|-------------|
| `7eefde3` | feat: consultar_cuentas tool — account overview with agency info (46 tools) |
| `f5e08cd` | fix: agencies are NOT clients — fix data model and system prompt |
| `928a5ba` | feat: HTML email template — proper paragraph spacing, clean layout |
| `8024bd1` | fix: Hindsight client API paths + seeded 29 memories |
| `7683cfe` | fix: Docker network for container→Hindsight connectivity |
| `37a8e6f` | fix: agent memory — context window 12→30, active memory protocol |
| `1833241` | feat: disambiguation protocol in agent system prompt |
| `e3fe247` | fix: Slides object IDs >= 5 chars (Google API requirement) |
| `a9af920` | fix: split Gmail scopes — send-only vs compose, fallback on draft fail |
| `ecbefd8` | fix: add email send/draft tools to Director and VP roles |
| `286621d` | feat: populate Slides and Sheets content on creation (Slides API + Sheets API) |
| `6b81c1b` | feat: crear_documento_drive — create Google Docs, Sheets, Slides |
| `a1604d4` | fix: add GOOGLE_* to secrets pipeline (3-place pattern) |
| `056357e` | feat: add full Drive scope + getDriveWriteClient |
| `99062e4` | feat: Phase 9 Session 9 — briefing integration + nightly warmth recomputation |
| `0447445` | feat: Phase 9 Session 8 — relationship tools + warmth computation (7 tools, 44 total) |
| `7ff8ca4` | feat: Phase 9 Session 7 — relationship schema (3 tables + contacto enhancement) |
| `b752b85` | feat: Hindsight adaptations — circuit breaker, long-term memory, hybrid RAG (18 tables, 37 tools, 578 tests) |
| `63cf2e3` | fix: voice transcription — wrong import path + bad extension parsing |
| `83a1226` | feat: Phase 8 Session 6 — VP glance dashboard (vp-glance API, glance.html, 543 tests) |
| `c531662` | feat: Phase 8 Session 5 — enhanced briefings (generar_briefing, 34 tools, 524 tests) |
| `144c492` | feat: Phase 8 Session 4 — confidence calibration (dataFreshness, 505 tests) |
| `f7ab07e` | feat: Phase 8 Session 3 — sentiment extraction pipeline (33 tools, 490 tests) |
| `a91a843` | feat: add daily activity seeder and update Phase 8 status docs |
| `b7a5cbb` | feat: Phase 8 Session 2 — EOD wrap-up workflow |
| `b0162d4` | feat: Phase 8 Session 1 — voice transcription pipeline (Groq Whisper) |
| `4989428` | feat: add crm-add-tool and crm-deploy Claude Code skills |
| `42404dc` | docs: add Pulso vision, technical plan, and updated roadmap (Phases 8-14) |
| `8e39a40` | fix: replace TinyURL with Bitly for dashboard link shortening |
