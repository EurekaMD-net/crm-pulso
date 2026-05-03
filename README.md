# Pulso — Agentic CRM

> **Fork notice:** This repository is a fork of [`kosm1x/crm-azteca`](https://github.com/kosm1x/crm-azteca), a purpose-built Agentic CRM originally designed for broadcast ad sales in Mexico. This fork — maintained under [`EurekaMD-net/crm-pulso`](https://github.com/EurekaMD-net/crm-pulso) — adapts the platform for **any B2B sales vertical**: media, healthcare, distribution, real estate, financial services, education, logistics, and beyond.

---

## What Pulso Is

The cognitive exoskeleton for B2B sales teams. AI agents embedded in WhatsApp that do the CRM work so your team can focus on selling.

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

---

## Fork Scope — What Changed and Why

The original [`kosm1x/crm-azteca`](https://github.com/kosm1x/crm-azteca) was purpose-built for broadcast ad sales (Televisa, TV Azteca, Imagen, Milenio). Its core engine is industry-agnostic; only the domain vocabulary, CRM schema fields, and overnight analyzers were media-specific.

This fork decouples those layers:

| Layer | Original (kosm1x) | This fork (EurekaMD-net) |
|---|---|---|
| **Industry** | Broadcast ad sales | Any B2B vertical |
| **Schema vocab** | `contrato`, `inventario`, `descarga` | Generalized + vertical config |
| **Overnight analyzers** | Media mix, holding groups, sell-out | Pluggable by vertical |
| **Persona prompts** | TV/radio context | Vertical-aware system prompt |
| **Role labels** | AE / Gerente / Director / VP | Configurable per deployment |

The engine (NanoClaw), tool registry (71 tools), WhatsApp multi-group routing, Hindsight memory, hybrid RAG, and escalation cascade are **unchanged**.

---

## Target Verticals

| Vertical | Key fit |
|---|---|
| **Media & Advertising** | Native — the original use case |
| **Healthcare / Hospital Sales** | Long cycles, multi-stakeholder, quota pressure |
| **Distribution / Field Sales** | Mobile-first, geo coverage, sell-out tracking |
| **Real Estate (B2B)** | Relationship warmth, long pipeline, package deals |
| **Financial Services** | Compliance-aware logging, executive relationships |
| **Private Education** | Admissions pipeline, 5-8 month cycles |
| **Events & Sponsorships** | Multi-contact deals, holding group overlap |
| **Logistics / 3PL** | Key account management, geo routing |
| **B2B SaaS / Tech** | Multi-stakeholder, technical + exec tracks |
| **Construction / Infra** | Field teams, project-level pipeline |

---

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
                                    ├── Role-based tool filtering (AE:51, Mgr:55, Dir:66, VP:64)
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

| Role     | Tools | Capabilities |
| -------- | ----- | ------------ |
| AE       | 51    | Log activities, manage deals, send emails, set reminders, search docs, web search, analytics, cross-sell, memory, user profile, approval requests, view insights/drafts |
| Manager  | 55    | Team pipeline, quota rollups, coaching briefings, email, docs, web search, analytics, cross-sell, swarm analysis, approve/reject registrations, team insights, memory, Jarvis |
| Director | 66    | All manager tools + relationship intelligence (warmth, milestones, interactions), team pattern analysis, cross-agent insights, Drive creation (docs, sheets, slides), Jarvis |
| VP       | 64    | Executive dashboards, org-wide visibility, relationship intelligence, cross-agent patterns, strategic insights, Drive creation, full analytics, Jarvis |

71 unique tools total across activity logging, pipeline management, Google Workspace (Gmail, Drive, Calendar, Slides, Sheets), event tracking, document search (hybrid RAG), web search, historical analytics, cross-sell recommendations, parallel swarm analysis, follow-up reminders, long-term memory, approval workflows, commercial insights, pattern detection, package building, feedback tracking, user profiles, relationship intelligence, and Jarvis strategic analysis.

### Proactive Workflows

| Workflow             | Schedule                                         | Roles |
| -------------------- | ------------------------------------------------ | ----- |
| Morning briefing     | Weekdays (VP 8:45, Dir 8:52, Mgr 9:00, AE 9:10) | All |
| Weekly summary       | Friday 4pm                                       | AE |
| Follow-up reminders  | Hourly 9-6 weekdays                              | AE |
| Alert evaluation     | Every 2 hours                                    | All (8 evaluators incl. event countdown) |
| Document sync        | Daily 3am                                        | All (Google Drive → RAG index) |
| Overnight analysis   | Nightly                                          | All (6 commercial analyzers + cross-agent patterns) |
| Warmth recomputation | Daily 4am                                        | Dir/VP (executive relationship scores) |

### Escalation Cascade

```
AE quota < 50%           → Manager notified
3+ negative sentiments   → Manager coaching signal
Entire team < 70% quota  → Director pattern alert
3+ stalled mega-deals    → VP systemic risk warning
```

---

## Project Structure

```
agentic-crm/
├── engine/              # NanoClaw — the AI agent platform (git subtree)
├── crm/
│   ├── src/
│   │   ├── schema.ts              # 28 CRM tables
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
│   │   ├── circuit-breaker.ts     # Reusable circuit breaker
│   │   ├── analysis/              # Shared analysis (peer-comparison, media-mix, map-reduce)
│   │   └── ipc-handlers.ts        # 10 IPC task types
│   ├── container/
│   │   ├── build.sh               # Docker build script
│   │   └── Dockerfile
│   └── CLAUDE.md                  # Agent persona + schema + CRM rules
├── scripts/
│   └── seed.ts                    # Demo data seeder
└── package.json
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- A WhatsApp account for the bot (Baileys multi-device)
- Google Workspace service account (Gmail, Drive, Calendar)
- Dashscope API key (embeddings) or compatible local model
- Optional: Hindsight sidecar for persistent memory

### Configuration

Copy `.env.example` to `.env` and fill in:

```bash
# Inference
INFERENCE_PRIMARY_PROVIDER=claude-sdk   # or openai

# Google Workspace
GOOGLE_SERVICE_ACCOUNT_KEY=...

# Embeddings
DASHSCOPE_API_KEY=...

# WhatsApp
WA_SESSION_PATH=./data/wa-session

# Optional: Hindsight memory sidecar
HINDSIGHT_URL=http://localhost:8888
```

### Run

```bash
npm install
npm run build
npm start
```

Scan the QR code that appears in the terminal with your WhatsApp to authenticate the bot.

---

## Relationship to Upstream

This fork tracks `kosm1x/crm-azteca` for core engine fixes but diverges on:

- **Schema**: generalized field names and pluggable vertical config
- **Overnight analyzers**: vertical-specific implementations override the base media analyzers
- **System prompts**: `crm/CLAUDE.md` is replaced per deployment with vertical-appropriate context
- **Seed data**: `scripts/seed.ts` ships with neutral B2B demo data

Upstream PRs that touch the engine (`engine/`) or tool registry (`crm/src/tools/`) are candidates for cherry-pick. Domain-specific changes to media vocabulary are not ported.

---

## License

MIT
