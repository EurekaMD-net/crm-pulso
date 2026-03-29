/**
 * Proposal Draft Engine
 *
 * Converts commercial insights into agent-drafted proposals (borrador_agente).
 * Derives value from historical data, media mix from shared analysis modules,
 * and generates natural language reasoning.
 */

import { getDatabase } from "./db.js";
import { getAccountMediaMix } from "./analysis/media-mix.js";
import {
  getAccountPropHistory,
  getPeerMetrics,
} from "./analysis/peer-comparison.js";

export interface DraftResult {
  propuesta_id: string;
  titulo: string;
  valor_estimado: number | null;
  medios: string | null;
  tipo_oportunidad: string | null;
  gancho_temporal: string | null;
  fecha_vuelo_inicio: string | null;
  fecha_vuelo_fin: string | null;
  agente_razonamiento: string;
  confianza: number;
}

interface InsightData {
  id: string;
  tipo: string;
  cuenta_id: string;
  ae_id: string | null;
  titulo: string;
  descripcion: string;
  valor_potencial: number | null;
  confianza: number;
  datos_soporte: string | null;
  evento_id: string | null;
}

function genId(): string {
  return `prop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function deriveValue(
  db: ReturnType<typeof getDatabase>,
  cuentaId: string,
  insightValor: number | null,
  tipoOportunidad: string | null,
): { valor: number | null; reasoning: string } {
  if (insightValor && insightValor > 0) {
    return {
      valor: insightValor,
      reasoning: `Valor basado en estimacion del insight ($${(insightValor / 1e6).toFixed(1)}M)`,
    };
  }

  const histQuery = tipoOportunidad
    ? (db
        .prepare(
          `SELECT AVG(valor_estimado) as avg_val, COUNT(*) as c
           FROM propuesta WHERE cuenta_id = ? AND tipo_oportunidad = ? AND etapa = 'completada' AND valor_estimado > 0`,
        )
        .get(cuentaId, tipoOportunidad) as any)
    : null;

  if (histQuery?.avg_val && histQuery.c >= 1) {
    return {
      valor: Math.round(histQuery.avg_val),
      reasoning: `Valor basado en promedio historico de ${histQuery.c} propuesta(s) del mismo tipo ($${(histQuery.avg_val / 1e6).toFixed(1)}M)`,
    };
  }

  const overallAvg = db
    .prepare(
      `SELECT AVG(valor_estimado) as avg_val, COUNT(*) as c
       FROM propuesta WHERE cuenta_id = ? AND etapa = 'completada' AND valor_estimado > 0`,
    )
    .get(cuentaId) as any;

  if (overallAvg?.avg_val && overallAvg.c >= 1) {
    return {
      valor: Math.round(overallAvg.avg_val),
      reasoning: `Valor basado en promedio general de ${overallAvg.c} propuesta(s) de la cuenta ($${(overallAvg.avg_val / 1e6).toFixed(1)}M)`,
    };
  }

  return { valor: null, reasoning: "Sin datos historicos para estimar valor" };
}

function deriveMediaMix(
  db: ReturnType<typeof getDatabase>,
  cuentaId: string,
  vertical: string | null,
): { medios: string | null; reasoning: string } {
  const mix = getAccountMediaMix(db, cuentaId);

  if (mix.entries.length > 0 && mix.total_spend > 0) {
    const mixObj: Record<string, number> = {};
    for (const e of mix.entries) {
      if (e.medio !== "sin_desglose") mixObj[e.medio] = e.pct;
    }
    if (Object.keys(mixObj).length > 0) {
      return {
        medios: JSON.stringify(mixObj),
        reasoning: `Media mix basado en historial: ${mix.entries
          .filter((e) => e.medio !== "sin_desglose")
          .map((e) => `${e.medio} ${e.pct}%`)
          .join(", ")}`,
      };
    }
  }

  if (vertical) {
    const peers = getPeerMetrics(db, vertical, cuentaId);
    if (peers.tipos.length > 0) {
      return {
        medios: null,
        reasoning: `Sin historial de media mix. Peers de vertical ${vertical} tienen ${peers.tipos.length} tipos activos`,
      };
    }
  }

  return { medios: null, reasoning: "Sin datos de media mix disponibles" };
}

function getEventData(
  db: ReturnType<typeof getDatabase>,
  eventoId: string | null,
): {
  gancho: string | null;
  fechaInicio: string | null;
  fechaFin: string | null;
} {
  if (!eventoId) return { gancho: null, fechaInicio: null, fechaFin: null };
  const ev = db
    .prepare(
      "SELECT nombre, fecha_inicio, fecha_fin FROM crm_events WHERE id = ?",
    )
    .get(eventoId) as any;
  return ev
    ? {
        gancho: ev.nombre,
        fechaInicio: ev.fecha_inicio,
        fechaFin: ev.fecha_fin,
      }
    : { gancho: null, fechaInicio: null, fechaFin: null };
}

function buildReasoning(
  insight: InsightData,
  valueReasoning: string,
  mixReasoning: string,
  accountHistory: ReturnType<typeof getAccountPropHistory>,
  feedbackReasoning?: string,
): string {
  const parts: string[] = [];
  parts.push(`Insight: ${insight.descripcion}`);
  parts.push(`Valor: ${valueReasoning}`);
  parts.push(`Medios: ${mixReasoning}`);
  if (accountHistory.valor_total_ganado > 0) {
    parts.push(
      `Historial: ${accountHistory.tipos_comprados.size} tipos comprados, $${(accountHistory.valor_total_ganado / 1e6).toFixed(1)}M total ganado`,
    );
  }
  if (accountHistory.tipos_en_vuelo.size > 0) {
    parts.push(
      `En vuelo: ${Array.from(accountHistory.tipos_en_vuelo).join(", ")}`,
    );
  }
  if (feedbackReasoning) {
    parts.push(`Aprendizaje: ${feedbackReasoning}`);
  }
  return parts.join(". ");
}

// ---------------------------------------------------------------------------
// Feedback-informed adjustments
// ---------------------------------------------------------------------------

interface FeedbackAdjustment {
  valor_multiplier: number | null;
  medios_adjustments: Record<string, number> | null;
  reasoning: string;
  sample_size: number;
}

export function getFeedbackAdjustments(
  db: ReturnType<typeof getDatabase>,
  aeId: string | null,
): FeedbackAdjustment {
  const empty: FeedbackAdjustment = {
    valor_multiplier: null,
    medios_adjustments: null,
    reasoning: "",
    sample_size: 0,
  };
  if (!aeId) return empty;

  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const rows = db
    .prepare(
      `SELECT borrador_valor, final_valor, borrador_medios, final_medios
       FROM feedback_propuesta
       WHERE ae_id = ? AND resultado = 'aceptado_con_cambios'
         AND borrador_valor IS NOT NULL AND final_valor IS NOT NULL
         AND fecha_accion >= ?
       ORDER BY fecha_accion DESC LIMIT 20`,
    )
    .all(aeId, cutoff) as any[];

  if (rows.length < 3) return { ...empty, sample_size: rows.length };

  // Value adjustment: average ratio of final/draft
  const ratios = rows
    .filter((r: any) => r.borrador_valor > 0)
    .map((r: any) => r.final_valor / r.borrador_valor);
  const avgRatio =
    ratios.length >= 3
      ? ratios.reduce((s: number, r: number) => s + r, 0) / ratios.length
      : null;
  // Only apply if consistent direction (>5% delta)
  const valorMultiplier =
    avgRatio && Math.abs(avgRatio - 1.0) > 0.05 ? avgRatio : null;

  // Media mix adjustments: track per-medio deltas
  let mediosAdjustments: Record<string, number> | null = null;
  try {
    const deltaCounts: Record<string, { total: number; count: number }> = {};
    for (const r of rows) {
      if (!r.borrador_medios || !r.final_medios) continue;
      const draft = JSON.parse(r.borrador_medios);
      const final_ = JSON.parse(r.final_medios);
      for (const medio of Object.keys({ ...draft, ...final_ })) {
        const draftPct = draft[medio] ?? 0;
        const finalPct = final_[medio] ?? 0;
        if (!deltaCounts[medio]) deltaCounts[medio] = { total: 0, count: 0 };
        deltaCounts[medio].total += finalPct - draftPct;
        deltaCounts[medio].count += 1;
      }
    }
    const significant: Record<string, number> = {};
    for (const [medio, stats] of Object.entries(deltaCounts)) {
      if (stats.count >= 3) {
        const avgDelta = stats.total / stats.count;
        if (Math.abs(avgDelta) >= 3) significant[medio] = Math.round(avgDelta);
      }
    }
    if (Object.keys(significant).length > 0) mediosAdjustments = significant;
  } catch {
    /* ignore parse errors */
  }

  // Build reasoning
  const parts: string[] = [];
  if (valorMultiplier) {
    const dir = valorMultiplier > 1 ? "incrementa" : "reduce";
    const pct = Math.round(Math.abs(valorMultiplier - 1) * 100);
    parts.push(
      `Ejecutivo tipicamente ${dir} valor en ~${pct}% (${rows.length} correcciones)`,
    );
  }
  if (mediosAdjustments) {
    const strs = Object.entries(mediosAdjustments).map(
      ([medio, delta]) => `${medio} ${delta > 0 ? "+" : ""}${delta}pp`,
    );
    parts.push(`Ajustes habituales de media mix: ${strs.join(", ")}`);
  }

  return {
    valor_multiplier: valorMultiplier,
    medios_adjustments: mediosAdjustments,
    reasoning: parts.join(". "),
    sample_size: rows.length,
  };
}

export function draftProposalFromInsight(
  insightId: string,
): DraftResult | { error: string } {
  const db = getDatabase();

  const insight = db
    .prepare("SELECT * FROM insight_comercial WHERE id = ?")
    .get(insightId) as InsightData | undefined;
  if (!insight) return { error: `Insight "${insightId}" no encontrado.` };
  if (!insight.cuenta_id)
    return { error: "El insight no tiene cuenta asociada." };

  const cuenta = db
    .prepare("SELECT id, nombre, vertical, ae_id FROM cuenta WHERE id = ?")
    .get(insight.cuenta_id) as any;
  if (!cuenta) return { error: "Cuenta del insight no encontrada." };

  let tipoOportunidad: string | null = null;
  try {
    const soporte = JSON.parse(insight.datos_soporte ?? "{}");
    tipoOportunidad = soporte.tipo ?? soporte.tipo_oportunidad ?? null;
  } catch {
    /* ignore */
  }

  const { valor, reasoning: valueReasoning } = deriveValue(
    db,
    insight.cuenta_id,
    insight.valor_potencial,
    tipoOportunidad,
  );
  const { medios, reasoning: mixReasoning } = deriveMediaMix(
    db,
    insight.cuenta_id,
    cuenta.vertical,
  );
  const eventData = getEventData(db, insight.evento_id);
  const accountHistory = getAccountPropHistory(db, insight.cuenta_id);

  // Feedback-informed adjustments: learn from AE's past corrections
  const aeId = insight.ae_id ?? cuenta.ae_id;
  const feedback = getFeedbackAdjustments(db, aeId);

  // Apply value adjustment
  let adjustedValor = valor;
  if (adjustedValor && feedback.valor_multiplier) {
    adjustedValor = Math.round(adjustedValor * feedback.valor_multiplier);
  }

  // Apply media mix adjustments
  let adjustedMedios = medios;
  if (medios && feedback.medios_adjustments) {
    try {
      const mix = JSON.parse(medios);
      for (const [medio, delta] of Object.entries(
        feedback.medios_adjustments,
      )) {
        if (mix[medio] !== undefined) {
          mix[medio] = Math.max(0, Math.min(100, mix[medio] + delta));
        }
      }
      const total = Object.values(mix).reduce(
        (s: number, v: any) => s + Number(v),
        0,
      );
      if (total > 0 && total !== 100) {
        for (const k of Object.keys(mix)) {
          mix[k] = Math.round((mix[k] / total) * 100);
        }
      }
      adjustedMedios = JSON.stringify(mix);
    } catch {
      /* keep original */
    }
  }

  const razonamiento = buildReasoning(
    insight,
    valueReasoning,
    mixReasoning,
    accountHistory,
    feedback.reasoning,
  );

  const titulo = eventData.gancho
    ? `${cuenta.nombre} — ${eventData.gancho}`
    : `${cuenta.nombre} — ${insight.titulo}`;

  const propId = genId();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, medios, tipo_oportunidad,
      gancho_temporal, fecha_vuelo_inicio, fecha_vuelo_fin, etapa, fecha_creacion, fecha_ultima_actividad,
      agente_razonamiento, confianza, insight_origen_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'borrador_agente', ?, ?, ?, ?, ?)`,
  ).run(
    propId,
    insight.cuenta_id,
    aeId,
    titulo,
    adjustedValor,
    adjustedMedios,
    tipoOportunidad,
    eventData.gancho,
    eventData.fechaInicio,
    eventData.fechaFin,
    now,
    now,
    razonamiento,
    insight.confianza,
    insightId,
  );

  db.prepare(
    "UPDATE insight_comercial SET estado = 'convertido', propuesta_generada_id = ?, fecha_accion = ? WHERE id = ?",
  ).run(propId, now, insightId);

  return {
    propuesta_id: propId,
    titulo,
    valor_estimado: adjustedValor,
    medios: adjustedMedios,
    tipo_oportunidad: tipoOportunidad,
    gancho_temporal: eventData.gancho,
    fecha_vuelo_inicio: eventData.fechaInicio,
    fecha_vuelo_fin: eventData.fechaFin,
    agente_razonamiento: razonamiento,
    confianza: insight.confianza,
  };
}
