# Pulso — Agentic CRM

The cognitive exoskeleton for broadcast ad sales. AI agents embedded in WhatsApp that do the CRM work for your sales team.

## How It Works

Salespeople chat with AI agents via WhatsApp. Each person gets a personal CRM assistant that:

- **Logs interactions** — After every client call, the AE tells their agent what happened. The agent logs it, updates deal stages, and flags follow-ups. Voice notes are transcribed automatically.
- **Tracks quotas** — Agents know each AE's weekly quota and proactively surface pipeline gaps.
- **Manages email** — Search inbox, read messages, draft replies — all through the chat.
- **Handles scheduling** — Creates calendar events, sets follow-up reminders, delivers morning briefings.
- **Searches documents** — Hybrid RAG pipeline with sqlite-vec + FTS5 keyword search and reciprocal rank fusion. Google Drive files indexed for semantic vector search (Dashscope text-embedding-v3, 1024d), scoped by hierarchy.
- **Remembers context** — Long-term memory via Hindsight sidecar (3 banks) or SQLite fallback. Agents remember past interactions, account history, and team dynamics across conversations.
- **Escalates risks** — When quota is critically low, negative patterns emerge, or mega-deals stall, the agent escalates up the chain (AE → Manager → Director → VP).
- **Thinks commercially** — Overnight analysis engine (6 analyzers) generates insights, draft proposals, and cross-agent pattern detection (vertical overlap, holding groups, inventory concentration, win/loss trends). A feedback loop tracks draft-vs-final edits so the system learns.
- **Builds packages** — Creative package composition using historical media mix, peer benchmarks, and live inventory data with rate cards.
- **Gates data quality** — Approval workflows for record creation. Managers review and approve/reject/contest registrations before they enter the pipeline.
- **Tracks relationships** — Executive relationship warmth scoring (recency + frequency + quality) with milestones, interaction history, and nightly recomputation. Director/VP-level tools.
- **Serves dashboards** — On-demand web dashboards per role with hierarchical quota views, pipeline funnels, at-risk deals, and alerts. Links delivered via WhatsApp with short-code URLs.

## Architecture

The system mirrors the org chart:

```
VP of Sales
├── Director (Region A)
│   ├── Manager (Team 1)
│   │   ├── AE 1  ←→  Personal WhatsApp group + AI agent
│   │   ├── AE 2  ←→  Personal WhatsApp group + AI agent
│   │   └── ...
│   ├── Manager (Team 2)
│   │   └── ...
│   └── Manager Team Group  ←→  AI agent (coaching, rollups)
├── Director (Region B)
│   └── ...
├── Director Team Group  ←→  AI agent (strategic insights)
└── VP Team Group  ←→  AI agent (chief of staff)
```

For a team of 50 salespeople, this creates ~68 WhatsApp groups, each with an isolated AI agent that has role-appropriate access to CRM data.

### Message Flow

```
WhatsApp → engine (NanoClaw) → Direct tools (71 CRM tools via inference adapter)
                                    ├── Role-based tool filtering (AE:51, Ger:55, Dir:66, VP:64)
                                    ├── Google Workspace (Gmail, Drive, Calendar, Slides, Sheets)
                                    ├── Hybrid RAG (sqlite-vec KNN + FTS5 keyword + RRF fusion)
                                    ├── Long-term memory (Hindsight sidecar or SQLite fallback)
                                    ├── Relationship intelligence (Dir/VP: warmth, milestones)
                                    ├── Web search (Brave API)
                                    └── CRM CLAUDE.md (persona + schema + rules + date/time)
```

### Data Model

28 SQLite tables across the CRM layer:

**Core (15):** `persona`, `cuenta`, `contacto`, `contrato`, `descarga`, `propuesta`, `actividad`, `cuota`, `inventario`, `alerta_log`, `email_log`, `evento_calendario`, `crm_events`, `crm_documents`, `crm_memories`

**Search (3):** `crm_embeddings`, `crm_vec_embeddings` (sqlite-vec virtual), `crm_fts_embeddings` (FTS5 virtual)

**Relationships (3):** `relacion_ejecutiva`, `interaccion_ejecutiva`, `hito_contacto`

**Intelligence (5):** `aprobacion_registro`, `insight_comercial`, `patron_detectado`, `feedback_propuesta`, `perfil_usuario`

