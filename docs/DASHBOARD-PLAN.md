# Dashboard Plan — Lightweight Visual CRM

## Goal

A minimal, high-impact web dashboard for VP, Directors, and Managers to glance at key metrics without asking the agent. Read-only. No data entry — that stays in WhatsApp.

## Design Principles

1. **Zero build step** — ES modules, no bundler, no npm frontend deps
2. **Single file per view** — each dashboard is one HTML file with inline JS
3. **Advanced visualization** — D3.js for custom viz, loaded from CDN
4. **API-first** — thin JSON REST API served from the engine process, dashboard consumes it
5. **Role-scoped** — same hierarchy rules as CRM tools. VP sees all, Director sees vertical, Manager sees team
6. **Mobile-friendly** — sales leaders check on phones. CSS grid, responsive

## Architecture

```
Browser (phone/laptop)
    │
    ▼
Engine process (Node.js)
    ├── WhatsApp channel    (existing)
    ├── IPC watcher         (existing)
    └── HTTP server         (NEW — lightweight, no framework)
        ├── GET /api/v1/...       ← JSON data endpoints
        ├── GET /dashboard/...    ← serves static HTML files
        └── Auth middleware       ← token validation
```

### Why no framework

Express/Fastify add dependencies and complexity for what amounts to ~10 GET routes returning JSON. Node's built-in `http` module + a small router function is sufficient.

---

## API Endpoints

All endpoints require `Authorization: Bearer <token>` header. Token encodes `persona_id` and `rol`.

### Pipeline

```
GET /api/v1/pipeline
    ?etapa=en_negociacion          (optional filter)
    &ejecutivo=persona_id          (optional, managers+ only)
    &solo_estancadas=true           (optional)

Response: {
  total_propuestas: number,
  valor_total: number,
  propuestas: [{ titulo, cuenta, valor, etapa, dias_sin_actividad, es_mega, ejecutivo }]
}
```

### Cuota

```
GET /api/v1/cuota
    ?semana=10                     (optional, default current)

Response: {
  semana: number,
  cuotas: [{ nombre, meta, logro, porcentaje, rol }]
}
```

### Descarga

```
GET /api/v1/descarga
    ?semana=10                     (optional)
    &cuenta=nombre                 (optional)

Response: {
  semana, año,
  total_planificado, total_facturado, gap_total,
  cuentas: [{ cuenta, planificado, facturado, gap, gap_acumulado }]
}
```

### Actividades

```
GET /api/v1/actividades
    ?ejecutivo=persona_id          (optional)
    &cuenta=nombre                 (optional)
    &limite=20                     (optional)

Response: {
  total: number,
  actividades: [{ tipo, resumen, sentimiento, fecha, cuenta, propuesta, ejecutivo }]
}
```

### Equipo (org tree)

```
GET /api/v1/equipo

Response: {
  personas: [{ id, nombre, rol, reporta_a }]
}
```

### Alertas recientes

```
GET /api/v1/alertas
    ?dias=7                        (optional, default 7)

Response: {
  alertas: [{ tipo, mensaje, grupo_destino, fecha }]
}
```

---

## Auth Model

### Token Generation

Dashboard tokens are generated via the WhatsApp agent:

```
User: "Dame acceso al dashboard"
Agent: → generates JWT with { persona_id, rol, exp: 30d }
Agent: "Aquí está tu link: https://crm.example.com/dashboard/?token=eyJ..."
```

Or via CLI:

```bash
npm run dashboard:token -- --persona maria-lopez
```

### Token Validation

```ts
// Middleware: verify JWT, extract persona_id + rol, attach to request
// Same secret as engine's existing auth (or dedicated DASHBOARD_JWT_SECRET)
```

### Scoping

The API reuses the existing `scopeFilter()` from `crm/src/tools/consulta.ts`. Each endpoint builds a `ToolContext` from the token's `persona_id` and `rol`, then queries with the same WHERE clauses the agent uses. **Identical data, identical permissions.**

---

## Dashboard Views

### 1. VP Dashboard (`/dashboard/vp.html`)

**Layout:** Single scrollable page, 4 sections

