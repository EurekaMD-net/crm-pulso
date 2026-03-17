# Pulso: Technical Evolution Plan

## From crm-azteca to the Cognitive Exoskeleton

**March 2026 — Claude Code execution guide**
**Companion to: VISION.md**

---

## 0. Where We Are vs. Where We're Going

The crm-azteca repo is already a working agentic CRM with substantial infrastructure. This plan is not a rewrite — it's a **targeted evolution** that transforms a capable system into the organizational nervous system described in VISION.md.

### What Already Exists (crm-azteca — Phases 1–11 complete)

| Layer | What's Built | Files |
|-------|-------------|-------|
| **Schema** | 25 SQLite tables: 15 core + crm_events + docs/embeddings/vec/fts + crm_memories + 3 relationship + aprobacion_registro + insight_comercial + patron_detectado + feedback_propuesta | `crm/src/schema.ts` |
| **Tools** | 64 tools across 20+ modules — activity logging, pipeline mgmt, Google Workspace (Gmail, Drive, Calendar, Slides, Sheets), event tracking, RAG search (hybrid: sqlite-vec + FTS5), web search (Brave), analytics, cross-sell, swarm analysis, follow-up reminders, 3 memory tools, 7 relationship tools, 6 approval tools, 5 insight/draft tools, 2 pattern tools, 2 feedback tools, 3 package builder tools | `crm/src/tools/` |
| **Hierarchy** | Full org chart traversal + role-based access control (AE:45, Ger:48, Dir:57, VP:55) | `crm/src/hierarchy.ts` |
| **Proactive workflows** | Morning briefings (staggered by role), weekly summaries, hourly follow-up reminders, alert evaluation (8 evaluators + event countdown), document sync (Drive -> RAG), overnight commercial analysis (5 analyzers), nightly warmth recomputation | `crm/src/briefing-seeds.ts`, `crm/src/alerts.ts`, `crm/src/overnight-engine.ts`, `crm/src/warmth-scheduler.ts` |
| **Creative Intelligence** | Overnight analysis engine (5 analyzers), proposal drafting, cross-agent pattern detection (5 detectors), feedback loop (draft-vs-final learning), package builder (historical mix + peer benchmark + inventory) | `crm/src/overnight-engine.ts`, `crm/src/proposal-drafter.ts`, `crm/src/cross-intelligence.ts`, `crm/src/feedback-engine.ts`, `crm/src/package-builder.ts` |
| **Escalation** | Real-time cascade on activity insertion: AE->Manager->Director->VP with 4 evaluators | `crm/src/escalation.ts` |
| **RAG** | Hybrid: sqlite-vec KNN + FTS5 keyword search, reciprocal rank fusion (k=60), Dashscope text-embedding-v3 (1024d), Google Drive sync pipeline | `crm/src/doc-sync.ts`, `crm/src/embedding.ts` |
| **Memory** | Pluggable service (Hindsight sidecar or SQLite fallback), 3 banks (crm-sales, crm-accounts, crm-team), circuit breaker | `crm/src/memory/` |
| **Dashboard** | REST API with auth + 7 endpoints + VP glance page, short-code WhatsApp delivery | `crm/src/dashboard/` |
| **Infra** | Container builds, systemd services, crm-ctl CLI, IPC handlers, team registration (CSV/JSON) | various |
| **Tests** | 761 tests across 35 files | `crm/tests/` |
| **Personas** | CLAUDE.md templates per role (AE, Manager, Director, VP) + 3 team templates | `crm/groups/` |

### What the Vision Demands — Status

