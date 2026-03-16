/**
 * Media Mix Analysis — Shared Module
 *
 * Analyzes an account's media buying patterns (TV, CTV, radio, digital)
 * from completed proposals. Used by overnight engine and package builder.
 */

import type Database from "better-sqlite3";

export interface MediaMixEntry {
  medio: string;
  count: number;
  total_value: number;
  pct: number; // percentage of total spend
}

export interface AccountMediaMix {
  entries: MediaMixEntry[];
  total_spend: number;
}

export interface SentimentSummary {
  positivo: number;
  neutral: number;
  negativo: number;
  urgente: number;
  is_warm: boolean;
}

/**
 * Get an account's media mix from completed proposals' medios JSON field.
 * Falls back to tipo_oportunidad distribution if medios is not populated.
 */
export function getAccountMediaMix(
  db: Database.Database,
  cuentaId: string,
): AccountMediaMix {
  // Try medios JSON field first
  const rows = db
    .prepare(
      `SELECT medios, valor_estimado
       FROM propuesta
       WHERE cuenta_id = ? AND etapa = 'completada' AND medios IS NOT NULL`,
    )
    .all(cuentaId) as any[];

  const mediaTotals: Record<string, number> = {};
  let totalSpend = 0;

  for (const row of rows) {
    try {
      const mix = JSON.parse(row.medios);
      for (const [medio, valor] of Object.entries(mix)) {
        mediaTotals[medio] = (mediaTotals[medio] || 0) + Number(valor);
        totalSpend += Number(valor);
      }
    } catch {
      // If medios isn't valid JSON, count the full valor_estimado as unknown
      if (row.valor_estimado) {
        mediaTotals["sin_desglose"] =
          (mediaTotals["sin_desglose"] || 0) + row.valor_estimado;
        totalSpend += row.valor_estimado;
      }
    }
  }

  const entries: MediaMixEntry[] = Object.entries(mediaTotals).map(
    ([medio, total_value]) => ({
      medio,
      count: rows.length,
      total_value,
      pct: totalSpend > 0 ? Math.round((total_value / totalSpend) * 100) : 0,
    }),
  );

  entries.sort((a, b) => b.total_value - a.total_value);

  return { entries, total_spend: totalSpend };
}

/**
 * Get recent sentiment summary for an account (last N days).
 */
export function getAccountSentiment(
  db: Database.Database,
  cuentaId: string,
  days = 30,
): SentimentSummary {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db
    .prepare(
      `SELECT sentimiento, COUNT(*) as c
       FROM actividad
       WHERE cuenta_id = ? AND fecha >= ?
       GROUP BY sentimiento`,
    )
    .all(cuentaId, cutoff) as any[];

  const map: Record<string, number> = {};
  for (const r of rows) map[r.sentimiento] = r.c;

  const positivo = map["positivo"] || 0;
  const negativo = (map["negativo"] || 0) + (map["urgente"] || 0);

  return {
    positivo,
    neutral: map["neutral"] || 0,
    negativo: map["negativo"] || 0,
    urgente: map["urgente"] || 0,
    is_warm: positivo > negativo,
  };
}

/**
 * Get days since last activity for an account.
 */
export function getDaysSinceActivity(
  db: Database.Database,
  cuentaId: string,
): number | null {
  const row = db
    .prepare(
      "SELECT fecha FROM actividad WHERE cuenta_id = ? ORDER BY fecha DESC LIMIT 1",
    )
    .get(cuentaId) as any;

  if (!row) return null;
  return Math.floor((Date.now() - new Date(row.fecha).getTime()) / 86400000);
}
