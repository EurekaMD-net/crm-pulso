# Agentic CRM Architecture — Full Design

## Context

Build a CRM for a media company (~50 salespeople) selling advertising across linear (TV, radio) and non-linear (CTV, digital video, online) media. The sales cycle has two nested layers:

1. **Upfront**: Annual budget commitment negotiation with brands/agencies
2. **Scatter**: Week-by-week fulfillment of that commitment through packages and offers

Reps communicate with clients and agencies via WhatsApp, email, and phone. Today they're supposed to manually log everything to a CRM — they don't. The AI agent should **do the CRM work for them**: capture interactions from natural language, track quotas, suggest deals, and alert when action is needed.

**Key decisions**: The agentic CRM is the system of record (no existing CRM). Each person gets a private WhatsApp chat with the agent + team groups by hierarchy level. Reps tell the agent what happened after calls/meetings (including voice notes). Agent is NOT in client conversations.

**Organizational hierarchy**: 1 VP of Sales → 4 Directors → 12 Managers → ~33 Account Executives. Each level has a different agent persona and workflow. Risk flows up, coaching flows down, all mediated through the shared CRM database.

---

## Architecture Overview

```
1 VP  →  4 Directors  →  12 Managers  →  ~33 AEs
Each has a private WhatsApp chat (requiresTrigger: false)
Plus team groups at each hierarchy level (~67 groups total)
    | voice notes / texts / voice messages
Engine orchestrator (single process, SQLite DB)
    | routes to per-person containers
Claude Agent (in container, with CRM MCP tools)
    | extracts structured data, logs via IPC
Host processes CRM writes → SQLite CRM tables
    | scheduled tasks run proactive workflows per level
Briefings, escalations, coaching intel, risk alerts → WhatsApp
```

**What the engine (NanoClaw) already provides**: per-group isolation, container sandboxing, IPC, task scheduling, message routing, session persistence, voice transcription skill.

**What the CRM layer adds**: CRM data model (SQLite tables), CRM MCP tools (write via IPC, read via sqlite3 in bash), CLAUDE.md sales playbook with per-level personas, hierarchical scheduled workflows, escalation cascade, agent swarm anticipation.

---

## 1. Data Model — CRM SQLite Tables

All tables added to the existing `store/messages.db` alongside the engine's core tables. `rep_folder` (= engine `group_folder`) is the foreign key linking CRM records to the group system.

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `crm_people` | Rep profiles & team structure | `group_folder` (PK), name, team, role, manager_folder |
| `crm_accounts` | Brands, agencies, manufacturers | id, name, type, parent_account_id, status |
| `crm_contacts` | People at accounts | id, account_id, name, title, role (decision_maker/buyer/planner) |
| `crm_interactions` | Call/meeting/email logs | id, account_id, contact_id, person_id, type, summary, raw_input, sentiment, next_steps (JSON), logged_at |
| `crm_tasks_crm` | Follow-ups extracted from interactions | id, interaction_id, person_id, description, due_date, status, priority |
| `crm_opportunities` | Deals in pipeline | id, account_id, person_id, name, type (upfront/scatter/direct), media_types (JSON), stage, revenue_amount, close_date |
| `crm_quotas` | Multi-dimensional targets | id, person_id, period_type (weekly/monthly/quarterly/event), period_start, period_end, target_amount, achieved_amount |
| `crm_events` | World Cup, Liga MX, etc. | id, name, start_date, end_date, total_inventory (JSON), sold_inventory (JSON), revenue_target, priority |
| `crm_media_types` | Available media products | id, name, category, description, base_price |
| `crm_proposals` | Packages sent to clients | id, opportunity_id, account_id, person_id, line_items (JSON), total_value, status (draft/sent/accepted/rejected) |
| `crm_activity_log` | Audit trail | id, person_id, group_folder, action, entity_type, entity_id, details, created_at |
| `crm_documents` | Document metadata for RAG (Phase 7) | id, source, title, doc_type, content_hash, chunk_count, last_synced |
| `crm_embeddings` | Vector embeddings for semantic search (Phase 7) | id, document_id, chunk_index, content, embedding |