| Vision Capability | Status | Phase |
|------------------|--------|-------|
| **Voice-first input** | **Done** — Groq Whisper transcription pipeline | 8.1 |
| **End-of-day wrap-up** | **Done** — 6:30 PM scheduled workflow + consultar_resumen_dia | 8.2 |
| **Mood & momentum tracking** | **Done** — Sentiment extraction + consultar_sentimiento_equipo | 8.3 |
| **Confidence calibration** | **Done** — dataFreshness metadata, calibration sections in all templates | 8.4 |
| **Enhanced briefings** | **Done** — generar_briefing with 4 role dispatchers | 8.5 |
| **Relationship Intelligence Engine** | **Done** — 3 tables, 7 tools, warmth engine, nightly recomputation | 9 |
| **Enhanced client knowledge graph** | **Done** — 6 new contacto columns, executive milestones | 9 |
| **Overnight analysis -> autonomous proposals** | **Done** — 5 analyzers, proposal drafting, feedback loop | 11 |
| **Creative package builder** | **Done** — Historical mix + peers + inventory + rate cards, 3 tools | 11.5 |
| **Cross-agent intelligence** | **Done** — 5 pattern detectors, 2 tools | 11.3 |
| **External data connectors** | Planned — Missing: cubo, SharePoint, contracts, inventory, programming schedule | 12 |
| **A2A protocol foundation** | Planned — Structured action layer + REST API | 13 |
| **Adaptive personality** | Planned — Per-AE preferences | 14 |

---

## 1. Evolution Phases

Each phase maps to a set of Claude Code sessions. Phases are ordered by **trust-building value** — we ship what earns credibility with the pilot group first.

Phase numbering continues from the foundation phases (1-7) already completed. See `docs/PROJECT-STATUS.md` for the full sequential tracker.

---

### PHASE 8: The Exoskeleton Core (Weeks 1-4)
> *Goal: Make the existing system feel like the cognitive partner described in VISION.md*

This phase doesn't add major new infrastructure — it deepens and refines what exists to deliver the "day in the life" experience for the pilot AEs.

#### 8.1 Voice Transcription Pipeline
**Why first:** The vision has the AE talking to the agent after every call. Voice notes are the natural input for salespeople on the move. Without this, the system is text-only and friction-heavy.

**Implementation:**
```
crm/src/voice.ts                    — new module
crm/src/tools/voice-tools.ts        — new tool registration
```

- Hook into engine's media message handler to intercept WhatsApp voice notes (audio/ogg)
- Transcription provider abstraction: Whisper API (OpenAI), Groq Whisper, or self-hosted whisper.cpp
- Flow: voice note received -> download media via Baileys -> transcribe -> pipe transcription text into existing message handler as if user typed it
- Store original audio reference + transcription in `actividad` table (new column: `audio_ref TEXT, transcription TEXT`)
- The agent responds to voice notes the same way it responds to text — no special UX

**Schema migration:**
```sql
ALTER TABLE actividad ADD COLUMN audio_ref TEXT;
ALTER TABLE actividad ADD COLUMN transcription TEXT;
```

**Claude Code session:** ~2-3 hours. Start with provider abstraction, then Baileys media hook, then schema migration, then tests.

#### 8.2 End-of-Day Wrap-Up Workflow
**Why:** Completes the daily heartbeat. Morning briefing already exists — EOD wrap-up closes the loop and feeds tomorrow's briefing with richer context.

**Implementation:**
```
crm/src/wrapup-seeds.ts             — new scheduled workflow
```

- New scheduled task: weekdays at 6:30 p.m. (after briefings, before AEs disconnect)
- Per-AE message delivered to their WhatsApp group:
  - Summary of today's logged activities
  - What was planned (from morning briefing) vs. what happened
  - Open items carrying over
  - Prompt: "How did today go? Anything on your mind?"
- AE's response is logged as a special `actividad` type: `tipo = 'reflexion'`
- This reflection feeds into the next morning's briefing context and into manager-level mood synthesis

**Schema:**
```sql
-- No new tables. New actividad.tipo value: 'reflexion'
-- Add to existing tipo CHECK constraint or handle in application layer
```

**Claude Code session:** ~1-2 hours. Extend briefing-seeds.ts pattern, add new scheduled task, template the wrap-up message.

