# CRM Azteca — Project Status

> Quick-retrieval status file. Updated each `/session-wrap`.
> Last updated: 2026-03-08

## Phase Tracker

| # | Phase | Status | Summary | Date |
|---|-------|--------|---------|------|
| 1 | Zero Data Entry | Done | Auto-capture from WhatsApp conversations | 2026-02 |
| 2 | Pipeline & Proposals | Done | Full sales pipeline with quota tracking | 2026-02 |
| 3 | Google Workspace | Done | Email, Calendar, Drive integration | 2026-03 |
| 4 | Scale & Reliability | Done | Parallel tools, Docker optimizations, web search | 2026-03 |
| 5 | Events & Inventory | Done | Event management, inventory tracking | 2026-03 |
| 6 | Escalation & Alerts | Done | Alert system, management escalation chain | 2026-03 |
| 7 | Intelligence Layer | Partial | RAG + doc search done. Missing: agent swarm, sqlite-vec, historical analysis, cross-sell, win/loss | 2026-03 |
| 8 | Workspace Abstraction | Planned | Google + Microsoft unified API. Blocked on Azure AD app registration | — |

## Available Now (zero external blockers)

1. **sqlite-vec integration** — vector search for RAG, replace current keyword matching
2. **Historical analysis tools** — win/loss patterns, conversion rates, seasonal trends
3. **Cross-sell recommendations** — leverage proposal + account data for suggestions
4. **Agent swarm** — multi-agent coordination for complex workflows
5. **Dashboard UI** — plan exists at `docs/DASHBOARD-PLAN.md`

## Blocked

| Item | Waiting On | Notes |
|------|-----------|-------|
| Phase 8: Workspace Abstraction | Azure AD app registration | Plan at `docs/WORKSPACE-ABSTRACTION-PLAN.md` |
| Multimodal vision | VL model endpoint | Qwen 3.5 Plus is text-only; need Qwen-VL or similar |

## Recent Changes

| Commit | Description |
|--------|-------------|
| `7451b91` | fix: message flow — debounce, compaction, async PDF, streaming fallback |
| `4e7ee5e` | feat: block streaming + context compaction (OpenClaw-inspired) |
| `1234922` | fix: eliminate all remaining AE references |
| `ea4ff0e` | fix: rename AE→Ejecutivo in tool descriptions, alerts, escalations |
| `83c76f0` | feat: local acknowledgment + AE→Ejecutivo terminology |

## Key Metrics

| Metric | Count |
|--------|-------|
| CRM tools | 26 |
| SQLite tables | 15 |
| Test files | 78 |
| Tests passing | 522+ |
| Persona templates | 8 |
| Active groups | 4 |
| Seed: personas | 20 |
| Seed: accounts | 12 |
| Seed: proposals | 25 |

## External Dependencies

| Service | Status | Notes |
|---------|--------|-------|
| Dashscope (Qwen 3.5 Plus) | Active | Primary inference, SSE streaming working |
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