**Fuzzy account matching**: `findAccountFuzzy(name)` uses normalized LIKE matching (strip "Inc.", "LLC", "S.A. de C.V.", case-insensitive). The agent can also query accounts directly and resolve ambiguity conversationally.

---

## 2. Group Architecture — Hierarchical

### Hierarchy Map

```
1 VP of Sales
├── 4 Directors (each oversees 3 Managers)
│   ├── 12 Managers (each oversees ~3 AEs)
│   │   └── ~33 Account Executives
```

### Group Types (~67 groups total)

```
main                        → System admin (full powers, IT/ops)
vp-{name}                  → VP private chat (1)
dir-{name}                 → Director private chats (4)
mgr-{name}                 → Manager private chats (12)
ae-{name}                  → AE private chats (~33)
team-mgr-{manager}         → Manager + their AEs (12 groups, ~4 people each)
team-dir-{director}        → Director + their Managers (4 groups, ~4 people each)
team-vp                    → VP + all Directors (1 group, 5 people)
```

**Total**: 1 main + 50 private chats + 12 manager-team + 4 director-team + 1 VP-team = **~68 groups**

### Private Chats (`requiresTrigger: false`)

Every person at every level has a private 1:1 chat with the agent. Every message is processed — no @mention needed. The agent persona differs by level:

| Level | Folder Pattern | Agent Persona | Primary Function |
|-------|---------------|---------------|-----------------|
| AE | `ae-{name}` | Personal CRM assistant | Log interactions, check quotas, get deal suggestions |
| Manager | `mgr-{name}` | Coaching console | Team performance, AE risk alerts, coaching suggestions |
| Director | `dir-{name}` | Strategic advisor | Cross-team patterns, pipeline intelligence, escalation triage |
| VP | `vp-{name}` | Chief of staff | Organization-wide view, strategic risks, board-ready summaries |

### Team Groups (`requiresTrigger: true`)

Team groups require @mention to trigger the agent. They serve as shared spaces for transparency and collaboration.

| Group | Members | Purpose |
|-------|---------|---------|
| `team-mgr-{name}` | 1 Manager + ~3 AEs | Daily coordination, shared pipeline visibility, team announcements |
| `team-dir-{name}` | 1 Director + 3 Managers | Cross-team coordination, manager sync, escalated issues |
| `team-vp` | VP + 4 Directors | Executive alignment, strategic decisions, org-wide issues |

### Registration & Concurrency

**Batch registration** via main group: admin sends structured hierarchy list → agent registers all ~50 people, creates folders, writes per-level CLAUDE.md files, links hierarchy in `crm_people`, sets up level-appropriate scheduled tasks.

**Concurrency**: `MAX_CONCURRENT_CONTAINERS` = 10-15. Stagger morning briefings:
- 8:45-8:55 — VP + Directors (5 briefings)
- 9:00-9:10 — Managers (12 briefings)
- 9:10-9:20 — AEs (33 briefings, 2-second offsets)

This ensures managers have intelligence ready before AEs start asking questions.

---

## 3. CRM MCP Tools

### Write tools (via IPC → host processes)

| Tool | Trigger | What it does |
|------|---------|-------------|
| `crm_log_interaction` | Rep describes a call/meeting | Extracts account, contact, summary, sentiment, next_steps → creates interaction + action items |
| `crm_update_opportunity` | Rep mentions deal progress | Creates/updates opportunity with stage, revenue, close date |
| `crm_create_proposal` | Rep asks to build a package | Generates proposal with line items from inventory |
| `crm_complete_action` | Rep says they did something | Marks action item completed |
| `crm_create_task` | Agent identifies follow-up needed | Creates CRM follow-up task with due date |

### Read tools (direct sqlite3 via bash — no IPC round-trip)

The agent uses `sqlite3` directly. The global CLAUDE.md teaches the agent the schema and includes pre-built query templates for common requests (pipeline, quota progress, interaction history, inventory availability).

### Host-side IPC processing

CRM IPC types are handled by `crm/src/ipc-handlers.ts`, delegated from the engine's IPC watcher for unknown types. Each handler:
1. Validates authorization (rep can only write own records, management writes any)
2. Resolves account by fuzzy name match (or creates new)
3. Performs SQLite INSERT/UPDATE
4. Logs the activity

