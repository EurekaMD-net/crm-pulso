/**
 * Insight Tools — AE and Manager interaction with overnight insights
 *
 * consultar_insights       — View my insights (AE+)
 * actuar_insight           — Accept/dismiss an insight (AE+)
 * consultar_insights_equipo — Team insight overview (Gerente+)
 */

import { getDatabase } from "../db.js";
import type { ToolContext } from "./index.js";
import { scopeFilter } from "./helpers.js";

// ---------------------------------------------------------------------------
// consultar_insights
// ---------------------------------------------------------------------------

export function consultar_insights(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();
  const scope = scopeFilter(ctx, "i.ae_id");
  const limite = (args.limite as number) || 10;

  let where = "WHERE 1=1 " + scope.where;
  const params: unknown[] = [...scope.params];

  if (args.tipo) {
    where += " AND i.tipo = ?";
    params.push(args.tipo);
  }
  if (args.estado) {
    where += " AND i.estado = ?";
    params.push(args.estado);
  } else {
    // Default: show actionable insights
    where += " AND i.estado IN ('nuevo','briefing')";
  }

  const rows = db
    .prepare(
      `SELECT i.id, i.tipo, i.titulo, i.descripcion, i.accion_recomendada,
              i.confianza, i.sample_size, i.valor_potencial, i.estado,
              i.fecha_generacion, i.fecha_expiracion,
              c.nombre AS cuenta_nombre
       FROM insight_comercial i
       LEFT JOIN cuenta c ON i.cuenta_id = c.id
       ${where}
       ORDER BY i.confianza DESC, i.fecha_generacion DESC
       LIMIT ?`,
    )
    .all(...params, limite) as any[];

  if (rows.length === 0) {
    return JSON.stringify({
      mensaje: "No hay insights pendientes con esos filtros.",
    });
  }

  return JSON.stringify({
    total: rows.length,
    insights: rows.map((r: any) => ({
      id: r.id,
      tipo: r.tipo,
      titulo: r.titulo,
      cuenta: r.cuenta_nombre,
      descripcion: r.descripcion,
      accion: r.accion_recomendada,
      confianza: r.confianza,
      sample_size: r.sample_size,
      valor_potencial: r.valor_potencial,
      estado: r.estado,
      fecha: r.fecha_generacion,
      expira: r.fecha_expiracion,
    })),
  });
}

// ---------------------------------------------------------------------------
// actuar_insight
// ---------------------------------------------------------------------------

export function actuar_insight(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();
  const insightId = args.insight_id as string;
  const accion = args.accion as string;

  if (!insightId) {
    return JSON.stringify({ error: "insight_id es requerido." });
  }
  if (!accion || !["aceptar", "descartar"].includes(accion)) {
    return JSON.stringify({
      error: "accion debe ser 'aceptar' o 'descartar'.",
    });
  }

  // Verify insight exists and belongs to caller's scope
  const scope = scopeFilter(ctx, "i.ae_id");
  const insight = db
    .prepare(
      `SELECT i.* FROM insight_comercial i
       WHERE i.id = ? AND i.estado IN ('nuevo','briefing') ${scope.where}`,
    )
    .get(insightId, ...scope.params) as any;

  if (!insight) {
    return JSON.stringify({
      error: `No encontré el insight "${insightId}" o ya fue procesado.`,
    });
  }

  const now = new Date().toISOString();

  if (accion === "aceptar") {
    db.prepare(
      "UPDATE insight_comercial SET estado = 'aceptado', fecha_accion = ? WHERE id = ?",
    ).run(now, insightId);

    return JSON.stringify({
      mensaje: `Insight "${insight.titulo}" aceptado. Tómalo en cuenta para tu siguiente interacción con el cliente.`,
      insight_id: insightId,
      estado_nuevo: "aceptado",
    });
  }

  // descartar
  const razon = (args.razon as string)?.trim();
  if (!razon) {
    return JSON.stringify({
      error:
        "Al descartar un insight, debes proporcionar una razón (campo 'razon'). Esto ayuda al sistema a mejorar.",
    });
  }

  db.prepare(
    "UPDATE insight_comercial SET estado = 'descartado', razon_descarte = ?, fecha_accion = ? WHERE id = ?",
  ).run(razon, now, insightId);

  return JSON.stringify({
    mensaje: `Insight "${insight.titulo}" descartado. Razón registrada.`,
    insight_id: insightId,
    estado_nuevo: "descartado",
  });
}

// ---------------------------------------------------------------------------
// consultar_insights_equipo
// ---------------------------------------------------------------------------

export function consultar_insights_equipo(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();

  if (ctx.rol === "ae") {
    return JSON.stringify({
      error:
        "Solo gerentes, directores y VP pueden consultar insights de equipo.",
    });
  }

  const scope = scopeFilter(ctx, "i.ae_id");

  // Summary stats
  const stats = db
    .prepare(
      `SELECT i.estado, COUNT(*) as c
       FROM insight_comercial i
       WHERE i.fecha_generacion >= date('now', '-7 days') ${scope.where}
       GROUP BY i.estado`,
    )
    .all(...scope.params) as any[];

  const statMap: Record<string, number> = {};
  for (const s of stats) statMap[s.estado] = s.c;
  const total = Object.values(statMap).reduce((a, b) => a + b, 0);
  const aceptados = statMap["aceptado"] || 0;
  const descartados = statMap["descartado"] || 0;
  const nuevos = (statMap["nuevo"] || 0) + (statMap["briefing"] || 0);
  const acted = aceptados + descartados;
  const tasaAceptacion = acted > 0 ? Math.round((aceptados / acted) * 100) : 0;

  // By tipo
  const byTipo = db
    .prepare(
      `SELECT i.tipo, COUNT(*) as c
       FROM insight_comercial i
       WHERE i.fecha_generacion >= date('now', '-7 days') ${scope.where}
       GROUP BY i.tipo
       ORDER BY c DESC`,
    )
    .all(...scope.params) as any[];

  // Per AE breakdown
  const byAe = db
    .prepare(
      `SELECT p.nombre AS ae_nombre,
              SUM(CASE WHEN i.estado IN ('nuevo','briefing') THEN 1 ELSE 0 END) AS pendientes,
              SUM(CASE WHEN i.estado = 'aceptado' THEN 1 ELSE 0 END) AS aceptados,
              SUM(CASE WHEN i.estado = 'descartado' THEN 1 ELSE 0 END) AS descartados
       FROM insight_comercial i
       LEFT JOIN persona p ON i.ae_id = p.id
       WHERE i.fecha_generacion >= date('now', '-7 days') ${scope.where}
       GROUP BY i.ae_id`,
    )
    .all(...scope.params) as any[];

  return JSON.stringify({
    periodo: "últimos 7 días",
    total_generados: total,
    pendientes: nuevos,
    aceptados,
    descartados,
    tasa_aceptacion: `${tasaAceptacion}%`,
    por_tipo: byTipo.map((r: any) => ({ tipo: r.tipo, total: r.c })),
    por_ae: byAe.map((r: any) => ({
      ejecutivo: r.ae_nombre,
      pendientes: r.pendientes,
      aceptados: r.aceptados,
      descartados: r.descartados,
    })),
  });
}
