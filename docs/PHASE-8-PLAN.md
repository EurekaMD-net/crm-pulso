# Phase 8: Exoskeleton Core — Implementation Plan

> Goal: Make the existing CRM feel like the cognitive partner described in VISION.md
> Sessions: 6 | Estimated: 12–16h | New tools: ~4 | New tests: ~60–80

## Schema Changes

The `actividad` table already has a `sentimiento` column (4 values: positivo, neutral, negativo, urgente). Phase 8 extends it:

```sql
-- New columns on actividad
ALTER TABLE actividad ADD COLUMN audio_ref TEXT;           -- file path to saved audio
ALTER TABLE actividad ADD COLUMN transcripcion TEXT;       -- Whisper transcription text
ALTER TABLE actividad ADD COLUMN sentimiento_score REAL;   -- LLM confidence 0.0–1.0
ALTER TABLE actividad ADD COLUMN tipo_mensaje TEXT;        -- 'texto','audio','imagen'

-- New index
CREATE INDEX IF NOT EXISTS idx_actividad_sentimiento ON actividad(sentimiento);
```

**Rationale**: Keep existing `sentimiento` column (4-value enum) as the canonical field. Add `sentimiento_score` for confidence. Rename original plan's `sentiment_label` idea to just enriching the existing field — no duplicate columns. Add `tipo_mensaje` to track input channel.

---

## Session 1: Voice Transcription Pipeline (no deps) ✅ DONE

### What
Download WhatsApp voice notes, save to disk, transcribe via OpenAI Whisper API, inline text into message content.

### Files to Change

| File | Change |
|------|--------|
| `engine/src/channels/whatsapp.ts` | Add `audioMessage` handling block (parallel to imageMessage) |
| `crm/src/transcription.ts` | **NEW** — Whisper provider abstraction (`transcribe(filepath): Promise<{text, confidence}>`) |
| `crm/src/schema.ts` | Add `audio_ref`, `transcripcion`, `tipo_mensaje` columns |
| `.env` | Add `WHISPER_API_URL`, `WHISPER_API_KEY` (OpenAI-compatible endpoint) |
| `engine/src/container-runner.ts` | Add whisper keys to `readSecrets()` + `buildContainerArgs()` |
| `crm/tests/transcription.test.ts` | **NEW** — unit tests for provider |
| `crm/tests/schema.test.ts` | Verify new columns exist |

### Implementation Notes

**Audio download pattern** (follows existing image/PDF pattern in whatsapp.ts):
```typescript
if (normalized?.audioMessage) {
  const buffer = await downloadMediaMessage(msg, 'buffer', {});
  const ext = (normalized.audioMessage.mimetype || 'audio/ogg').split('/')[1];
  const filename = `audio-${Date.now()}.${ext}`;
  const filepath = path.join(groupDir, 'attachments', filename);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, buffer as Buffer);
  const result = await transcribe(filepath);
  content = `[Audio: ${filename}]\n\nTranscripcion:\n${result.text}`;
}
```

**Whisper provider**: OpenAI-compatible multipart/form-data POST to `/v1/audio/transcriptions`. Works with OpenAI, local Whisper, Groq, etc. Return `{ text: string, confidence: number }`.

**3-place secret pattern**: `WHISPER_API_URL` + `WHISPER_API_KEY` must be added to:
1. `.env`
2. `engine/src/container-runner.ts` `readSecrets()`
3. `engine/src/container-runner.ts` `buildContainerArgs()`

### Tests (~15)
- Transcription provider: mock HTTP, success/failure/timeout
- Audio download: mock Baileys downloadMediaMessage
- Schema: columns exist, actividad accepts audio_ref + transcripcion

---

## Session 2: EOD Wrap-Up Workflow (no deps) ✅ DONE

### What
Scheduled 6:30pm task that reviews the day's activities, generates a daily reflection, identifies carry-over items, and sends a concise wrap-up message to each AE.

### Files to Change