---

## 4. Container Changes

**CRM Container Image** (`crm/container/Dockerfile`): Extends the engine base image, adds `sqlite3` CLI and CRM MCP servers.

**Document Mount** (`engine/src/container-runner.ts`): Mount the CRM document store as read-only for agents that need it.

---

## 5. CLAUDE.md Strategy — Per-Level Personas

### Global (`crm/groups/global.md`) — shared read-only by all agents

- Complete schema reference with column descriptions
- Pre-built SQL query templates (pipeline, quota, interactions, inventory)
- Media types glossary (linear TV, CTV, digital video, radio, online)
- Sales process documentation (upfront season, scatter, terminology)
- Current events calendar with IDs for linking
- Memory protocol (section 6)
- Data access rules by role (section 10)
- Language: Spanish (Mexico), MXN currency, DD/MM/YYYY dates

### Per-Level Persona Instructions

- **AE** (`crm/groups/ae.md`): Personal CRM assistant — logs every interaction automatically, tracks quota, suggests deals
- **Manager** (`crm/groups/manager.md`): Coaching console — team performance dashboards, 1:1 prep, AE risk alerts
- **Director** (`crm/groups/director.md`): Strategic advisor — cross-team patterns, account coordination, resource allocation
- **VP** (`crm/groups/vp.md`): Chief of staff — org-wide pipeline, board-ready summaries, systemic risk detection

### Team Groups

- **team-mgr** (`crm/groups/team-mgr.md`): Shared pipeline visibility, no individual performance data
- **team-dir** (`crm/groups/team-dir.md`): Cross-team coordination, aggregate data only
- **team-vp** (`crm/groups/team-vp.md`): Executive alignment, strategic decisions

---

## 6. Memory Architecture — Short-term, Medium-term, Long-term

### The problem

A rep's day creates discontinuous sessions:

```
9:00  Morning briefing arrives          → isolated session (scheduled task)
9:15  Rep asks "tell me about the Coca-Cola deal" → new session starts
9:30  Rep says "OK I'll call them"      → same session (agent has full context)
10:15 Session expires                   → 45 min idle while rep was on the phone
10:20 Rep sends voice note: "Talked to María, they want 3M not 2M"
      → NEW session. Agent must reconstruct: who is "they"? what deal?
```

### Solution: Four memory layers

1. **Session memory** (0-30 min): Claude SDK session persistence. No changes needed.
2. **Auto-memory** (cross-session): Claude Code auto-memory at `data/sessions/{groupFolder}/.claude/memory/`. Already enabled.
3. **CRM database** (long-term, structured): The authoritative record. Agent queries recent interactions and opportunities to reconstruct context.
4. **Conversation archives + workspace files** (long-term, unstructured): Conversation archives at `groups/{folder}/conversations/*.md` plus agent-maintained working documents.

### CLAUDE.md memory instructions

```markdown
## Memory Protocol

### On every new conversation:
1. Check if the rep's message has ambiguous references ("they", "the deal", "her")
2. If yes, query crm_interactions for this rep's last 5 interactions + crm_opportunities in active stages
3. Resolve references before logging or responding

### On every interaction you log:
1. Always include the full account name, contact name, and opportunity name (not pronouns)
2. Include enough context in the summary that a future session can reconstruct what happened

### Before going idle:
1. If this was a substantive conversation, append a 2-3 line summary to /workspace/group/sessions-log.md
```

---

## 7. Scheduled Proactive Workflows

### Per-rep (50 instances, staggered cron)

| Workflow | Schedule | What it does |
|----------|----------|-------------|
| Morning briefing | Weekdays 9:00-9:10 | Action items due/overdue, quota progress, deals needing attention |
| Weekly summary | Friday 5pm | Week's interactions, pipeline movement, quota achievement |
| Stale deal alert | Daily 10am | Deals without interaction in 7+ days |
| Follow-up reminder | Hourly 9-6 weekdays | Action items due within 2 hours |

### Team/management