#### 8.3 Mood & Momentum Extraction
**Why:** Managers need to sense team energy. The vision describes mood synthesis as a key manager briefing component.

**Implementation:**
```
crm/src/sentiment.ts                — new module
crm/src/tools/sentiment-tools.ts    — manager-only query tools
```

- On every AE message (especially `tipo = 'reflexion'` entries), run lightweight sentiment classification via the LLM
- Store as a new field on `actividad`: `sentiment REAL` (-1.0 to +1.0) and `sentiment_label TEXT` (positive/neutral/negative/frustrated/excited)
- Manager briefing template (`crm/groups/manager.md`) enhanced to include team mood aggregate
- New manager tool: `query_team_mood` — returns sentiment trend for the manager's AEs over N days
- Feed into existing escalation cascade: 3+ consecutive negative sentiments from an AE -> manager alert

**Schema migration:**
```sql
ALTER TABLE actividad ADD COLUMN sentiment REAL;
ALTER TABLE actividad ADD COLUMN sentiment_label TEXT;
```

**Claude Code session:** ~2-3 hours. Sentiment extraction function, schema migration, manager tool, briefing template update, escalation evaluator enhancement, tests.

#### 8.4 Confidence Calibration
**Why:** The #1 trust killer is hallucinated numbers. The agent should express confidence levels, especially on factual claims about inventory, pricing, and quotas.

**Implementation:**
- Not a new module — a **persona and prompting change** across all CLAUDE.md templates
- Add explicit instructions to all role personas:
  - When citing a number from the database: state it directly (high confidence, sourced)
  - When estimating or inferring: prefix with "Based on available data, I estimate..."
  - When information is stale (>24h for inventory, >1 week for contracts): flag staleness
  - When unsure: say "I don't have reliable data on this — let me check" rather than guessing
- Add `data_freshness` metadata to tool responses where applicable (inventory queries, quota queries)

**Claude Code session:** ~1 hour. Update 4 CLAUDE.md persona files, add freshness metadata to key tools.

#### 8.5 Enhanced Morning Briefing
**Why:** The existing briefing is functional. The vision briefing is a strategic partner. Bridge the gap.

**Implementation:**
- Enhance the nightly batch job that prepares briefing context:
  - Include wrap-up reflections from previous day
  - Include client contact recency analysis ("3 clients not contacted in 2+ weeks")
  - Include quota path-to-close projection (not just current standing, but "you need X more this week to stay on track")
  - For managers: include team mood aggregate from sentiment data
  - For directors: include relationship staleness alerts (see Phase 9)
- The briefing is already staggered by role (VP 8:45, Dir 8:52, Mgr 9:00, AE 9:10) — keep this

**Claude Code session:** ~2-3 hours. Enhance briefing data preparation, update briefing prompt templates per role.

#### 8.6 VP Glance Dashboard
**Why:** The VP needs a single-screen, on-demand view of the entire organization. The dashboard infra already exists (REST API + auth + short-code URL delivery). This is about building the right view on top of it.

**Implementation:**
```
crm/src/dashboard/vp-glance.ts      — data aggregation for VP view
crm/src/dashboard/vp-glance.html    — single-page frontend (or extend existing dashboard)
```

**The single screen shows:**
- **Revenue pulse:** annual target vs. actual vs. projection, by quarter
- **Pipeline health:** total active proposals by stage, weighted forecast value, conversion trend
- **Quota heatmap:** every AE's attainment as a color-coded grid (green/yellow/red), rolled up by manager and director
- **Relationship fabric:** top holdings/agencies with warmth indicators (wires into Phase 9 data once available)
- **Alerts & risks:** top 5-10 items needing VP attention
- **Inventory utilization:** tentpole and premium inventory sold vs. available by quarter

