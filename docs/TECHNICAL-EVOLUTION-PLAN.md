# Pulso: Technical Evolution Plan

## From crm-azteca to the Cognitive Exoskeleton

**March 2026 — Claude Code execution guide**
**Companion to: VISION.md**

---

## 0. Where We Are vs. Where We're Going

The crm-azteca repo is already a working agentic CRM with substantial infrastructure. This plan is not a rewrite — it's a **targeted evolution** that transforms a capable system into the organizational nervous system described in VISION.md.

### What Already Exists (crm-azteca @ 48 commits)

| Layer | What's Built | Files |
|-------|-------------|-------|
| **Schema** | 17 SQLite tables: persona, cuenta, contacto, contrato, descarga, propuesta, actividad, cuota, inventario, alerta_log, email_log, evento_calendario, crm_events, crm_documents, crm_embeddings, crm_vec_embeddings | `crm/src/schema.ts` |
| **Tools** | 31 tools across 17 modules — activity logging, pipeline mgmt, Google Workspace (Gmail, Drive, Calendar), event tracking, RAG search (sqlite-vec), web search (Brave), analytics, cross-sell, swarm analysis, follow-up reminders | `crm/src/tools/` |
| **Hierarchy** | Full org chart traversal + role-based access control (AE/Manager/Director/VP) | `crm/src/hierarchy.ts` |
| **Proactive workflows** | Morning briefings (staggered by role), weekly summaries, hourly follow-up reminders, alert evaluation (6 evaluators + event countdown), document sync (Drive -> RAG) | `crm/src/briefing-seeds.ts`, `crm/src/alerts.ts`, `crm/src/followup-scheduler.ts` |
| **Escalation** | Real-time cascade on activity insertion: AE->Manager->Director->VP with 4 evaluators | `crm/src/escalation.ts` |
| **RAG** | sqlite-vec KNN search, Dashscope text-embedding-v3 (1024d), Google Drive sync pipeline | `crm/src/doc-sync.ts`, `crm/src/embedding.ts` |
| **Dashboard** | REST API with auth + 6 endpoints, short-code WhatsApp delivery | `crm/src/dashboard/` |
| **Infra** | Container builds, systemd services, crm-ctl CLI, IPC handlers, team registration (CSV/JSON) | various |
| **Tests** | 481 tests across 22 files | `crm/tests/` |
| **Personas** | CLAUDE.md templates per role (AE, Manager, Director, VP) | `crm/groups/` |

### What the Vision Demands That Doesn't Exist Yet

| Vision Capability | Gap | Complexity |
|------------------|-----|------------|
| **Voice-first input** | No voice note transcription pipeline | Medium |
| **Overnight analysis -> autonomous proposals** | Briefings exist but don't generate proposals | High |
| **End-of-day wrap-up** | No scheduled EOD workflow | Low |
| **Relationship Intelligence Engine** | No executive relationship tracking (milestones, warmth, contact opportunities) | High |
| **Mood & momentum tracking** | No sentiment extraction from AE interactions | Medium |
| **Enhanced client knowledge graph** | contacto table exists but lacks structured relationship intelligence | Medium |
| **External data connectors** | Only Google Workspace + Brave. Missing: cubo, SharePoint, contracts, inventory, programming schedule | High (per connector) |
| **Creative package builder** | Cross-sell recommendations exist but no inventory-optimized package composition | High |
| **Cross-agent intelligence** | Escalation cascade exists but no lateral intelligence sharing between peer agents | Medium |
| **A2A protocol foundation** | No structured API for machine-to-machine interaction | Medium |
| **Confidence calibration** | Agent doesn't express uncertainty levels on suggestions | Low |
| **Adaptive personality** | Same persona for all AEs regardless of their style | Low |

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

### PHASE 11: Creative Intelligence (Weeks 9-14)
> *Goal: The agent thinks commercially — proposing deals, not just tracking them*

#### 11.1 Overnight Analysis Engine

**Nightly pipeline (runs 2-4 a.m.):**
1. Quota gap analysis per AE
2. Client opportunity scan (renewals, underspent contracts, descarga gaps, category matches)
3. Inventory opportunity matching
4. Proposal drafting (top 2-3 opportunities per AE, stored as `propuesta.estado = 'borrador_agente'`)

```sql
ALTER TABLE propuesta ADD COLUMN agente_razonamiento TEXT;
ALTER TABLE propuesta ADD COLUMN confianza REAL;
```