**Template evolution (2):** `template_score`, `template_variant`

### Tools by Role

| Role     | Tools | Capabilities                                                                                                                                                                  |
| -------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AE       | 51    | Log activities, manage deals, send emails, set reminders, search docs, web search, analytics, cross-sell, memory, user profile, approval requests, view insights/drafts       |
| Manager  | 55    | Team pipeline, quota rollups, coaching briefings, email, docs, web search, analytics, cross-sell, swarm analysis, approve/reject registrations, team insights, memory, Jarvis |
| Director | 66    | All manager tools + relationship intelligence (warmth, milestones, interactions), team pattern analysis, cross-agent insights, Drive creation (docs, sheets, slides), Jarvis  |
| VP       | 64    | Executive dashboards, org-wide visibility, relationship intelligence, cross-agent patterns, strategic insights, Drive creation, full analytics, Jarvis                        |

71 unique tools total across activity logging, pipeline management, Google Workspace (Gmail, Drive, Calendar, Slides, Sheets), event tracking, document search (hybrid RAG), web search, historical analytics, cross-sell recommendations, parallel swarm analysis, follow-up reminders, long-term memory, approval workflows, commercial insights, pattern detection, package building, feedback tracking, user profiles, relationship intelligence, and Jarvis strategic analysis.

### Proactive Workflows

Scheduled tasks run automatically, staggered by role to prevent thundering herd:

| Workflow             | Schedule                                        | Roles                                               |
| -------------------- | ----------------------------------------------- | --------------------------------------------------- |
| Morning briefing     | Weekdays (VP 8:45, Dir 8:52, Mgr 9:00, AE 9:10) | All                                                 |
| Weekly summary       | Friday 4pm                                      | AE                                                  |
| Follow-up reminders  | Hourly 9-6 weekdays                             | AE                                                  |
| Alert evaluation     | Every 2 hours                                   | All (8 evaluators incl. event countdown)            |
| Document sync        | Daily 3am                                       | All (Google Drive → RAG index)                      |
| Overnight analysis   | Nightly                                         | All (6 commercial analyzers + cross-agent patterns) |
| Warmth recomputation | Daily 4am                                       | Dir/VP (executive relationship scores)              |

### Escalation Cascade

Real-time escalation triggered on every activity insertion:

```
AE quota < 50%           → Manager notified
3+ negative sentiments   → Manager coaching signal
Entire team < 70% quota  → Director pattern alert
3+ stalled mega-deals    → VP systemic risk warning
```

## Project Structure

```
agentic-crm/
├── engine/              # NanoClaw — the AI agent platform (git subtree)
├── crm/
│   ├── src/
│   │   ├── schema.ts              # 28 CRM tables (incl. sqlite-vec, FTS5, template evolution)
│   │   ├── bootstrap.ts           # Schema init + hooks
│   │   ├── hierarchy.ts           # Org chart traversal + access control
│   │   ├── tools/                 # 71 tools across 20+ modules
│   │   │   ├── index.ts           # Tool registry + role-based filtering
│   │   │   ├── gmail.ts           # Email search, read, draft
│   │   │   ├── drive.ts           # Drive list, read, create docs/sheets/slides
│   │   │   ├── calendar.ts        # Calendar events
│   │   │   ├── relaciones.ts      # 7 Dir/VP relationship tools
│   │   │   ├── memoria.ts         # 3 memory tools (save, search, reflect)
│   │   │   ├── aprobaciones.ts    # 6 approval workflow tools
│   │   │   ├── insight-tools.ts   # 5 insight/draft tools
│   │   │   ├── package-tools.ts   # 3 package builder tools
│   │   │   ├── perfil.ts          # User profile management
│   │   │   └── ...                # analytics, swarm, crosssell, patterns, feedback
│   │   ├── alerts.ts              # 8 alert evaluators + event countdown
│   │   ├── escalation.ts          # 4 real-time escalation evaluators
│   │   ├── doc-sync.ts            # Hybrid RAG (chunk → embed → sqlite-vec KNN + FTS5 + RRF)
│   │   ├── embedding.ts           # Dashscope text-embedding-v3 API + local fallback
│   │   ├── memory/                # Pluggable memory service (Hindsight or SQLite fallback)
│   │   ├── workspace/             # WorkspaceProvider interface + Google implementation
│   │   ├── overnight-engine.ts    # 6 overnight commercial analyzers
│   │   ├── cross-intelligence.ts  # 5 cross-agent pattern detectors
│   │   ├── proposal-drafter.ts    # Insight → draft proposal generation
│   │   ├── package-builder.ts     # Creative package composition
│   │   ├── feedback-engine.ts     # Draft-vs-final delta tracking for learning
│   │   ├── warmth.ts              # Executive relationship warmth scoring
│   │   ├── warmth-scheduler.ts    # Nightly warmth recomputation (4 AM MX)
│   │   ├── circuit-breaker.ts     # Reusable circuit breaker (inference, embedding, Hindsight)
│   │   ├── analysis/              # Shared analysis (peer-comparison, media-mix, map-reduce)
│   │   ├── ipc-handlers.ts        # 10 IPC task types
│   │   ├── register.ts            # Batch team registration (CSV/JSON)
│   │   ├── briefing-seeds.ts      # Staggered scheduled briefings
│   │   ├── followup-scheduler.ts  # Business-hours reminder scheduler
│   │   ├── dashboard/             # REST API dashboard (auth + 7 endpoints)
│   │   └── template-selector.ts   # Template evolution (A/B variant tracking)
│   ├── container/       # CRM container image (extends engine)
│   ├── groups/          # CLAUDE.md templates per role (ae, manager, director, vp)
│   └── tests/           # 1119 tests across 61 test files
├── scripts/             # Bootstrap, registration, data import
├── docs/                # Vision, roadmap, competitive assessment
└── groups/              # Live group folders (created at runtime)
```