```
┌─────────────────────────────────────────────┐
│  PIPELINE OVERVIEW                          │
│  ┌─────────────┐ ┌─────────────────────────┐│
│  │ Total value  │ │ Funnel chart (D3)       ││
│  │ $223.5M      │ │ by etapa, stacked bars  ││
│  │ 17 deals     │ │                         ││
│  └─────────────┘ └─────────────────────────┘│
├─────────────────────────────────────────────┤
│  CUOTA POR EQUIPO                           │
│  ┌─────────────────────────────────────────┐│
│  │ Heatmap: rows=ejecutivos, cols=semanas  ││
│  │ Color: red(<70%) → yellow → green(100%+)││
│  └─────────────────────────────────────────┘│
├─────────────────────────────────────────────┤
│  DEALS EN RIESGO                            │
│  ┌─────────────────────────────────────────┐│
│  │ Table: estancadas >7 días, sorted by    ││
│  │ value. Red highlight for mega-deals     ││
│  └─────────────────────────────────────────┘│
├─────────────────────────────────────────────┤
│  ACTIVIDAD RECIENTE                         │
│  ┌─────────────────────────────────────────┐│
│  │ Timeline: last 50 activities, color by  ││
│  │ sentimiento (green/gray/red/orange)     ││
│  └─────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

### 2. Director Dashboard (`/dashboard/director.html`)

Same layout as VP but scoped to their vertical. Adds:
- **Team comparison bars** — pipeline value per manager's team
- **Ejecutivo ranking** — quota % leaderboard within their vertical

### 3. Manager Dashboard (`/dashboard/manager.html`)

Focused on their direct reports:
- **Ejecutivo cards** — one card per AE showing quota %, active deals, days since last activity
- **Pipeline table** — all team deals, sortable by value/stage/days stalled
- **Descarga tracker** — weekly facturación vs plan, gap trend sparkline (D3)
- **Coaching signals** — negative sentiment count, stalled deals, inactivity flags

### 4. Shared Components

All views share:
- **Header**: persona name, role badge, last refresh timestamp, refresh button
- **Color system**: `#22c55e` (green/on-track), `#eab308` (yellow/warning), `#ef4444` (red/critical)
- **Number formatting**: `$XX.XM` for millions, `$XXK` for thousands (Mexican convention)
- **Auto-refresh**: poll API every 60 seconds, animate changed values

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| HTTP server | Node `http` module + ~50-line router | No deps, co-hosted with engine |
| Auth | `jsonwebtoken` (already in deps or tiny) | JWT tokens, same as industry standard |
| Frontend | Vanilla HTML + ES modules | Zero build, instant load, no framework churn |
| Charts | D3.js v7 (CDN) | Most powerful viz library, full control over SVG |
| Responsive | CSS Grid + media queries | No CSS framework needed for 4 pages |
| Data fetching | `fetch()` + async/await | Native browser API |

### Why D3.js

- Funnel charts, heatmaps, sparklines, treemaps — D3 handles all of them natively
- No abstraction layer between data and SVG — full control for custom business charts
- Single CDN script tag, ~80KB gzipped
- Industry standard for data visualization

---

## File Structure

```
crm/src/dashboard/
  ├── server.ts           ← HTTP server + router + auth middleware
  ├── api.ts              ← API endpoint handlers (reuse consulta.ts queries)
  └── auth.ts             ← JWT token generation/validation

crm/dashboard/            ← Static files (served as-is)
  ├── index.html           ← Login / token entry page
  ├── vp.html              ← VP dashboard
  ├── director.html        ← Director dashboard
  ├── manager.html         ← Manager dashboard
  ├── shared.js            ← Shared utilities (fetch wrapper, formatters, D3 helpers)
  └── style.css            ← Shared styles (grid, colors, responsive)
```

---

## Implementation Phases

### D1 — API + Server skeleton

- Add HTTP server to engine startup (co-hosted, single port)
- Implement auth middleware (JWT validation)
- Implement `/api/v1/pipeline`, `/api/v1/cuota`, `/api/v1/equipo` endpoints
- Token generation CLI command
- Test: `curl` each endpoint with valid/invalid tokens

### D2 — VP Dashboard

- `vp.html` with pipeline funnel, cuota heatmap, deals en riesgo table
- `shared.js` with fetch wrapper, number formatting, D3 chart primitives
- `style.css` with responsive grid, color system
- Auto-refresh every 60s

### D3 — Director + Manager Dashboards

- `director.html` — team comparison, ejecutivo ranking
- `manager.html` — ejecutivo cards, pipeline table, descarga sparklines
- Coaching signals panel

### D4 — Polish

- Login page (paste token or scan QR from WhatsApp)
- Animations on data change
- Loading states, error handling
- Mobile optimization pass
- Optional: WebSocket for real-time push instead of polling

---

## Integration with Engine

The HTTP server starts alongside the WhatsApp channel in `engine/src/index.ts`:

```ts
// In engine/src/index.ts, after WhatsApp connects:
import { startDashboardServer } from '../../crm/src/dashboard/server.js';
startDashboardServer(Number(process.env.DASHBOARD_PORT || 3000));
```

This is one new line in the engine — same pattern as the existing CRM hooks (bootstrapCrm, startAlertScheduler, etc.).

### Environment

```env
DASHBOARD_PORT=3000              # HTTP port (default 3000)
DASHBOARD_JWT_SECRET=<random>    # Secret for signing dashboard tokens
```

### Network

On the VPS, expose port 3000 via:
- Reverse proxy (nginx/caddy) with HTTPS termination, or
- Direct access over Tailscale/WireGuard (simpler for internal use)