**Design constraints:**
- One screen. If it needs more than one scroll, it's too complex.
- Mobile-friendly — VP will open this on their phone from the WhatsApp short-code link
- Auto-refresh or pull-to-refresh, no manual data fetching
- Data freshness timestamps visible

**Claude Code session:** ~3-4 hours. VP aggregation queries, single-page frontend, mobile responsiveness, tests.

---

### PHASE 9: Relationship Intelligence (Weeks 5-8)
> *Goal: The director and VP relationship agenda — the missing dimension*

This is net-new capability. Nothing in the current codebase tracks executive relationships, milestones, or contact opportunities.

#### 9.1 Relationship Schema Extension

**New tables:**
```sql
CREATE TABLE relacion_ejecutiva (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    persona_id INTEGER NOT NULL,
    contacto_id INTEGER NOT NULL,
    nivel TEXT NOT NULL,                   -- 'peer', 'superior', 'subordinate'
    warmth REAL DEFAULT 0.5,
    last_contact_date TEXT,
    last_contact_type TEXT,
    last_contact_summary TEXT,
    strategic_notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (persona_id) REFERENCES persona(id),
    FOREIGN KEY (contacto_id) REFERENCES contacto(id)
);

CREATE TABLE hito_contacto (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contacto_id INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    fecha TEXT NOT NULL,
    descripcion TEXT,
    recurrente INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (contacto_id) REFERENCES contacto(id)
);

CREATE TABLE interaccion_ejecutiva (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    relacion_id INTEGER NOT NULL,
    fecha TEXT NOT NULL,
    tipo TEXT NOT NULL,
    resumen TEXT,
    contexto_comercial TEXT,
    next_action TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (relacion_id) REFERENCES relacion_ejecutiva(id)
);
```

**Claude Code session:** ~1-2 hours. Schema additions, migration logic, tests.

#### 9.2 Relationship Tools (Director/VP)

**New tools module:**
```
crm/src/tools/relationship-tools.ts  — 6-8 new tools
```

| Tool | Role | Description |
|------|------|-------------|
| `log_executive_interaction` | Dir/VP | Record a meeting, call, lunch with an external executive |
| `query_relationship_health` | Dir/VP | Show all relationships sorted by warmth/staleness |
| `query_upcoming_milestones` | Dir/VP | Birthdays, anniversaries, promotions in next N days |
| `add_executive_contact` | Dir/VP | Register a new external executive and link to relationship |
| `add_milestone` | Dir/VP | Add a birthday, anniversary, or other milestone |
| `query_relationship_map` | VP only | Full org-wide relationship fabric view |
| `suggest_contact_opportunity` | Dir/VP | Agent-generated suggestions with commercial context |
| `update_strategic_notes` | Dir/VP | Update the strategic angle for a relationship |

**Warmth computation:**
```typescript
function computeWarmth(lastContact: Date, interactionCount: number, daysSince: number): number {
    const recencyScore = Math.max(0, 1 - (daysSince / 90));
    const frequencyBonus = Math.min(0.3, interactionCount * 0.05);
    return Math.min(1.0, recencyScore + frequencyBonus);
}
```

**Claude Code session:** ~3-4 hours. New tools module, warmth computation, role-based tool registration, tests.

#### 9.3 Relationship-Aware Briefings

- **Director morning briefing** now includes top 3 stalest relationships, upcoming milestones, new executive appointments
- **VP morning briefing** now includes org-wide relationship health, cold relationships with downstream impact, industry events

**New proactive workflow:**
```
crm/src/relationship-monitor.ts      — nightly batch analysis
```

**Claude Code session:** ~2-3 hours. Nightly batch extension, briefing template updates, contact opportunity generation, tests.

#### 9.4 Contacto Table Enhancement