| Workflow | Schedule | What it does |
|----------|----------|-------------|
| Team dashboard | Weekday 9:15am | Per-rep pipeline, quota %, deals needing attention |
| Executive pipeline | Monday 8am | Total pipeline by stage, week-over-week movement |
| Event countdown | Daily | Inventory/sales status for events starting within 30 days |

---

## 8. Implementation Phases

### Phase 1: Zero Data Entry (highest value)

**Goal**: One rep can tell the agent about client interactions and it all gets logged.

- Core CRM tables: `crm_people`, `crm_accounts`, `crm_contacts`, `crm_interactions`, `crm_tasks_crm`
- `crm_log_interaction` and `crm_complete_action` MCP tools + IPC handlers
- Add `sqlite3` to container, mount `store/` read-only
- Voice transcription support
- Global CLAUDE.md with CRM persona, schema, query templates, memory protocol
- Register 1 test rep

### Phase 2: Pipeline & Quotas

**Goal**: Reps can ask about their pipeline and quotas. Morning briefings start.

- `crm_opportunities`, `crm_quotas` tables
- `crm_update_opportunity` MCP tool + IPC handler
- Morning briefing + weekly summary scheduled tasks

### Phase 3: Google Workspace + Data Migration + Document Access (Keyword)

**Goal**: Agent can send emails, access Drive/Docs, and CRM is populated with existing data.

- Google Workspace MCP server with service account + domain-wide delegation
- `crm_bulk_import` MCP tool for main group
- Migrate existing data: accounts, contacts, pipeline, quotas, events

### Phase 4: Scale to 50 Reps

**Goal**: All 50 reps onboarded with team structure.

- Batch registration tool/script
- Per-rep CLAUDE.md files (Spanish, personalized per level)
- Team groups with hierarchy-appropriate permissions
- Stagger all scheduled tasks, increase `MAX_CONCURRENT_CONTAINERS`

### Phase 5: Upfronts & Events

**Goal**: Full upfront lifecycle and event-driven selling.

- Upfront and event tracking tables
- Event countdown alerts, upfront fulfillment tracking
- Proactive deal suggestions

### Phase 6: Proposals & Escalation Cascade

**Goal**: Full proposal generation, hierarchical escalation working end-to-end.

- Proposal generation tools
- Real-time escalation triggers
- Full cascade: AE quota emergency → Manager coaching alert → Director pattern detection → VP systemic risk

### Phase 7: Intelligence, Agent Swarm & Document RAG

**Goal**: Agent becomes genuinely smart about the business.

- Agent teams for Director/VP parallel analysis
- Historical pattern analysis, cross-sell suggestions, win/loss analysis
- Document sync pipeline (Google Drive → extract → chunk → embed)
- RAG MCP server with semantic search
- `sqlite-vec` extension for vector search in SQLite

---

## 9. Google Workspace Integration — Per-Rep Access

### Architecture: Service Account with Domain-Wide Delegation

One service account with domain-wide delegation. The agent impersonates each rep using their email.

```
Google Workspace Admin
  → Creates service account + enables domain-wide delegation
  → Grants scopes: Gmail, Drive, Docs, Sheets, Calendar

Host (.env)
  → GOOGLE_SERVICE_ACCOUNT_KEY=<base64-encoded key JSON>

Per-rep (crm_people table)
  → email = "maria.garcia@company.com"

Container runtime
  → Service account key passed via stdin (secrets)
  → Rep's email passed via containerInput
  → Google MCP server impersonates rep
```

### Google Workspace MCP Server Tools

| Tool | Purpose |
|------|---------|
| `gmail_send` | Send email as the rep |
| `gmail_search` | Search rep's inbox |
| `gmail_read` | Read specific email |
| `gmail_draft` | Create draft |
| `drive_list` | List files in Drive |
| `drive_read` | Read file content |
| `drive_create` | Create file |
| `sheets_read` | Read spreadsheet data |
| `sheets_write` | Write to spreadsheet |
| `calendar_list` | List upcoming events |
| `calendar_create` | Create calendar event |

### Security Model

- Service account key is **never** written to disk in the container — passed via stdin secrets
- Each rep's agent can only access **their own** Google account (impersonation scoped by email)
- Bash subprocesses **cannot** access Google secrets (stripped by existing sanitize hook)