**Claude Code session:** ~4-5 hours. Overnight orchestrator, opportunity matching, proposal generation, schema migration, tests.

#### 11.2 Creative Package Builder

```
crm/src/package-builder.ts           — combinatorial package logic
crm/src/tools/package-tools.ts       — AE/Manager tools
```

New tools: `build_package`, `query_inventory_opportunities`, `compare_packages`

**Claude Code session:** ~3-4 hours. Package composition logic, tools, tests.

#### 11.3 Cross-Agent Intelligence

```
crm/src/cross-intelligence.ts        — pattern detection engine
```

Patterns: holding-level shifts, category trends, competitive signals, win/loss patterns.

```sql
CREATE TABLE patron_detectado (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    datos_json TEXT,
    personas_afectadas TEXT,
    nivel_minimo TEXT,
    fecha_deteccion TEXT DEFAULT (datetime('now')),
    activo INTEGER DEFAULT 1
);
```

**Claude Code session:** ~3-4 hours. Pattern detection, new table, briefing injection, tests.

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

| Phase | Tables Added | Columns Added |
|-------|-------------|---------------|
| 8.1 | — | actividad: audio_ref, transcription |
| 8.3 | — | actividad: sentiment, sentiment_label |
| 9.1 | relacion_ejecutiva, hito_contacto, interaccion_ejecutiva | — |
| 9.4 | — | contacto: es_ejecutivo, titulo, organizacion, linkedin_url, notas_personales, fecha_nacimiento |
| 11.1 | — | propuesta: agente_razonamiento, confianza |
| 11.3 | patron_detectado | — |
| 13.1 | accion_agente | — |
| 13.3 | — | propuesta, contrato, actividad: external_ref |
| 14.1 | preferencia_agente | — |

**Total: 6 new tables, ~15 new columns. Schema grows from 17 to 23 tables.**

---

## 3. Architectural Invariants

These rules hold across ALL phases:

1. **`engine/` is never modified.** All CRM code lives in `crm/`. Period.
2. **Schema migrations are additive.** ALTER TABLE ADD COLUMN, CREATE TABLE. Never DROP or modify existing columns.
3. **Tools follow the existing registration pattern.** Every new tool goes through the same inference adapter as the existing 31.
4. **Role scoping is mandatory.** Every new tool, endpoint, and data query respects the hierarchy in `hierarchy.ts`.
5. **Tests accompany every change.** No session ends without tests for the new code.
6. **CLAUDE.md personas are updated with every capability change.** A tool the agent doesn't know about is a tool that doesn't exist.
7. **External actions require human approval.** No exceptions in any phase.
8. **All data has provenance.** Every number the agent cites should be traceable to a source table and timestamp.

---

## 4. Claude Code Session Map

| # | Session | Phase | Est. Hours | Dependencies |
|---|---------|-------|-----------|--------------|
| 1 | Voice transcription pipeline | 8.1 | 2-3h | None |
| 2 | EOD wrap-up workflow | 8.2 | 1-2h | None |
| 3 | Sentiment extraction + manager tools | 8.3 | 2-3h | Session 2 |
| 4 | Confidence calibration (persona updates) | 8.4 | 1h | None |
| 5 | Enhanced morning briefings | 8.5 | 2-3h | Sessions 2, 3 |
| 6 | VP Glance Dashboard | 8.6 | 3-4h | None |
| 7 | Relationship schema + migration | 9.1 | 1-2h | None |
| 8 | Relationship tools (Dir/VP) | 9.2 | 3-4h | Session 7 |
| 9 | Relationship-aware briefings + nightly monitor | 9.3 | 2-3h | Sessions 7, 8 |
| 10 | Contacto enhancement + milestones | 9.4 | 1h | Session 7 |
| 10.A | Workspace abstraction: provider interface + Google refactor | 10.A | 3-4h | None |
| 10.B | Workspace abstraction: schema + config cleanup | 10.B | 1-2h | Session 10.A |
| 10.C | Workspace abstraction: Microsoft 365 provider | 10.C | 4-5h | 10.A + Azure AD |
| 11 | Overnight analysis engine | 11.1 | 4-5h | Phase 8 complete |
| 12 | Creative package builder | 11.2 | 3-4h | Session 11 |
| 13 | Cross-agent intelligence | 11.3 | 3-4h | Session 11 |
| 14 | Connector architecture | 12.1 | 2h | None |
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