```sql
ALTER TABLE contacto ADD COLUMN es_ejecutivo INTEGER DEFAULT 0;
ALTER TABLE contacto ADD COLUMN titulo TEXT;
ALTER TABLE contacto ADD COLUMN organizacion TEXT;
ALTER TABLE contacto ADD COLUMN linkedin_url TEXT;
ALTER TABLE contacto ADD COLUMN notas_personales TEXT;
ALTER TABLE contacto ADD COLUMN fecha_nacimiento TEXT;
```

**Claude Code session:** ~1 hour. Schema migration, auto-creation of milestone entries for birthdays.

---

### PHASE 10: Workspace Abstraction (Weeks 7-9)
> *Goal: Unified provider interface for Google + Microsoft. Enables SharePoint connector in Phase 12.*

See `docs/WORKSPACE-ABSTRACTION-PLAN.md` for full implementation detail.

- **10.A** — Provider interface + Google refactor (no blocker)
- **10.B** — Schema + config cleanup (column renames, generic terminology)
- **10.C** — Microsoft 365 provider via MS Graph (**blocked on Azure AD app registration**)

---

### PHASE 11: Creative Intelligence (Weeks 9-14) — COMPLETE
> *Goal: The agent thinks commercially — proposing deals, not just tracking them*
> **Status: All 5 sessions complete. +12 tools, +3 tables, 101 new tests.**

#### 11.1 Overnight Analysis Engine (Done)
5 analyzers (calendar, inventory, gap, cross-sell, market), `insight_comercial` table, shared analysis modules (`analysis/media-mix.ts`, `analysis/peer-comparison.ts`), 3 tools (`consultar_insights`, `actuar_insight`, `consultar_insights_equipo`), overnight scheduler (2 AM MX via IPC).

#### 11.2 Proposal Draft Engine (Done)
`borrador_agente` proposal etapa, `proposal-drafter.ts` (value/media derivation from insight data), `convertir` action in `actuar_insight`, 2 tools (`revisar_borrador`, `modificar_borrador`), +2 columns on propuesta (`agente_razonamiento`, `confianza`).

#### 11.3 Cross-Agent Intelligence (Done)
5 pattern detectors (vertical trends, holding movements, inventory conflicts, win/loss correlation, concentration risk), `patron_detectado` table, role-scoped visibility (gerente: coaching, director: assignment, VP: strategy), 2 tools (`consultar_patrones`, `desactivar_patron`).

#### 11.4 Feedback Loop (Done)
`feedback_propuesta` table (draft-vs-final delta tracking), `feedback-engine.ts` (auto-capture on modificar_borrador, learning metrics), 2 tools (`consultar_feedback`, `generar_reporte_aprendizaje`), rubber-stamping detection.

#### 11.5 Creative Package Builder (Done)
`package-builder.ts` — composition logic using historical media mix, peer vertical benchmarks, event inventory availability, and rate cards. Generates primary package + ±20% alternatives with reasoning. 3 tools (`construir_paquete`, `consultar_oportunidades_inventario`, `comparar_paquetes`), all roles.

---

### PHASE 12: Data Connectors (Weeks 10-16, parallel with Phase 11)
> *Goal: Connect the agent to every data source it needs*

#### 12.1 Connector Architecture

```
crm/src/connectors/
    +-- base-connector.ts
    +-- cubo-connector.ts
    +-- sharepoint-connector.ts
    +-- contracts-connector.ts
    +-- inventory-connector.ts
    +-- schedule-connector.ts
```

```typescript
interface CrmConnector {
    name: string;
    healthCheck(): Promise<boolean>;
    sync(): Promise<SyncResult>;
    query(params: QueryParams): Promise<any>;
    lastSyncAt: Date | null;
}
```

#### 12.2 Individual Connectors

| Connector | Priority | Estimated Session |
|-----------|----------|-------------------|
| **Cubo** | P0 | 3-4h |
| **Inventory** | P0 | 3-4h |
| **Contracts** | P1 | 2-3h |
| **Programming Schedule** | P1 | 2-3h |
| **SharePoint** | P2 | 3-4h |