| File | Change |
|------|--------|
| `crm/src/briefing-seeds.ts` | Add EOD seed: `{ rol: 'ae', cron: '30 18 * * 1-5', prompt: '...' }` |
| `crm/src/tools/reflexion.ts` | **NEW** — `consultar_resumen_dia` tool (query today's activities, proposals moved, alerts) |
| `crm/src/tools/index.ts` | Register new tool (AE only) |
| `crm/groups/ae.md` | Add EOD wrap-up section + tool reference |
| `crm/src/schema.ts` | Add `tipo = 'reflexion'` to actividad CHECK constraint |
| `crm/tests/briefing-seeds.test.ts` | Test new seed exists |
| `crm/tests/reflexion.test.ts` | **NEW** — tool tests |

### EOD Prompt Design
```
Cierre del dia: resume mis actividades de hoy, propuestas que avanzaron o se
estancaron, alertas que recibi, y sugiere 3 acciones prioritarias para manana.
Si no hubo actividades, preguntame como fue mi dia. Guarda como actividad
tipo 'reflexion'. Formato WhatsApp, conciso.
```

### Carry-Over Logic
The tool queries today's activities and identifies:
1. `siguiente_accion` items with `fecha_siguiente_accion <= tomorrow`
2. Proposals in 'negociacion' >7 days without activity
3. Unresolved alerts from today

### Tests (~10)
- Briefing seed validation (cron format, prompt exists)
- `consultar_resumen_dia` returns today's data only
- Reflexion type accepted in actividad CHECK constraint
- Empty day returns encouraging prompt

---

## Session 3: Sentiment Extraction (depends on Session 2) ✅ DONE

### What
LLM-based sentiment classification on AE messages. Every `registrar_actividad` call auto-classifies sentiment. New `consultar_sentimiento_equipo` tool for managers.

### Files to Change

| File | Change |
|------|--------|
| `crm/src/sentiment.ts` | **NEW** — `classifySentiment(text): Promise<{label, score}>` using inference adapter |
| `crm/src/tools/registro.ts` | Hook sentiment extraction after actividad creation |
| `crm/src/tools/sentiment.ts` | **NEW** — `consultar_sentimiento_equipo` tool (Gerente+Director+VP) |
| `crm/src/schema.ts` | Add `sentimiento_score` column |
| `crm/src/tools/index.ts` | Register new tool |
| `crm/groups/manager.md` | Add sentiment section |
| `crm/groups/director.md` | Add sentiment section |
| `crm/groups/vp.md` | Add sentiment section |
| `crm/src/escalation.ts` | Add sentiment-based escalation (>3 negative in a week) |
| `crm/tests/sentiment.test.ts` | **NEW** |

### Sentiment Classification Approach
Zero-shot via inference adapter (no extra model):
```typescript
const response = await infer({
  messages: [
    { role: 'system', content: SENTIMENT_SYSTEM_PROMPT },
    { role: 'user', content: activitySummary }
  ],
  temperature: 0.1,
  max_tokens: 30,
});
// Parse: { label: 'positivo', score: 0.85 }
```

Reuses existing Qwen 3.5 endpoint — zero additional cost. The `sentimiento` column already exists; we populate it automatically instead of relying on agent judgment.

### `consultar_sentimiento_equipo` Tool
Queries sentiment distribution across team for a time range:
- Input: `{ dias?: number }` (default 7)
- Output: `{ por_ae: [{ nombre, positivo: N, neutral: N, negativo: N, urgente: N }], tendencia: 'mejorando'|'estable'|'deteriorando' }`
- Role: Gerente + Director + VP (scoped via `scopeFilter`)

### Escalation Rule
If an AE has >3 'negativo' or 'urgente' sentiments in 7 days → coaching alert to their Gerente.

### Tests (~15)
- Sentiment classifier: mock inference, parse response
- Auto-classification on registrar_actividad
- consultar_sentimiento_equipo: role scoping, time range
- Escalation trigger: 3+ negative threshold

---

## Session 4: Confidence Calibration (no deps)

### What
Update persona templates so the agent expresses uncertainty when data is stale. Add `data_freshness` metadata to key tool responses.

### Files to Change

| File | Change |
|------|--------|
| `crm/groups/ae.md` | Add confidence calibration rules section |
| `crm/groups/manager.md` | Add confidence calibration rules section |
| `crm/groups/director.md` | Add confidence calibration rules section |
| `crm/groups/vp.md` | Add confidence calibration rules section |
| `crm/groups/global.md` | Add global confidence rules |
| `crm/src/tools/consulta.ts` | Add `data_freshness` field to pipeline/descarga/cuota responses |
| `crm/src/tools/helpers.ts` | Add `dataFreshness(rows, dateField)` helper |
| `crm/tests/templates.test.ts` | Verify confidence section exists in all templates |
| `crm/tests/tools.test.ts` | Verify data_freshness in tool responses |

### Confidence Rules (added to persona templates)
```markdown
## Calibracion de confianza
- Si los datos mas recientes tienen >3 dias, di "segun datos de hace X dias"
- Si un query devuelve 0 resultados, di "no encontre datos — puede que no esten registrados"
- Nunca inventes cifras. Si no tienes el dato, di que no lo tienes
- Cuando `data_freshness.stale` es true, advierte al usuario
```

### `dataFreshness` Helper
```typescript
export function dataFreshness(rows: any[], dateField: string): {
  latest: string | null; days_old: number; stale: boolean
} {
  if (!rows.length) return { latest: null, days_old: -1, stale: true };
  const latest = rows.reduce((max, r) => r[dateField] > max ? r[dateField] : max, '');
  const daysOld = Math.floor((Date.now() - new Date(latest).getTime()) / 86400000);
  return { latest, days_old: daysOld, stale: daysOld > 3 };
}
```

### Tests (~10)
- dataFreshness helper: recent data, stale data, empty
- Tool responses include data_freshness field
- Template validation: all 4 roles have confidence section

---

## Session 5: Enhanced Morning Briefings (depends on Sessions 2, 3)

### What
Upgrade existing briefing prompts to integrate wrap-up data, contact recency, quota path-to-close, manager mood aggregate, and director relationship alerts.

### Files to Change

| File | Change |
|------|--------|
| `crm/src/briefing-seeds.ts` | Rewrite prompts for all 4 roles with richer instructions |
| `crm/src/tools/briefing.ts` | **NEW** — `generar_briefing` tool (all roles) — structured data aggregation |
| `crm/src/tools/index.ts` | Register new tool |
| `crm/groups/ae.md` | Update briefing section with new data points |
| `crm/groups/manager.md` | Add mood aggregate + wrap-up integration |
| `crm/groups/director.md` | Add relationship alert integration |
| `crm/groups/vp.md` | Add cross-team sentiment + pipeline health |
| `crm/tests/briefing.test.ts` | **NEW** |

### Enhanced Briefing Data Points

**AE Morning Briefing** (enriched):
- Yesterday's wrap-up carry-over items (from Session 2)
- Contacts not reached in >14 days
- Quota gap + deals needed to close gap (path-to-close)
- Today's calendar events

**Gerente Weekly Briefing** (enriched):
- Team mood aggregate from sentiment data (from Session 3)
- AEs with declining sentiment trend
- Wrap-up compliance (which AEs skipped EOD wrap-up)
- Quota path-to-close per AE

**Director Weekly Briefing** (enriched):
- Cross-team sentiment comparison
- Gerente coaching activity frequency
- Mega-deal sentiment trajectory

**VP Daily Briefing** (enriched):
- Organization-wide mood pulse
- Teams with >30% negative sentiment
- Revenue at risk from deteriorating sentiment

### Tests (~15)
- generar_briefing returns correct data per role
- Wrap-up carry-over included for AE
- Mood aggregate correct for Gerente scope
- Path-to-close calculation accurate

---

## Session 6: VP Glance Dashboard (no deps)

### What
Single-screen mobile-friendly dashboard view: revenue pulse, pipeline health, quota heatmap, alerts & risks, inventory utilization.

### Files to Change

| File | Change |
|------|--------|
| `crm/src/dashboard/api.ts` | Add `getVpGlance()` handler — aggregate endpoint |
| `crm/src/dashboard/server.ts` | Register `/api/v1/vp-glance` route |
| `crm/dashboard/vp-glance.html` | **NEW** — single-page mobile-friendly view |
| `crm/tests/dashboard.test.ts` | Add VP glance endpoint tests |

### VP Glance Endpoint (`GET /api/v1/vp-glance`)
Single API call returns all data for the VP view:
```json
{
  "revenue_pulse": {
    "cuota_total": 1000000,
    "logrado": 650000,
    "pct": 65,
    "tendencia": "mejorando"
  },
  "pipeline_health": {
    "total_value": 5000000,
    "by_stage": [
      { "etapa": "prospeccion", "count": 12, "valor": 800000 },
      ...
    ],
    "stalled_count": 5,
    "stalled_value": 1200000
  },
  "quota_heatmap": [
    { "nombre": "Director Norte", "pct": 72, "status": "on_track" },
    ...
  ],
  "active_alerts": [
    { "tipo": "cuota_riesgo", "persona": "AE Lopez", "mensaje": "..." }
  ],
  "inventory_utilization": {
    "total_slots": 100,
    "sold": 65,
    "pct": 65
  }
}
```

### UI Design
- Mobile-first, single column, no scroll on key metrics
- Color-coded cards: green (>80% quota), yellow (50-80%), red (<50%)
- Top bar: total revenue vs quota with progress bar
- Pipeline funnel (simplified)
- Alert count badge with expandable list
- No framework — vanilla HTML/CSS/JS (matches existing dashboard)

### Tests (~10)
- VP glance endpoint returns all sections
- Role scoping (only VP gets full org data)
- Empty data handled gracefully
- Auth required (JWT validation)

---

## Dependency Graph

```
Session 1 (Voice)      Session 2 (EOD)      Session 4 (Confidence)   Session 6 (VP Dashboard)
     │                      │                       │                        │
     │                      ├───────────┐           │                        │
     │                      │           │           │                        │
     │                      ▼           ▼           │                        │
     │               Session 3 (Sentiment)          │                        │
     │                      │                       │                        │
     │                      ├───────────┐           │                        │
     │                      │           │           │                        │
     │                      ▼           │           │                        │
     │               Session 5 (Briefings)          │                        │
     │                                              │                        │
     ▼                      ▼           ▼           ▼                        ▼
                    ── Container Rebuild + Deploy ──
```

**Parallel tracks**: Sessions 1, 2, 4, 6 can start immediately (no deps).
**Sequential**: Session 3 after 2, Session 5 after 2+3.

**Optimal execution order**: 1 → 2 → 3 → 4 → 5 → 6 (or parallelize 1∥2∥4∥6, then 3, then 5)

---

## Cumulative Impact

| Metric | Before (Phase 7) | After (Phase 8) | Delta |
|--------|:-:|:-:|:-:|
| CRM tools | 31 | ~35 | +4 |
| SQLite columns (actividad) | 11 | 15 | +4 |
| Briefing seeds | 5 | 6 | +1 (EOD) |
| Dashboard endpoints | 6 | 7 | +1 (VP glance) |
| Tests passing | 481 | ~550 | +~70 |
| Persona template sections | — | +1 each (confidence) | — |

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Whisper API latency (>5s per audio) | Delays message processing | Process async; send "Transcribiendo..." first |
| Sentiment classification accuracy | Wrong mood data misleads managers | Confidence score threshold; only flag when score >0.7 |
| EOD compliance | AEs ignore wrap-up prompts | Track compliance; Gerente briefing shows skips |
| Qwen extra inference for sentiment | Token cost per activity | Batch classify; cache recent; ~30 tokens per classification |

## Blocked Items (unchanged from Phase 7)
- Microsoft 365 — needs Azure AD (Phase 10.C)
- Multimodal vision — needs VL model endpoint
- Data connectors — need discovery of cubo/inventory/contracts interfaces