---

## 10. Security & Permissions Model

### Data Visibility Rules

| Role | Own Data | Team Data | All Data | Write Scope |
|------|----------|-----------|----------|-------------|
| AE | Full read | None | None | Own records only |
| Manager | Full read | Full read | None | Own + team records |
| Director/VP | Full read | Full read | Full read | All records |
| Main (admin) | Full read | Full read | Full read | All records + system config |

### Implementation

**Reads** (agent queries SQLite directly): Controlled via CLAUDE.md behavioral instructions. The agent follows data access rules specifying which `WHERE` clauses to use.

**Writes** (agent uses MCP tools → IPC → host): Hard enforcement in `crm/src/ipc-handlers.ts`. The IPC handler verifies that the source group has authority to write the requested records.

### Cross-Rep Account Visibility

The `crm_accounts` table is globally shared — any rep can query account info. But `crm_interactions` and `crm_opportunities` are scoped by `person_id`. A rep can see that an account exists but cannot see another rep's interactions or deals with them.

---

## 11. Data Migration

### Initial Load Strategy

1. **Export existing data** to CSV/Excel files
2. **Upload to main group workspace** (`groups/main/imports/`)
3. **Tell the main agent**: "Import the client list from imports/clients.csv"
4. Agent reads the file, maps columns, creates records via CRM MCP tools
5. Agent confirms with a summary

### What to Migrate

| Data Source | Target Table |
|-------------|-------------|
| Client/account list | `crm_accounts` |
| Contact list | `crm_contacts` |
| Current pipeline | `crm_opportunities` |
| Quota assignments | `crm_quotas` |
| Event calendar | `crm_events` |
| Media products | `crm_media_types` |

---

## 12. Language & Localization

- **Language**: Spanish (Mexico), "tú" form, professional but warm
- **Currency**: MXN (use $ symbol, specify USD only for international clients)
- **Dates**: DD/MM/YYYY format
- **Timezone**: America/Mexico_City (set via `TZ` environment variable)

---

## 13. Infrastructure & Hosting

### Recommended: Single AWS EC2 Instance

| Resource | Specification |
|----------|--------------|
| Instance | c6i.2xlarge (8 vCPU, 16 GB RAM) |
| Storage | 100 GB EBS gp3, encrypted |
| Monthly cost | ~$270 (on-demand), ~$170 (reserved) |
| Availability | ~99.9% with CloudWatch auto-recovery |

### Per-Rep OAuth Token Architecture

Each rep has their own Claude subscription. Their `CLAUDE_CODE_OAUTH_TOKEN` is stored as a per-group secret. The engine's `readSecrets()` merges global + per-group secrets at container spawn time.

### Day 1 Setup Checklist

1. Provision EC2 instance
2. Install Docker, Node.js 22, git
3. Clone repo, install, build
4. Configure `.env`
5. Build container image
6. Authenticate WhatsApp
7. Install systemd service
8. Configure CloudWatch auto-recovery and EBS snapshots

---

## 14. Hierarchical Interaction Flows — Detailed Scenarios

### Layer 1: Manager ↔ AE

**AE logs an interaction:**
```
AE (10:20am): "Hablé con María de Unilever, les interesa un paquete CTV
               para el Mundial, como 2M. Dijo que manda el RFP el viernes."

Agent: "Registrado. Unilever — María López, interés en paquete CTV Mundial,
        ~$2M. Acción creada: Recibir RFP de María, vence viernes 28/02.
        Tu cuota semanal va al 65%. Este deal te pone en 89%. ¿Quieres
        que arme un borrador de propuesta con el inventario disponible?"
```

**Manager morning intelligence (scheduled, 9:05am):**
```
Agent: "Buenos días. Tu equipo hoy:

        Ana García — 89% cuota semanal. Deal Unilever $2M avanzando.
        Carlos López — 52% cuota semanal. 3 días sin actividad.
        Laura Méndez — 78% cuota semanal. Cerró Nestlé $350K ayer.

        Sugerencia: Carlos necesita atención. ¿Quieres que prepare
        puntos para un 1:1 rápido?"
```

