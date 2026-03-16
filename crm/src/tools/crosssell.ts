/**
 * Cross-sell Recommendation Tool
 *
 * Analyzes an account's purchase history and compares against peer accounts
 * (same vertical or tipo) to surface upsell/cross-sell opportunities.
 *
 * Core analysis logic delegated to shared modules:
 *   - crm/src/analysis/peer-comparison.ts (peer metrics, tipo gaps, value gaps)
 *   - crm/src/analysis/media-mix.ts (sentiment, activity recency)
 */

import { getDatabase } from "../db.js";
import type { ToolContext } from "./index.js";
import { scopeFilter } from "./helpers.js";
import { comparePeers } from "../analysis/peer-comparison.js";
import {
  getAccountSentiment,
  getDaysSinceActivity,
} from "../analysis/media-mix.js";

interface Recommendation {
  tipo: "tipo_oportunidad" | "valor_upsell" | "evento" | "reactivacion";
  titulo: string;
  detalle: string;
  valor_potencial: number | null;
  confianza: "alta" | "media" | "baja";
}

// ---------------------------------------------------------------------------
// recomendar_crosssell
// ---------------------------------------------------------------------------

export function recomendar_crosssell(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();
  const cuentaNombre = args.cuenta_nombre as string;
  const limite = (args.limite as number) || 5;

  if (!cuentaNombre) {
    return JSON.stringify({ error: "Se requiere cuenta_nombre." });
  }

  // Verify scope access
  const scope = scopeFilter(ctx, "c.ae_id");
  const cuenta = db
    .prepare(
      `SELECT c.id, c.nombre, c.vertical, c.tipo, c.ae_id, c.años_relacion, c.es_fundador
       FROM cuenta c
       WHERE c.nombre LIKE ? ${scope.where}`,
    )
    .get(`%${cuentaNombre}%`, ...scope.params) as any;

  if (!cuenta) {
    return JSON.stringify({
      error: `No encontré la cuenta "${cuentaNombre}" o no tienes acceso.`,
    });
  }

  // --- Use shared analysis modules ---
  const comparison = comparePeers(db, cuenta.id, cuenta.vertical);
  const sentiment = getAccountSentiment(db, cuenta.id);
  const daysSinceActivity = getDaysSinceActivity(db, cuenta.id);

  // Upcoming events
  const events = db
    .prepare(
      `SELECT nombre, tipo, fecha_inicio, meta_ingresos, ingresos_actual
       FROM crm_events
       WHERE fecha_inicio >= datetime('now') AND fecha_inicio <= datetime('now', '+90 days')
       ORDER BY fecha_inicio
       LIMIT 5`,
    )
    .all() as any[];

  // ---------------------------------------------------------------------------
  // Generate recommendations
  // ---------------------------------------------------------------------------

  const recommendations: Recommendation[] = [];

  const peerLabel: Record<string, string> = {
    estacional: "campañas estacionales",
    lanzamiento: "lanzamientos de producto",
    reforzamiento: "reforzamiento de marca",
    evento_especial: "eventos especiales",
    tentpole: "tentpoles (grandes eventos)",
    prospeccion: "prospección/nuevos formatos",
  };

  // Signal 1: Opportunity type gaps (from peer comparison)
  for (const gap of comparison.tipo_gaps) {
    if (!gap.tipo_oportunidad) continue;
    recommendations.push({
      tipo: "tipo_oportunidad",
      titulo: `${peerLabel[gap.tipo_oportunidad] || gap.tipo_oportunidad}`,
      detalle: `${gap.num_cuentas} cuenta(s) en ${cuenta.vertical} compran ${gap.tipo_oportunidad} (prom. $${(gap.avg_val / 1e6).toFixed(1)}M). ${cuenta.nombre} no lo ha usado.`,
      valor_potencial: Math.round(gap.avg_val),
      confianza: gap.num_cuentas >= 2 ? "alta" : "media",
    });
  }

  // Signal 2: Value upsell — account below vertical average
  if (comparison.value_gap && comparison.value_gap > 1_000_000) {
    recommendations.push({
      tipo: "valor_upsell",
      titulo: "Incrementar inversión al promedio de la vertical",
      detalle: `${cuenta.nombre} ha invertido $${(comparison.account.valor_total_ganado / 1e6).toFixed(1)}M vs promedio vertical de $${(comparison.peer_avg_total_value! / 1e6).toFixed(1)}M. Gap de $${(comparison.value_gap / 1e6).toFixed(1)}M.`,
      valor_potencial: Math.round(comparison.value_gap),
      confianza: "media",
    });
  }

  // Signal 3: Upcoming events
  for (const ev of events) {
    const remaining = ev.meta_ingresos
      ? ev.meta_ingresos - (ev.ingresos_actual || 0)
      : null;
    if (remaining && remaining > 0) {
      recommendations.push({
        tipo: "evento",
        titulo: `Oportunidad en ${ev.nombre}`,
        detalle: `Evento ${ev.tipo} inicia ${ev.fecha_inicio.split("T")[0]}. Meta: $${(ev.meta_ingresos / 1e6).toFixed(1)}M, vendido: $${((ev.ingresos_actual || 0) / 1e6).toFixed(1)}M. Inventario disponible.`,
        valor_potencial: Math.round(Math.min(remaining * 0.1, 5_000_000)),
        confianza: "baja",
      });
    }
  }

  // Signal 4: Reactivation — no recent activity on an account with history
  if (
    daysSinceActivity !== null &&
    daysSinceActivity > 21 &&
    comparison.account.valor_total_ganado > 0
  ) {
    recommendations.push({
      tipo: "reactivacion",
      titulo: "Reactivar relación",
      detalle: `${daysSinceActivity} días sin actividad. Historial de $${(comparison.account.valor_total_ganado / 1e6).toFixed(1)}M en propuestas ganadas. ${sentiment.is_warm ? "Último sentimiento positivo — buen momento para contactar." : "Revisar relación antes de proponer."}`,
      valor_potencial: null,
      confianza: sentiment.is_warm ? "alta" : "media",
    });
  }

  // Sort: alta > media > baja, then by valor_potencial desc
  const confianzaOrder: Record<string, number> = {
    alta: 0,
    media: 1,
    baja: 2,
  };
  recommendations.sort((a, b) => {
    const c = confianzaOrder[a.confianza] - confianzaOrder[b.confianza];
    if (c !== 0) return c;
    return (b.valor_potencial || 0) - (a.valor_potencial || 0);
  });

  const limited = recommendations.slice(0, limite);

  return JSON.stringify({
    cuenta: cuenta.nombre,
    vertical: cuenta.vertical,
    tipo: cuenta.tipo,
    historial: {
      tipos_comprados: Array.from(comparison.account.tipos_comprados),
      tipos_en_vuelo: Array.from(comparison.account.tipos_en_vuelo),
      valor_total_ganado: comparison.account.valor_total_ganado,
      años_relacion: cuenta.años_relacion,
      es_fundador: cuenta.es_fundador === 1,
    },
    sentimiento_reciente: {
      positivo: sentiment.positivo,
      neutral: sentiment.neutral,
      negativo: sentiment.negativo,
      urgente: sentiment.urgente,
      es_calido: sentiment.is_warm,
    },
    recomendaciones: limited,
    total_recomendaciones: recommendations.length,
  });
}