## Getting Started

1. **Clone and install**

   ```bash
   git clone https://github.com/kosm1x/agentic-crm.git
   cd agentic-crm
   npm install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   # Edit .env with your API keys and settings
   ```

3. **Bootstrap the CRM**

   ```bash
   npm run bootstrap
   ```

4. **Register your team**

   ```bash
   npm run register-team -- --file team.csv
   ```

   Supports CSV and JSON. CSV format:

   ```
   name,role,phone,email,google_calendar_id,manager_name
   Ana Lopez,vp,+521234567890,ana@company.com,,
   Carlos Ruiz,director,+521234567891,carlos@company.com,,Ana Lopez
   ```

5. **Start the system**
   ```bash
   npm run dev
   ```

## Development

```bash
npm run dev              # Run with hot reload (tsx watch)
npm run build            # Compile TypeScript
npm run typecheck        # Type check
npm run test             # Run all tests (1119 across 61 files)
npm run bootstrap        # First-time CRM setup
npm run register-team    # Register team from CSV/JSON
npm run build:container  # Build CRM container (extends engine image)
```

## Engine

The agent runtime at `engine/` was originally subtree'd from [NanoClaw](https://github.com/qwibitai/nanoclaw), an open-source platform for building AI agent systems on WhatsApp. NanoClaw provides the core messaging infrastructure, container isolation, and agent orchestration; the CRM layer adds sales-specific schema, tools, personas, and hierarchy management on top.

As of 2026-04-26 the engine is a **permanent fork** — upstream has diverged into a v2 architecture incompatible with the CRM glue, and we no longer pull updates. See [docs/ENGINE-EVOLUTION-2026-04-26.md](docs/ENGINE-EVOLUTION-2026-04-26.md) for the rationale + roadmap.

## Documentation

- [Vision](docs/VISION.md) — The Pulso vision: design principles, day-in-the-life scenarios, adoption strategy
- [Technical Evolution Plan](docs/TECHNICAL-EVOLUTION-PLAN.md) — 6-phase roadmap from current state to full cognitive exoskeleton
- [Project Status](docs/PROJECT-STATUS.md) — Phase tracker (Phases 1-11 complete, 12-14 planned), session breakdown, metrics
- [Competitive Assessment](docs/COMPETITIVE-ASSESSMENT.md) — Honest goalpost tracker vs Salesforce Agentforce
- [Workspace Abstraction Plan](docs/WORKSPACE-ABSTRACTION-PLAN.md) — Google Workspace refactor + future Microsoft 365 support
- [Engine Evolution](docs/ENGINE-EVOLUTION-2026-04-26.md) — Fork ownership + 3-phase plan for the engine

Historical design documents (superseded by implementation) are in [docs/archive/](docs/archive/).