### Layer 2: Director ↔ Manager

**Director morning strategic brief (scheduled, 8:52am):**
```
Agent: "Buenos días. Resumen de tus 3 equipos:

        Team Norte (Mgr. Ramírez): 85% cuota semanal. Todos activos.
        Team Centro (Mgr. Herrera): 61% cuota semanal. Un AE inactivo.
        Team Sur (Mgr. Domínguez): 92% cuota semanal. Mejor equipo.

        Cuentas cruzadas: Coca-Cola tiene deals con AEs en Norte y Sur.
        Total pipeline Coca-Cola: $3.2M. ¿Coordinar estrategia?"
```

### Layer 3: VP ↔ Director

**VP morning war room brief (scheduled, 8:45am):**
```
Agent: "Buenos días. Tu organización hoy:

        Pipeline total: $28.5M (+$1.2M vs. lunes)
        Cuota org semanal: 74% ($21M de $28.4M)

        Riesgos:
        1. Equipo Centro: AE 3 días inactivo, deal $800K estancado.
        2. Inventario CTV Liga MX al 78% vendido, 18 días al evento.

        Upfront season: 12 de 20 cuentas top han renovado ($45M de $62M target)."
```

---

## 15. Escalation Cascade — Risk Flows Up, Coaching Flows Down

### How Escalation Works

Agents don't message each other. All agents read from and write to the **same CRM database**. Escalation is mediated through the shared database + scheduled workflows.

```
AE agent logs data → CRM DB
                       | (Manager's scheduled workflow reads DB)
Manager agent detects risk → writes alert to Manager's private chat
                       | (Director's scheduled workflow reads same DB)
Director agent detects pattern → writes brief to Director's private chat
                       | (VP's scheduled workflow reads same DB)
VP agent detects systemic issue → writes to VP's private chat
```

### Coaching Flow

When a Manager identifies a coaching opportunity, the agent helps prepare:

```
Manager: "Prepárame para el 1:1 con Carlos"

Agent: "Puntos para 1:1 con Carlos López:

        Situación: 52% cuota semanal, 3 días sin actividad
        Deal Bimbo $800K: propuesta enviada hace 10 días, sin follow-up

        Sugerencias de coaching:
        1. '¿Ya hiciste follow-up con Bimbo?'
        2. Si está trabado: 'vamos a llamar juntos al buyer'
        3. Inventario Liga MX se agota — urgency real para Bimbo

        Tono recomendado: apoyo, no presión."
```

---

## 16. Agent Swarm — Anticipation System

For Directors and VP, parallel analysis via agent teams:

**Director morning brief preparation:**
```
Primary agent spawns 3 sub-agents in parallel:
  Sub-agent 1: Analyze Team Norte pipeline and quota trajectory
  Sub-agent 2: Analyze Team Centro pipeline and quota trajectory
  Sub-agent 3: Analyze Team Sur pipeline and quota trajectory

Primary agent: Synthesize results, detect cross-team patterns, generate brief
```

### Anticipation Patterns

| Pattern | What agents detect | Action |
|---------|-------------------|--------|
| Inventory convergence | Multiple AEs targeting same limited inventory | Alert Director |
| Quota trajectory | Mathematical projection vs. target | Alert Manager |
| Seasonal comparison | This year vs. last year at same point | Alert VP |
| Account clustering | Similar profiles, different outcomes | Suggest to AE |
| Dead pipeline | Deals in late stages with no recent activity | Alert Director |

---

## 17. Document Access — Hybrid Search (Google Drive + RAG)

### Two Search Channels

```
Rep: "Busca la propuesta que le mandamos a Unilever en octubre"
     → Google Drive API (keyword) → exact match

Rep: "Busca propuestas similares a lo que hicimos con Nestlé"
     → sqlite-vec embeddings (semantic similarity) → conceptual match
```

### Channel 1: Google Drive Direct Access (Phase 3)

Uses the Google Workspace MCP server. Zero new infrastructure needed.

### Channel 2: Local RAG with sqlite-vec (Phase 7)