Each connector session starts with a discovery phase.

#### 12.3 Connector-Enriched Briefings

Wire real connector data into briefing engine + overnight analysis.

**Claude Code session:** ~2-3 hours.

---

### PHASE 13: A2A Foundation & External Actions (Weeks 15-20)
> *Goal: Build the protocol layer now, activate later*

#### 13.1 Structured Action Layer

```sql
CREATE TABLE accion_agente (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    persona_id INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    estado TEXT DEFAULT 'pending',
    payload_json TEXT NOT NULL,
    human_approved_at TEXT,
    human_approved_by INTEGER,
    executed_at TEXT,
    result_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (persona_id) REFERENCES persona(id)
);
```

**Claude Code session:** ~3-4 hours. Action layer, approval flow, audit logging, tests.

#### 13.2 REST API Layer

Extends existing dashboard API infra with full CRUD endpoints, JWT auth, role-based scoping.

**Claude Code session:** ~4-5 hours.

#### 13.3 A2A Protocol Readiness

```sql
ALTER TABLE propuesta ADD COLUMN external_ref TEXT;
ALTER TABLE contrato ADD COLUMN external_ref TEXT;
ALTER TABLE actividad ADD COLUMN external_ref TEXT;
```

**Claude Code session:** ~1-2 hours.

---

### PHASE 14: Polish & Scale (Weeks 18-24)
> *Goal: Production hardening for the 70% adoption threshold*

#### 14.1 Adaptive Agent Personality

```sql
CREATE TABLE preferencia_agente (
    persona_id INTEGER PRIMARY KEY,
    verbosidad TEXT DEFAULT 'normal',
    formalidad TEXT DEFAULT 'casual',
    frecuencia_push TEXT DEFAULT 'normal',
    hora_briefing TEXT DEFAULT '09:00',
    hora_wrapup TEXT DEFAULT '18:30',
    notas TEXT,
    FOREIGN KEY (persona_id) REFERENCES persona(id)
);
```

**Claude Code session:** ~2-3 hours.

#### 14.2 LLM Migration Preparation

Progressive path toward self-hosted Qwen 3.5-122B-A10B. Benchmarking harness, prefix caching strategy, vLLM deployment config.

**Claude Code session:** ~2-3 hours.

#### 14.3 Performance & Reliability

Sub-3s latency, batch job monitoring, index optimization, WAL mode, load testing (45 concurrent agents).

**Claude Code session:** ~3-4 hours.

---

## 2. Schema Evolution Summary

| Phase | Tables Added | Columns Added | Status |
|-------|-------------|---------------|--------|
| 8.1 | — | actividad: audio_ref, transcripcion, sentimiento_score, tipo_mensaje | **Done** |
| Hindsight | crm_memories, crm_fts_embeddings | — | **Done** |
| 9 | relacion_ejecutiva, hito_contacto, interaccion_ejecutiva | contacto: es_ejecutivo, titulo, organizacion, linkedin_url, notas_personales, fecha_nacimiento | **Done** |
| Approvals | aprobacion_registro | cuenta/contacto: estado, creado_por, fecha_activacion | **Done** |
| 11.1-11.2 | insight_comercial | propuesta: agente_razonamiento, confianza | **Done** |
| 11.3 | patron_detectado | — | **Done** |
| 11.4 | feedback_propuesta | — | **Done** |
| 13.1 | accion_agente | — | Planned |
| 13.3 | — | propuesta, contrato, actividad: external_ref | Planned |
| 14.1 | preferencia_agente | — | Planned |

**Done: 25 tables (was 15). Remaining: +2 tables in Phases 13-14. Final target: 27 tables.**

---

## 3. Architectural Invariants

These rules hold across ALL phases:

1. **`engine/` is never modified.** All CRM code lives in `crm/`. Period.
2. **Schema migrations are additive.** ALTER TABLE ADD COLUMN, CREATE TABLE. Never DROP or modify existing columns.
3. **Tools follow the existing registration pattern.** Every new tool goes through the same inference adapter as the existing 64.
4. **Role scoping is mandatory.** Every new tool, endpoint, and data query respects the hierarchy in `hierarchy.ts`.
5. **Tests accompany every change.** No session ends without tests for the new code.
6. **CLAUDE.md personas are updated with every capability change.** A tool the agent doesn't know about is a tool that doesn't exist.
7. **External actions require human approval.** No exceptions in any phase.
8. **All data has provenance.** Every number the agent cites should be traceable to a source table and timestamp.

---

## 4. Claude Code Session Map

| # | Session | Phase | Est. Hours | Status |
|---|---------|-------|-----------|--------|
| 1 | Voice transcription pipeline | 8.1 | 2-3h | **Done** |
| 2 | EOD wrap-up workflow | 8.2 | 1-2h | **Done** |
| 3 | Sentiment extraction + manager tools | 8.3 | 2-3h | **Done** |
| 4 | Confidence calibration (persona updates) | 8.4 | 1h | **Done** |
| 5 | Enhanced morning briefings | 8.5 | 2-3h | **Done** |
| 6 | VP Glance Dashboard | 8.6 | 3-4h | **Done** |
| 7 | Relationship schema + migration | 9.1 | 1-2h | **Done** |
| 8 | Relationship tools (Dir/VP) | 9.2 | 3-4h | **Done** |
| 9 | Relationship-aware briefings + nightly monitor | 9.3 | 2-3h | **Done** |
| 10 | Contacto enhancement + milestones | 9.4 | 1h | **Done** |
| — | Record creation approval workflow | Approvals | 3-4h | **Done** |
| — | Circuit breaker + Hindsight memory + hybrid RAG | Hindsight | 4-5h | **Done** |
| 11.1 | Overnight analysis engine | 11.1 | 4-5h | **Done** |
| 11.2 | Proposal draft engine | 11.2 | 3-4h | **Done** |
| 11.3 | Cross-agent intelligence | 11.3 | 3-4h | **Done** |
| 11.4 | Feedback loop | 11.4 | 2-3h | **Done** |
| 11.5 | Creative package builder | 11.5 | 3-4h | **Done** |
| 10.A | Workspace abstraction: provider interface + Google refactor | 10.A | 3-4h | — |
| 10.B | Workspace abstraction: schema + config cleanup | 10.B | 1-2h | — |
| 10.C | Workspace abstraction: Microsoft 365 provider | 10.C | 4-5h | Blocked |
| 14 | Connector architecture | 12.1 | 2h | — |
| 15 | Cubo connector | 12.2a | 3-4h | Session 14 |
| 16 | Inventory connector | 12.2b | 3-4h | Session 14 |
| 17 | Contracts connector | 12.2c | 2-3h | Session 14 |
| 18 | Programming schedule connector | 12.2d | 2-3h | Session 14 |
| 19 | SharePoint connector (RAG extension) | 12.2e | 3-4h | Session 14 |
| 20 | Connector-enriched briefings | 12.3 | 2-3h | Sessions 15-19 |
| 21 | Structured action layer + approval flow | 13.1 | 3-4h | Phase 8 complete |
| 22 | REST API layer | 13.2 | 4-5h | Session 21 |
| 23 | A2A protocol readiness | 13.3 | 1-2h | Session 22 |
| 24 | Adaptive personality | 14.1 | 2-3h | Phase 8 complete |
| 25 | LLM migration prep | 14.2 | 2-3h | None |
| 26 | Performance & reliability | 14.3 | 3-4h | All phases |

**Total: ~65-85 hours of Claude Code sessions across ~26 focused blocks.**

---

*This plan is designed to be executed session by session with Claude Code. Each session is scoped, has clear inputs/outputs, and builds on what came before. Start with Session 1.*
