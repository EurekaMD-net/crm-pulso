# CRM Azteca — Project Status

> Quick-retrieval status file. Updated each `/session-wrap`.
> Last updated: 2026-03-08 (post dashboard API D1)

## Phase Tracker

| # | Phase | Status | Summary | Date |
|---|-------|--------|---------|------|
| 1 | Zero Data Entry | Done | Auto-capture from WhatsApp conversations | 2026-02 |
| 2 | Pipeline & Proposals | Done | Full sales pipeline with quota tracking | 2026-02 |
| 3 | Google Workspace | Done | Email, Calendar, Drive integration | 2026-03 |
| 4 | Scale & Reliability | Done | Parallel tools, Docker optimizations, web search | 2026-03 |
| 5 | Events & Inventory | Done | Event management, inventory tracking | 2026-03 |
| 6 | Escalation & Alerts | Done | Alert system, management escalation chain | 2026-03 |
| 7 | Intelligence Layer | Partial | RAG + doc search + sqlite-vec + historical analysis + cross-sell done. Missing: agent swarm | 2026-03 |
| 8 | Workspace Abstraction | Planned | Google + Microsoft unified API. Blocked on Azure AD app registration | — |

## Available Now (zero external blockers)

1. ~~**Historical analysis tools**~~ — Done (analizar_winloss, analizar_tendencias)
3. ~~**Cross-sell recommendations**~~ — Done (recomendar_crosssell)
4. **Agent swarm** — multi-agent coordination for complex workflows
5. ~~**Dashboard UI**~~ — Done (D1-D3: API + auth + 6 endpoints + VP/Director/Manager dashboards + login routing)

## Blocked

| Item | Waiting On | Notes |
|------|-----------|-------|
| Phase 8: Workspace Abstraction | Azure AD app registration | Plan at `docs/WORKSPACE-ABSTRACTION-PLAN.md` |
| Multimodal vision | VL model endpoint | Qwen 3.5 Plus is text-only; need Qwen-VL or similar |

## Recent Changes

| Commit | Description |
|--------|-------------|
| `8375926` | feat: manager and director dashboards with role-based routing |
| `79489cb` | feat: VP dashboard UI with pipeline funnel, cuota bars, risk table |
| `b57e149` | feat: dashboard REST API with JWT auth and 6 endpoints |
| `499e3bb` | feat: cross-sell recommendation tool (recomendar_crosssell) |
| `80b86af` | feat: analytics seed script for 4-week historical test data |
| `3d797f8` | feat: add historical analysis tools (analizar_winloss, analizar_tendencias) |
| `85a5a55` | feat: sqlite-vec integration for semantic RAG search |
| `7451b91` | fix: message flow — debounce, compaction, async PDF, streaming fallback |
| `4e7ee5e` | feat: block streaming + context compaction (OpenClaw-inspired) |

## Key Metrics

| Metric | Count |
|--------|-------|
| CRM tools | 29 |
| SQLite tables | 16 |
| Test files | 82 |
| Tests passing | 425 CRM + 640 engine = 1065+ |
| Persona templates | 8 |
| Active groups | 4 |
| Seed: personas | 20 |
| Seed: accounts | 12 |
| Seed: proposals | 45 |

## External Dependencies

| Service | Status | Notes |
|---------|--------|-------|
| Dashscope (Qwen 3.5 Plus) | Active | Primary inference + text-embedding-v3 for RAG |
| MiniMax | Active | Fallback inference |
| Brave Search API | Active | Web search tool |
| Google Workspace | Active | Email, Calendar, Drive |
| WhatsApp (Baileys) | Active | Main risk — unofficial API |
| Azure AD | Not started | Needed for Phase 8 |

## Infrastructure

- **Server**: Test VPS, Node 22.22.0, Docker 29.3.0
- **Service**: `agentic-crm.service` (systemd), managed via `crm-ctl`
- **Container**: `agentic-crm-agent:latest` (rebuilt 2026-03-08)
- **WhatsApp**: Authenticated (5215530331051)
