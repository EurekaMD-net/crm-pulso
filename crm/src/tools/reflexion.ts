/**
 * EOD Wrap-Up Tool — consultar_resumen_dia
 *
 * Aggregates today's activities, proposal movements, pending actions,
 * and quota status for a single AE. Designed to be called by the
 * 6:30pm EOD briefing prompt.
 */

import { getDatabase } from "../db.js";
import type { ToolContext } from "./index.js";
import { scopeFilter, getCurrentWeek } from "./helpers.js";

export function consultar_resumen_dia(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();
  const scope = scopeFilter(ctx, "a.ae_id");
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  // 1. Today's activities
  const actividades = db
    .prepare(
      `
    SELECT a.tipo, a.resumen, a.sentimiento, a.fecha,
           c.nombre AS cuenta, pr.titulo AS propuesta
    FROM actividad a
    LEFT JOIN cuenta c ON a.cuenta_id = c.id
    LEFT JOIN propuesta pr ON a.propuesta_id = pr.id
    WHERE a.fecha >= ? ${scope.where}
    ORDER BY a.fecha DESC
  `,
    )
    .all(todayISO, ...scope.params) as any[];

  // 2. Proposals that changed stage today
  const propScope = scopeFilter(ctx, "p.ae_id");
  const propMovidas = db
    .prepare(
      `
    SELECT p.titulo, c.nombre AS cuenta, p.etapa, p.valor_estimado,
           p.fecha_ultima_actividad
    FROM propuesta p
    LEFT JOIN cuenta c ON p.cuenta_id = c.id
    WHERE p.fecha_ultima_actividad >= ? ${propScope.where}
      AND p.etapa NOT IN ('completada','perdida','cancelada')
    ORDER BY p.valor_estimado DESC
  `,
    )
    .all(todayISO, ...propScope.params) as any[];

  // 3. Pending next actions (due today or overdue)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const tomorrowISO = tomorrow.toISOString();

  const pendientes = db
    .prepare(
      `
    SELECT a.siguiente_accion, a.fecha_siguiente_accion,
           c.nombre AS cuenta, pr.titulo AS propuesta
    FROM actividad a
    LEFT JOIN cuenta c ON a.cuenta_id = c.id
    LEFT JOIN propuesta pr ON a.propuesta_id = pr.id
    WHERE a.siguiente_accion IS NOT NULL
      AND a.fecha_siguiente_accion <= ? ${scope.where}
    ORDER BY a.fecha_siguiente_accion ASC
    LIMIT 20
  `,
    )
    .all(tomorrowISO, ...scope.params) as any[];

  // 4. Stalled proposals (>7 days without activity)
  const stalledScope = scopeFilter(ctx, "p.ae_id");
  const estancadas = db
    .prepare(
      `
    SELECT p.titulo, c.nombre AS cuenta, p.valor_estimado,
           p.dias_sin_actividad, p.etapa
    FROM propuesta p
    LEFT JOIN cuenta c ON p.cuenta_id = c.id
    WHERE p.dias_sin_actividad >= 7 ${stalledScope.where}
      AND p.etapa NOT IN ('completada','perdida','cancelada')
    ORDER BY p.dias_sin_actividad DESC
    LIMIT 10
  `,
    )
    .all(...stalledScope.params) as any[];

  // 5. Quota snapshot
  const semana = getCurrentWeek();
  const año = new Date().getFullYear();
  const cuota = db
    .prepare(
      `
    SELECT meta_total, logro, porcentaje
    FROM cuota
    WHERE persona_id = ? AND año = ? AND semana = ?
  `,
    )
    .get(ctx.persona_id, año, semana) as any;

  // 6. Sentiment summary for the day
  const sentimientoCounts = db
    .prepare(
      `
    SELECT sentimiento, COUNT(*) as count
    FROM actividad
    WHERE fecha >= ? AND ae_id = ?
    GROUP BY sentimiento
  `,
    )
    .all(todayISO, ctx.persona_id) as any[];

  const sentResumen: Record<string, number> = {};
  for (const s of sentimientoCounts) {
    if (s.sentimiento) sentResumen[s.sentimiento] = s.count;
  }

  return JSON.stringify({
    fecha: todayISO.split("T")[0],
    actividades_hoy: {
      total: actividades.length,
      detalle: actividades.map((a) => ({
        tipo: a.tipo,
        resumen: a.resumen,
        sentimiento: a.sentimiento,
        cuenta: a.cuenta,
        propuesta: a.propuesta,
      })),
      sentimiento: sentResumen,
    },
    propuestas_movidas: propMovidas.map((p) => ({
      titulo: p.titulo,
      cuenta: p.cuenta,
      etapa: p.etapa,
      valor: p.valor_estimado,
    })),
    acciones_pendientes: pendientes.map((p) => ({
      accion: p.siguiente_accion,
      fecha: p.fecha_siguiente_accion,
      cuenta: p.cuenta,
      propuesta: p.propuesta,
    })),
    propuestas_estancadas: estancadas.map((e) => ({
      titulo: e.titulo,
      cuenta: e.cuenta,
      valor: e.valor_estimado,
      dias_sin_actividad: e.dias_sin_actividad,
      etapa: e.etapa,
    })),
    cuota_semana: cuota
      ? {
          meta: cuota.meta_total,
          logro: cuota.logro,
          porcentaje: Math.round(cuota.porcentaje * 10) / 10,
        }
      : null,
  });
}
