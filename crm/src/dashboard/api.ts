/**
 * Dashboard API — JSON endpoint handlers
 *
 * Each handler takes query params + ToolContext and returns a JSON-serializable object.
 * Reuses the same scopeFilter pattern as CRM tools for identical permissions.
 */

import { getDatabase } from "../db.js";
import type { ToolContext } from "../tools/index.js";
import {
  scopeFilter,
  getCurrentWeek,
  dateCutoff,
  getMxDateStr,
  getMxYear,
} from "../tools/helpers.js";
import { getThreeWindowStatus } from "../budget.js";

// Hard pagination cap for any dashboard query. Protects against unbounded
// reads over a large org — shape of the data shouldn't exceed ~200 rows
// per endpoint in normal use, 500 is a safety ceiling.
const DASHBOARD_ROW_LIMIT = 500;

type Trend = "mejorando" | "estable" | "deteriorando";

// ---------------------------------------------------------------------------
// GET /api/v1/pipeline
// ---------------------------------------------------------------------------

export function getPipeline(
  query: Record<string, string>,
  ctx: ToolContext,
): unknown {
  const db = getDatabase();
  const scope = scopeFilter(ctx, "p.ae_id");

  let where = "WHERE 1=1 " + scope.where;
  const params: unknown[] = [...scope.params];

  if (query.etapa) {
    where += " AND p.etapa = ?";
    params.push(query.etapa);
  }
  if (query.ejecutivo) {
    where += " AND p.ae_id = ?";
    params.push(query.ejecutivo);
  }
  if (query.solo_estancadas === "true") {
    where += " AND p.dias_sin_actividad >= 7";
  }

  const rows = db
    .prepare(
      `
    SELECT p.titulo, c.nombre AS cuenta, p.valor_estimado, p.etapa,
           p.dias_sin_actividad, p.fecha_ultima_actividad, p.es_mega,
           per.nombre AS ae_nombre
    FROM propuesta p
    LEFT JOIN cuenta c ON p.cuenta_id = c.id
    LEFT JOIN persona per ON p.ae_id = per.id
    ${where}
    ORDER BY p.valor_estimado DESC NULLS LAST
    LIMIT 100
  `,
    )
    .all(...params) as any[];

  const total = rows.reduce((sum, r) => sum + (r.valor_estimado || 0), 0);
  return {
    total_propuestas: rows.length,
    valor_total: total,
    propuestas: rows.map((r) => ({
      titulo: r.titulo,
      cuenta: r.cuenta,
      valor: r.valor_estimado,
      etapa: r.etapa,
      dias_sin_actividad: r.dias_sin_actividad,
      es_mega: r.es_mega === 1,
      ejecutivo: r.ae_nombre,
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/cuota
// ---------------------------------------------------------------------------

export function getCuota(
  query: Record<string, string>,
  ctx: ToolContext,
): unknown {
  const db = getDatabase();
  const semana = query.semana ? parseInt(query.semana, 10) : getCurrentWeek();
  const año = getMxYear();

  let where = "WHERE q.año = ? AND q.semana = ?";
  const params: unknown[] = [año, semana];

  if (ctx.rol === "ae") {
    where += " AND q.persona_id = ?";
    params.push(ctx.persona_id);
  } else if (ctx.rol === "gerente") {
    const ids = [ctx.persona_id, ...ctx.team_ids];
    where += ` AND q.persona_id IN (${ids.map(() => "?").join(",")})`;
    params.push(...ids);
  } else if (ctx.rol === "director") {
    const ids = [ctx.persona_id, ...ctx.full_team_ids];
    where += ` AND q.persona_id IN (${ids.map(() => "?").join(",")})`;
    params.push(...ids);
  }

  const rows = db
    .prepare(
      `
    SELECT q.persona_id, p.nombre, q.meta_total, q.logro, q.porcentaje, q.rol
    FROM cuota q
    JOIN persona p ON q.persona_id = p.id
    ${where}
    ORDER BY q.porcentaje DESC
    LIMIT ${DASHBOARD_ROW_LIMIT}
  `,
    )
    .all(...params) as any[];

  return {
    semana,
    año,
    cuotas: rows.map((r) => ({
      id: r.persona_id,
      nombre: r.nombre,
      meta: r.meta_total,
      logro: r.logro,
      porcentaje: Math.round(r.porcentaje * 10) / 10,
      rol: r.rol,
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/descarga
// ---------------------------------------------------------------------------

export function getDescarga(
  query: Record<string, string>,
  ctx: ToolContext,
): unknown {
  const db = getDatabase();
  const semana = query.semana ? parseInt(query.semana, 10) : getCurrentWeek();
  const año = query.año ? parseInt(query.año, 10) : getMxYear();

  let where = "WHERE d.año = ? AND d.semana = ?";
  const params: unknown[] = [año, semana];

  if (query.cuenta) {
    where += " AND c.nombre LIKE ?";
    params.push(`%${query.cuenta}%`);
  }

  if (ctx.rol === "ae") {
    where += " AND c.ae_id = ?";
    params.push(ctx.persona_id);
  } else if (ctx.rol === "gerente") {
    const ids = [ctx.persona_id, ...ctx.team_ids];
    where += ` AND c.ae_id IN (${ids.map(() => "?").join(",")})`;
    params.push(...ids);
  } else if (ctx.rol === "director") {
    const ids = [ctx.persona_id, ...ctx.full_team_ids];
    where += ` AND c.ae_id IN (${ids.map(() => "?").join(",")})`;
    params.push(...ids);
  }

  const rows = db
    .prepare(
      `
    SELECT c.nombre AS cuenta, d.planificado, d.facturado, d.gap, d.gap_acumulado
    FROM descarga d
    JOIN cuenta c ON d.cuenta_id = c.id
    ${where}
    ORDER BY d.gap DESC
    LIMIT ${DASHBOARD_ROW_LIMIT}
  `,
    )
    .all(...params) as any[];

  const totalPlan = rows.reduce((s, r) => s + (r.planificado || 0), 0);
  const totalFact = rows.reduce((s, r) => s + (r.facturado || 0), 0);

  return {
    semana,
    año,
    total_planificado: totalPlan,
    total_facturado: totalFact,
    gap_total: totalPlan - totalFact,
    cuentas: rows.map((r) => ({
      cuenta: r.cuenta,
      planificado: r.planificado,
      facturado: r.facturado,
      gap: r.gap,
      gap_acumulado: r.gap_acumulado,
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/actividades
// ---------------------------------------------------------------------------

export function getActividades(
  query: Record<string, string>,
  ctx: ToolContext,
): unknown {
  const db = getDatabase();
  const limite = query.limite ? parseInt(query.limite, 10) : 50;
  const scope = scopeFilter(ctx, "a.ae_id");

  let where = "WHERE 1=1 " + scope.where;
  const params: unknown[] = [...scope.params];

  if (query.ejecutivo) {
    where += " AND a.ae_id = ?";
    params.push(query.ejecutivo);
  }
  if (query.cuenta) {
    where += " AND c.nombre LIKE ?";
    params.push(`%${query.cuenta}%`);
  }

  const rows = db
    .prepare(
      `
    SELECT a.tipo, a.resumen, a.sentimiento, a.fecha,
           c.nombre AS cuenta, pr.titulo AS propuesta, p.nombre AS ae
    FROM actividad a
    LEFT JOIN cuenta c ON a.cuenta_id = c.id
    LEFT JOIN propuesta pr ON a.propuesta_id = pr.id
    LEFT JOIN persona p ON a.ae_id = p.id
    ${where}
    ORDER BY a.fecha DESC
    LIMIT ?
  `,
    )
    .all(...params, limite) as any[];

  return {
    total: rows.length,
    actividades: rows.map((r) => ({
      tipo: r.tipo,
      resumen: r.resumen,
      sentimiento: r.sentimiento,
      fecha: r.fecha,
      cuenta: r.cuenta,
      propuesta: r.propuesta,
      ejecutivo: r.ae,
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/equipo
// ---------------------------------------------------------------------------

export function getEquipo(
  _query: Record<string, string>,
  ctx: ToolContext,
): unknown {
  const db = getDatabase();

  let where = "WHERE p.activo = 1";
  const params: unknown[] = [];

  // Scope: only show the hierarchy the user can see
  if (ctx.rol === "ae") {
    where += " AND p.id = ?";
    params.push(ctx.persona_id);
  } else if (ctx.rol === "gerente") {
    const ids = [ctx.persona_id, ...ctx.team_ids];
    where += ` AND p.id IN (${ids.map(() => "?").join(",")})`;
    params.push(...ids);
  } else if (ctx.rol === "director") {
    const ids = [ctx.persona_id, ...ctx.full_team_ids];
    where += ` AND p.id IN (${ids.map(() => "?").join(",")})`;
    params.push(...ids);
  }
  // VP: no filter, sees all

  const rows = db
    .prepare(
      `
    SELECT p.id, p.nombre, p.rol, p.reporta_a, m.nombre AS manager_nombre
    FROM persona p
    LEFT JOIN persona m ON p.reporta_a = m.id
    ${where}
    ORDER BY
      CASE p.rol WHEN 'vp' THEN 0 WHEN 'director' THEN 1 WHEN 'gerente' THEN 2 ELSE 3 END,
      p.nombre
  `,
    )
    .all(...params) as any[];

  return {
    total: rows.length,
    personas: rows.map((r) => ({
      id: r.id,
      nombre: r.nombre,
      rol: r.rol,
      reporta_a: r.reporta_a,
      manager: r.manager_nombre,
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/alertas
// ---------------------------------------------------------------------------

export function getAlertas(
  query: Record<string, string>,
  ctx: ToolContext,
): unknown {
  const db = getDatabase();
  const dias = query.dias ? parseInt(query.dias, 10) : 7;
  const cutoff = dateCutoff(dias);

  let where = `WHERE a.fecha_envio >= ?`;
  const params: unknown[] = [cutoff];

  // Scope: only show alerts for groups the user has access to
  if (ctx.rol === "ae") {
    where +=
      " AND a.grupo_destino IN (SELECT whatsapp_group_folder FROM persona WHERE id = ?)";
    params.push(ctx.persona_id);
  } else if (ctx.rol === "gerente") {
    const ids = [ctx.persona_id, ...ctx.team_ids];
    where += ` AND a.grupo_destino IN (SELECT whatsapp_group_folder FROM persona WHERE id IN (${ids.map(() => "?").join(",")}))`;
    params.push(...ids);
  } else if (ctx.rol === "director") {
    const ids = [ctx.persona_id, ...ctx.full_team_ids];
    where += ` AND a.grupo_destino IN (SELECT whatsapp_group_folder FROM persona WHERE id IN (${ids.map(() => "?").join(",")}))`;
    params.push(...ids);
  }

  // Filter out -mgr/-vp escalation copies and deduplicate by (tipo, base_entity)
  where += ` AND a.entidad_id NOT LIKE '%-mgr' AND a.entidad_id NOT LIKE '%-vp'`;

  const rows = db
    .prepare(
      `
    SELECT a.alerta_tipo, a.entidad_id, a.grupo_destino, MAX(a.fecha_envio) AS fecha_envio
    FROM alerta_log a
    ${where}
    GROUP BY a.alerta_tipo, a.entidad_id
    ORDER BY fecha_envio DESC
    LIMIT 50
  `,
    )
    .all(...params) as any[];

  // Resolve entity IDs to human-readable names
  const resolveEntity = (tipo: string, entityId: string): string => {
    try {
      if (tipo === "inactividad_ae") {
        const p = db
          .prepare("SELECT nombre FROM persona WHERE id = ?")
          .get(entityId) as any;
        return p?.nombre || entityId;
      }
      if (tipo === "descarga_gap") {
        const c = db
          .prepare("SELECT nombre FROM cuenta WHERE id = ?")
          .get(entityId) as any;
        return c?.nombre || entityId;
      }
      if (tipo === "propuesta_estancada" || tipo === "mega_deal_movimiento") {
        const pr = db
          .prepare("SELECT titulo FROM propuesta WHERE id = ?")
          .get(entityId) as any;
        return pr?.titulo || entityId;
      }
      if (tipo === "coaching_alert" || tipo === "cuota_alert") {
        const p = db
          .prepare("SELECT nombre FROM persona WHERE id = ?")
          .get(entityId) as any;
        return p?.nombre || entityId;
      }
    } catch {}
    return entityId;
  };

  const TIPO_LABELS: Record<string, string> = {
    descarga_gap: "Gap descarga",
    propuesta_estancada: "Deal estancado",
    inactividad_ae: "AE inactivo",
    mega_deal_movimiento: "Mega-deal",
    coaching_alert: "Coaching",
    cuota_alert: "Cuota",
    evento_countdown: "Evento",
  };

  return {
    total: rows.length,
    alertas: rows.map((r) => ({
      tipo: TIPO_LABELS[r.alerta_tipo] || r.alerta_tipo,
      entidad: resolveEntity(r.alerta_tipo, r.entidad_id),
      fecha: r.fecha_envio,
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/vp-glance
// ---------------------------------------------------------------------------

export function getVpGlance(
  _query: Record<string, string>,
  ctx: ToolContext,
): unknown {
  if (ctx.rol !== "vp") {
    return { error: "Solo disponible para VP" };
  }

  const db = getDatabase();
  const semana = getCurrentWeek();
  const año = new Date().getFullYear();
  const cutoff7 = dateCutoff(7);
  const cutoff14 = dateCutoff(14);

  // --- 1. Revenue Pulse ---
  const cuotaRows = db
    .prepare(
      `SELECT COALESCE(SUM(meta_total), 0) AS meta, COALESCE(SUM(logro), 0) AS logro
       FROM cuota WHERE año = ? AND semana = ? AND rol = 'ae'`,
    )
    .get(año, semana) as any;

  const prevSemana = semana > 1 ? semana - 1 : 52;
  const prevAño = semana > 1 ? año : año - 1;
  const prevCuota = db
    .prepare(
      `SELECT COALESCE(SUM(meta_total), 0) AS meta, COALESCE(SUM(logro), 0) AS logro
       FROM cuota WHERE año = ? AND semana = ? AND rol = 'ae'`,
    )
    .get(prevAño, prevSemana) as any;

  const meta = cuotaRows.meta || 0;
  const logro = cuotaRows.logro || 0;
  const pct = meta > 0 ? Math.round((logro / meta) * 1000) / 10 : 0;
  const prevPct =
    prevCuota.meta > 0
      ? Math.round((prevCuota.logro / prevCuota.meta) * 1000) / 10
      : 0;
  const revTrend: Trend =
    pct - prevPct > 5
      ? "mejorando"
      : pct - prevPct < -5
        ? "deteriorando"
        : "estable";

  // --- 2. Pipeline Health ---
  const pipeRows = db
    .prepare(
      `SELECT etapa, COUNT(*) AS count, COALESCE(SUM(valor_estimado), 0) AS valor,
              SUM(CASE WHEN es_mega = 1 THEN 1 ELSE 0 END) AS mega,
              SUM(CASE WHEN dias_sin_actividad >= 7 THEN 1 ELSE 0 END) AS stalled,
              SUM(CASE WHEN dias_sin_actividad >= 7 THEN valor_estimado ELSE 0 END) AS stalled_valor
       FROM propuesta
       WHERE etapa NOT IN ('completada','perdida','cancelada')
       GROUP BY etapa`,
    )
    .all() as any[];

  let pipeTotal = 0,
    pipeValor = 0,
    pipeMega = 0,
    pipeStalled = 0,
    pipeStalledValor = 0;
  const byStage: { etapa: string; count: number; valor: number }[] = [];
  for (const r of pipeRows) {
    pipeTotal += r.count;
    pipeValor += r.valor;
    pipeMega += r.mega || 0;
    pipeStalled += r.stalled || 0;
    pipeStalledValor += r.stalled_valor || 0;
    byStage.push({ etapa: r.etapa, count: r.count, valor: r.valor });
  }

  // --- 3. Quota Heatmap (director → gerente → ae tree) ---
  const personas = db
    .prepare(`SELECT id, nombre, rol, reporta_a FROM persona WHERE activo = 1`)
    .all() as any[];
  const cuotaAll = db
    .prepare(
      `SELECT persona_id, meta_total, logro, porcentaje
       FROM cuota WHERE año = ? AND semana = ? AND rol = 'ae'`,
    )
    .all(año, semana) as any[];

  const cuotaMap: Record<string, any> = {};
  for (const q of cuotaAll) cuotaMap[q.persona_id] = q;

  const dirs = personas.filter((p: any) => p.rol === "director");
  const gers = personas.filter((p: any) => p.rol === "gerente");
  const aeList = personas.filter((p: any) => p.rol === "ae");

  function aggPct(ids: string[]): number {
    let m = 0,
      l = 0;
    for (const id of ids) {
      const q = cuotaMap[id];
      if (q) {
        m += q.meta_total || 0;
        l += q.logro || 0;
      }
    }
    return m > 0 ? Math.round((l / m) * 1000) / 10 : 0;
  }

  const quotaHeatmap = dirs.map((d: any) => {
    const dirGers = gers.filter((g: any) => g.reporta_a === d.id);
    const allDirAeIds = aeList
      .filter((a: any) => dirGers.some((g: any) => g.id === a.reporta_a))
      .map((a: any) => a.id);

    return {
      nombre: d.nombre,
      pct: aggPct(allDirAeIds),
      gerentes: dirGers.map((g: any) => {
        const gerAes = aeList.filter((a: any) => a.reporta_a === g.id);
        const gerAeIds = gerAes.map((a: any) => a.id);
        return {
          nombre: g.nombre,
          pct: aggPct(gerAeIds),
          aes: gerAes.map((a: any) => ({
            nombre: a.nombre,
            pct: cuotaMap[a.id]
              ? Math.round(cuotaMap[a.id].porcentaje * 10) / 10
              : 0,
          })),
        };
      }),
    };
  });

  // --- 4. Sentiment Pulse ---
  const moodRows = db
    .prepare(
      `SELECT sentimiento, COUNT(*) AS count
       FROM actividad WHERE fecha >= ?
       GROUP BY sentimiento`,
    )
    .all(cutoff7) as any[];

  const orgMood: Record<string, number> = {
    positivo: 0,
    neutral: 0,
    negativo: 0,
    urgente: 0,
  };
  let orgTotal = 0;
  for (const r of moodRows) {
    if (r.sentimiento in orgMood) orgMood[r.sentimiento] = r.count;
    orgTotal += r.count;
  }

  const negPct =
    orgTotal > 0
      ? Math.round(((orgMood.negativo + orgMood.urgente) / orgTotal) * 100)
      : 0;

  // Trend: compare current 7d neg% vs previous 7d neg%
  const prevMoodRows = db
    .prepare(
      `SELECT sentimiento, COUNT(*) AS count
       FROM actividad WHERE fecha >= ? AND fecha < ?
       GROUP BY sentimiento`,
    )
    .all(cutoff14, cutoff7) as any[];

  let prevNeg = 0,
    prevTotal = 0;
  for (const r of prevMoodRows) {
    prevTotal += r.count;
    if (r.sentimiento === "negativo" || r.sentimiento === "urgente")
      prevNeg += r.count;
  }
  const prevNegPct = prevTotal > 0 ? (prevNeg / prevTotal) * 100 : 0;
  const sentTrend: Trend =
    negPct - prevNegPct > 5
      ? "deteriorando"
      : prevNegPct - negPct > 5
        ? "mejorando"
        : "estable";

  // Teams >30% negative
  const gerenteSentiment = db
    .prepare(
      `SELECT mgr.id AS gerente_id, mgr.nombre AS gerente,
              a.sentimiento, COUNT(*) AS count
       FROM actividad a
       JOIN persona ae ON ae.id = a.ae_id
       JOIN persona mgr ON mgr.id = ae.reporta_a AND mgr.rol = 'gerente'
       WHERE a.fecha >= ?
       GROUP BY mgr.id, a.sentimiento`,
    )
    .all(cutoff7) as any[];

  const gerenteAgg: Record<
    string,
    { gerente: string; neg: number; total: number }
  > = {};
  for (const r of gerenteSentiment) {
    if (!gerenteAgg[r.gerente_id])
      gerenteAgg[r.gerente_id] = { gerente: r.gerente, neg: 0, total: 0 };
    gerenteAgg[r.gerente_id].total += r.count;
    if (r.sentimiento === "negativo" || r.sentimiento === "urgente")
      gerenteAgg[r.gerente_id].neg += r.count;
  }

  const equiposRiesgo = Object.values(gerenteAgg)
    .filter((g) => g.total > 0 && g.neg / g.total > 0.3)
    .map((g) => ({
      gerente: g.gerente,
      neg_pct: Math.round((g.neg / g.total) * 100),
    }));

  // --- 5. Active Alerts (top 10, last 7d) ---
  const alertRows = db
    .prepare(
      `SELECT alerta_tipo, entidad_id, MAX(fecha_envio) AS fecha_envio
       FROM alerta_log
       WHERE fecha_envio >= ?
         AND entidad_id NOT LIKE '%-mgr' AND entidad_id NOT LIKE '%-vp'
       GROUP BY alerta_tipo, entidad_id
       ORDER BY fecha_envio DESC
       LIMIT 10`,
    )
    .all(cutoff7) as any[];

  const TIPO_LABELS_GLANCE: Record<string, string> = {
    descarga_gap: "Gap descarga",
    propuesta_estancada: "Deal estancado",
    inactividad_ae: "AE inactivo",
    mega_deal_movimiento: "Mega-deal",
    coaching_alert: "Coaching",
    cuota_alert: "Cuota",
    evento_countdown: "Evento",
  };

  const resolveEntityGlance = (tipo: string, entityId: string): string => {
    try {
      if (
        tipo === "inactividad_ae" ||
        tipo === "coaching_alert" ||
        tipo === "cuota_alert"
      ) {
        const p = db
          .prepare("SELECT nombre FROM persona WHERE id = ?")
          .get(entityId) as any;
        return p?.nombre || entityId;
      }
      if (tipo === "descarga_gap") {
        const c = db
          .prepare("SELECT nombre FROM cuenta WHERE id = ?")
          .get(entityId) as any;
        return c?.nombre || entityId;
      }
      if (tipo === "propuesta_estancada" || tipo === "mega_deal_movimiento") {
        const pr = db
          .prepare("SELECT titulo FROM propuesta WHERE id = ?")
          .get(entityId) as any;
        return pr?.titulo || entityId;
      }
    } catch {}
    return entityId;
  };

  const activeAlerts = alertRows.map((r: any) => ({
    tipo: TIPO_LABELS_GLANCE[r.alerta_tipo] || r.alerta_tipo,
    entidad: resolveEntityGlance(r.alerta_tipo, r.entidad_id),
    fecha: r.fecha_envio,
  }));

  // --- 6. Inventory Utilization (events next 90d) ---
  const today = getMxDateStr();
  const future90 = getMxDateStr(new Date(Date.now() + 90 * 86400000));
  const eventRows = db
    .prepare(
      `SELECT nombre, tipo, fecha_inicio, inventario_total, inventario_vendido,
              meta_ingresos, ingresos_actual
       FROM crm_events
       WHERE fecha_inicio >= ? AND fecha_inicio <= ?
       ORDER BY fecha_inicio
       LIMIT 20`,
    )
    .all(today, future90) as any[];

  const inventory = eventRows.map((r: any) => {
    let soldPct = 0;
    try {
      if (r.inventario_total && r.inventario_vendido) {
        const total = JSON.parse(r.inventario_total);
        const vendido = JSON.parse(r.inventario_vendido);
        const totalUnits = Object.values(total).reduce(
          (s: number, v: any) => s + Number(v),
          0,
        );
        const soldUnits = Object.values(vendido).reduce(
          (s: number, v: any) => s + Number(v),
          0,
        );
        soldPct =
          totalUnits > 0 ? Math.round((soldUnits / totalUnits) * 100) : 0;
      }
    } catch {}
    return {
      nombre: r.nombre,
      tipo: r.tipo,
      fecha_inicio: r.fecha_inicio,
      sold_pct: soldPct,
      meta: r.meta_ingresos || 0,
      actual: r.ingresos_actual || 0,
    };
  });

  return {
    timestamp: new Date().toISOString(),
    revenue_pulse: { meta, logro, pct, tendencia: revTrend },
    pipeline_health: {
      total: pipeTotal,
      valor: pipeValor,
      mega: pipeMega,
      stalled: pipeStalled,
      stalled_valor: pipeStalledValor,
      by_stage: byStage,
    },
    quota_heatmap: quotaHeatmap,
    sentiment_pulse: {
      ...orgMood,
      total: orgTotal,
      neg_pct: negPct,
      tendencia: sentTrend,
      equipos_riesgo: equiposRiesgo,
    },
    active_alerts: activeAlerts,
    inventory,
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/budget — inference cost (hourly/daily/monthly windows)
// ---------------------------------------------------------------------------

export function getBudget(
  _query: Record<string, string>,
  _ctx: ToolContext,
): unknown {
  const status = getThreeWindowStatus();
  return {
    enforced: process.env.BUDGET_ENFORCE !== "0",
    ...status,
  };
}
