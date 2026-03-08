# Agentic CRM

An agentic CRM for media ad sales teams. AI agents that do the CRM work for your sales team.

## How It Works

Salespeople chat with AI agents via WhatsApp. Each person gets a personal CRM assistant that:

- **Logs interactions** — After every client call, the AE tells their agent what happened. The agent logs it, updates deal stages, and flags follow-ups.
- **Tracks quotas** — Agents know each AE's weekly quota and proactively surface pipeline gaps.
- **Manages email** — Search inbox, read messages, draft replies — all through the chat.
- **Handles scheduling** — Creates calendar events, sets follow-up reminders, delivers morning briefings.
- **Searches documents** — RAG pipeline with sqlite-vec indexes Google Drive files for semantic vector search (Dashscope text-embedding-v3, 1024d), scoped by hierarchy.
- **Escalates risks** — When quota is critically low, negative patterns emerge, or mega-deals stall, the agent escalates up the chain (AE → Manager → Director → VP).

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
WhatsApp → engine (NanoClaw) → Direct tools (29 CRM tools via inference adapter)
                                    ├── Role-based tool filtering
                                    ├── Google Workspace (Gmail, Drive, Calendar)
                                    ├── RAG search (sqlite-vec KNN + text-embedding-v3)
                                    ├── Web search (Brave API)
                                    └── CRM CLAUDE.md (persona + schema + rules)
```

### Data Model

16 SQLite tables: `persona`, `cuenta`, `contacto`, `contrato`, `descarga`, `propuesta`, `actividad`, `cuota`, `inventario`, `alerta_log`, `email_log`, `evento_calendario`, `crm_events`, `crm_documents`, `crm_embeddings`, `crm_vec_embeddings` (sqlite-vec virtual table for KNN search).

### Tools by Role

| Role | Tools | Examples |
|------|-------|---------|
| AE | 28 | Log activities, manage deals, send emails, set reminders, search docs, web search, analytics, cross-sell |
| Manager | 20 | Team pipeline, quota rollups, coaching briefings, email, docs, web search, analytics, cross-sell |
| Director | 19 | Regional analytics, event tracking, email, docs, web search, win/loss trends, cross-sell |
| VP | 18 | Executive dashboards, cross-region visibility, docs, web search, org-wide analytics, cross-sell |

29 unique tools total across activity logging, pipeline management, Google Workspace (Gmail, Drive, Calendar), event tracking, document search (RAG with sqlite-vec), web search, historical analytics, cross-sell recommendations, and follow-up reminders.

### Proactive Workflows

Scheduled tasks run automatically, staggered by role to prevent thundering herd:

| Workflow | Schedule | Roles |
|----------|----------|-------|
| Morning briefing | Weekdays (VP 8:45, Dir 8:52, Mgr 9:00, AE 9:10) | All |
| Weekly summary | Friday 4pm | AE |
| Follow-up reminders | Hourly 9-6 weekdays | AE |
| Alert evaluation | Every 2 hours | All (6 evaluators + event countdown) |
| Document sync | Daily 3am | All (Google Drive → RAG index) |

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
│   │   ├── schema.ts         # 16 CRM tables (incl. sqlite-vec virtual table)
│   │   ├── bootstrap.ts      # Schema init + hooks
│   │   ├── hierarchy.ts      # Org chart traversal + access control
│   │   ├── tools/            # 29 tools across 13 modules
│   │   ├── alerts.ts         # 6 alert evaluators + event countdown
│   │   ├── escalation.ts     # 4 real-time escalation evaluators
│   │   ├── embedding.ts      # Dashscope text-embedding-v3 API + local fallback
│   │   ├── doc-sync.ts       # RAG pipeline (chunk → embed → sqlite-vec KNN search)
│   │   ├── register.ts       # Batch team registration (CSV/JSON)
│   │   ├── briefing-seeds.ts # Staggered scheduled briefings
│   │   ├── google-auth.ts    # Google Workspace JWT auth (6 clients)
│   │   ├── ipc-handlers.ts   # 6 IPC task types
│   │   └── followup-scheduler.ts  # Business-hours reminder scheduler
│   ├── container/       # CRM container image (extends engine)
│   ├── groups/          # CLAUDE.md templates per role (ae, manager, director, vp)
│   └── tests/           # 400 tests across 18 test files
├── scripts/             # Bootstrap, registration, data import
├── docs/                # Architecture, deployment, upstream sync
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
npm run test             # Run all tests (400 CRM tests)
npm run bootstrap        # First-time CRM setup
npm run register-team    # Register team from CSV/JSON
npm run build:container  # Build CRM container (extends engine image)
```

## Engine

This project is powered by [NanoClaw](https://github.com/qwibitai/nanoclaw), an open-source platform for building AI agent systems on WhatsApp. NanoClaw handles the messaging infrastructure, container isolation, and agent orchestration. The CRM layer adds sales-specific schema, tools, personas, and hierarchy management on top.

The engine lives at `engine/` as a git subtree. See [docs/UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md) for how to pull updates.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — Full CRM design (17 sections)
- [Project Status](docs/PROJECT-STATUS.md) — Current phase tracker, blockers, metrics
- [Deployment](docs/DEPLOYMENT.md) — AWS EC2 setup, systemd, backups
- [Upstream Sync](docs/UPSTREAM-SYNC.md) — Pulling NanoClaw updates