| Component | Technology |
|-----------|-----------|
| Text extraction | `officeparser` (Node.js) |
| Embeddings | `@huggingface/transformers` + `all-MiniLM-L6-v2` |
| Vector storage | `sqlite-vec` extension for `better-sqlite3` |
| Doc sync | Google Drive API via existing service account |

### Hierarchy-Aware Document Access

The RAG MCP server respects the same hierarchy rules as CRM data:
- **AE**: Searches only their own documents
- **Manager**: Searches across their team's docs
- **Director**: Searches across their entire subtree
- **VP**: Full org-wide document search

### Phased Rollout

| Phase | What's Available |
|-------|-----------------|
| Phase 3 | Keyword search + read documents on demand (Google Drive MCP) |
| Phase 7 | Semantic search + document similarity (sqlite-vec + RAG MCP) |

---

## Files Summary

| File | Action | Phase |
|------|--------|-------|
| `crm/src/schema.ts` | CRM table definitions | 1-5 |
| `crm/src/bootstrap.ts` | Schema creation on startup | 1 |
| `crm/src/hierarchy.ts` | Hierarchy helpers (isManagerOf, isDirectorOf, isVp) | 1 |
| `crm/src/ipc-handlers.ts` | CRM IPC write handlers with authorization | 1 |
| `crm/src/register.ts` | Batch hierarchy registration | 4 |
| `crm/src/doc-sync.ts` | Document sync pipeline | 7 |
| `crm/container/mcp/src/crm-tools.ts` | CRM write MCP tools | 1-3 |
| `crm/container/mcp/src/google-workspace.ts` | Google Workspace MCP server | 3 |
| `crm/container/mcp/src/rag-search.ts` | RAG MCP server | 7 |
| `crm/groups/global.md` | Schema, queries, memory protocol, access rules, language | 1 |
| `crm/groups/ae.md` | AE persona template | 1 |
| `crm/groups/manager.md` | Manager persona template | 4 |
| `crm/groups/director.md` | Director persona template | 4 |
| `crm/groups/vp.md` | VP persona template | 4 |
| `crm/groups/team-*.md` | Team group templates | 4 |
| `engine/src/db.ts` | `getDatabase()` export (hook) | 1 |
| `engine/src/index.ts` | `bootstrapCrm()` call (hook) | 1 |
| `engine/src/ipc.ts` | CRM IPC delegation (hook) | 1 |
| `engine/container/agent-runner/src/index.ts` | CRM MCP servers (hook) | 1, 3, 7 |
| `engine/src/container-runner.ts` | Document mount (hook) | 7 |

## Phase 8: Workspace Abstraction (Google + Microsoft)

**Goal**: Support both Google Workspace and Microsoft 365 as interchangeable backends for mail, files, and calendar. Org-wide toggle via `WORKSPACE_PROVIDER` env var.

**Status**: Planned, on hold pending Azure AD app registration.

Full plan: [WORKSPACE-ABSTRACTION-PLAN.md](WORKSPACE-ABSTRACTION-PLAN.md)

---

## Phase 9: Visual Dashboards

**Goal**: Lightweight web dashboards for VP, Directors, and Managers — quick visual glance at pipeline, quotas, activity, and risk without asking the agent.

**Stack**: Zero-build vanilla HTML + ES modules, D3.js for advanced visualization, Node `http` server co-hosted with engine. Same role-scoped data as agent tools. JWT auth via WhatsApp-delivered tokens.

**Status**: Planned.

Full plan: [DASHBOARD-PLAN.md](DASHBOARD-PLAN.md)

---

## Verification

- `npm run typecheck` — no type errors
- `npm run test` — existing tests pass
- New tests for CRM DB functions (CRUD, fuzzy matching, hierarchy resolution)
- New tests for CRM IPC handlers (authorization, hierarchy-aware access control)
- New tests for hierarchy helpers
- End-to-end Phase 1: register test AE → send interaction text → verify DB records → morning briefing
- End-to-end Hierarchy: register AE + Manager + Director → AE behind quota → cascade fires
- Team group privacy: agent never shows individual AE performance in team group
- Google Workspace: send test email via agent → verify sent from rep's address
- Document search: keyword via Drive API + semantic via RAG
- Hierarchy-scoped document access: Manager searches team docs, AE only sees own
