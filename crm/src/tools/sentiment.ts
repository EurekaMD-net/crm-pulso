/**
 * Sentiment Query Tool — consultar_sentimiento_equipo
 *
 * Aggregates sentiment distribution across team for a configurable time range.
 * Available to Gerente, Director, and VP roles. Scoped via scopeFilter.
 */

import { getDatabase } from "../db.js";
import type { ToolContext } from "./index.js";
import { scopeFilter, dateCutoff } from "./helpers.js";

export function consultar_sentimiento_equipo(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();
  const dias = (args.dias as number) || 7;
  const cutoff = dateCutoff(dias);
  const scope = scopeFilter(ctx, "a.ae_id");

  // Per-AE sentiment distribution
  const rows = db
    .prepare(
      `
    SELECT a.ae_id, p.nombre, a.sentimiento, COUNT(*) as count
    FROM actividad a
    JOIN persona p ON p.id = a.ae_id
    WHERE a.fecha >= ? ${scope.where}
    GROUP BY a.ae_id, a.sentimiento
    ORDER BY p.nombre, a.sentimiento
  `,
    )
    .all(cutoff, ...scope.params) as {
    ae_id: string;
    nombre: string;
    sentimiento: string;
    count: number;
  }[];

  // Group by AE
  const porAe: Record<
    string,
    {
      nombre: string;
      positivo: number;
      neutral: number;
      negativo: number;
      urgente: number;
      total: number;
    }
  > = {};
  for (const r of rows) {
    if (!porAe[r.ae_id]) {
      porAe[r.ae_id] = {
        nombre: r.nombre,
        positivo: 0,
        neutral: 0,
        negativo: 0,
        urgente: 0,
        total: 0,
      };
    }
    const entry = porAe[r.ae_id];
    const key = r.sentimiento as keyof typeof entry;
    if (key in entry && key !== "nombre" && key !== "total") {
      (entry[key] as number) = r.count;
    }
    entry.total += r.count;
  }

  // Trend: compare current period vs previous period
  const prevCutoff = dateCutoff(dias * 2);
  const prevRows = db
    .prepare(
      `
    SELECT a.sentimiento, COUNT(*) as count
    FROM actividad a
    WHERE a.fecha >= ? AND a.fecha < ? ${scope.where}
    GROUP BY a.sentimiento
  `,
    )
    .all(prevCutoff, cutoff, ...scope.params) as {
    sentimiento: string;
    count: number;
  }[];

  const currRows = db
    .prepare(
      `
    SELECT a.sentimiento, COUNT(*) as count
    FROM actividad a
    WHERE a.fecha >= ? ${scope.where}
    GROUP BY a.sentimiento
  `,
    )
    .all(cutoff, ...scope.params) as { sentimiento: string; count: number }[];

  const prevNeg = prevRows
    .filter((r) => r.sentimiento === "negativo" || r.sentimiento === "urgente")
    .reduce((s, r) => s + r.count, 0);
  const prevTotal = prevRows.reduce((s, r) => s + r.count, 0);
  const currNeg = currRows
    .filter((r) => r.sentimiento === "negativo" || r.sentimiento === "urgente")
    .reduce((s, r) => s + r.count, 0);
  const currTotal = currRows.reduce((s, r) => s + r.count, 0);

  const prevRatio = prevTotal > 0 ? prevNeg / prevTotal : 0;
  const currRatio = currTotal > 0 ? currNeg / currTotal : 0;

  let tendencia: "mejorando" | "estable" | "deteriorando" = "estable";
  if (currRatio < prevRatio - 0.05) tendencia = "mejorando";
  else if (currRatio > prevRatio + 0.05) tendencia = "deteriorando";

  // Flag AEs with >50% negative/urgent
  const alertas = Object.values(porAe)
    .filter((ae) => {
      const negPct = ae.total > 0 ? (ae.negativo + ae.urgente) / ae.total : 0;
      return negPct > 0.5 && ae.total >= 3;
    })
    .map((ae) => ({
      nombre: ae.nombre,
      negativo_urgente: ae.negativo + ae.urgente,
      total: ae.total,
      pct: Math.round(((ae.negativo + ae.urgente) / ae.total) * 100),
    }));

  return JSON.stringify({
    periodo_dias: dias,
    por_ae: Object.values(porAe),
    resumen: {
      total_actividades: currTotal,
      negativo_urgente_pct: currTotal > 0 ? Math.round(currRatio * 100) : 0,
      tendencia,
    },
    alertas,
  });
}
