/**
 * Morning Briefing Tool — generar_briefing
 *
 * Role-based aggregation for morning/weekly briefings.
 * Single tool, 4 internal functions dispatched by ctx.rol.
 *
 * Does NOT replace consultar_resumen_dia (that's EOD, today's activities).
 * This is for forward-looking briefings: carry-over, recency, path-to-close.
 */

import { getDatabase } from "../db.js";
import type { ToolContext } from "./index.js";
import { scopeFilter, getCurrentWeek, dateCutoff } from "./helpers.js";

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export function generar_briefing(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  switch (ctx.rol) {
    case "ae":
      return briefingAE(ctx);
    case "gerente":
      return briefingGerente(ctx);
    case "director":
      return briefingDirector(ctx);
    case "vp":
      return briefingVP(ctx);
  }
}

// ---------------------------------------------------------------------------
// AE Briefing
// ---------------------------------------------------------------------------

function briefingAE(ctx: ToolContext): string {
  const db = getDatabase();
  const scope = scopeFilter(ctx, "a.ae_id");
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();
  const tomorrow = new Date(todayStart);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowISO = tomorrow.toISOString();

  // 1. Carry-over: actions from previous days due today or overdue
  const carryOver = db
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

  // 2. Contacts >14d silent
  const recencyCutoff = dateCutoff(14);
  const silentAccounts = db
    .prepare(
      `
    SELECT cu.nombre, cu.id, MAX(a.fecha) AS ultima_actividad
    FROM cuenta cu
    LEFT JOIN actividad a ON a.cuenta_id = cu.id ${scope.where.replace(/AND/, "AND")}
    WHERE cu.ae_id = ?
    GROUP BY cu.id
    HAVING ultima_actividad IS NULL OR ultima_actividad < ?
    ORDER BY ultima_actividad ASC
    LIMIT 10
  `,
    )
    .all(...scope.params, ctx.persona_id, recencyCutoff) as any[];

  // 3. Path-to-close: quota gap + closeable pipeline
  const semana = getCurrentWeek();
  const año = new Date().getFullYear();
  const cuota = db
    .prepare(
      `SELECT meta_total, logro, porcentaje FROM cuota
     WHERE persona_id = ? AND año = ? AND semana = ?`,
    )
    .get(ctx.persona_id, año, semana) as any;

  const closeableStages = [
    "en_negociacion",
    "confirmada_verbal",
    "orden_recibida",
  ];
  const placeholders = closeableStages.map(() => "?").join(",");
  const propScope = scopeFilter(ctx, "p.ae_id");
  const closeable = db
    .prepare(
      `
    SELECT p.titulo, c.nombre AS cuenta, p.valor_estimado, p.etapa
    FROM propuesta p
    LEFT JOIN cuenta c ON p.cuenta_id = c.id
    WHERE p.etapa IN (${placeholders}) ${propScope.where}
    ORDER BY p.valor_estimado DESC
  `,
    )
    .all(...closeableStages, ...propScope.params) as any[];

  const closeableTotal = closeable.reduce(
    (s: number, r: any) => s + (r.valor_estimado || 0),
    0,
  );
  const gap = cuota ? Math.max(0, cuota.meta_total - cuota.logro) : null;

  // 4. Today's calendar events
  const events = db
    .prepare(
      `
    SELECT titulo, fecha_inicio, fecha_fin, tipo
    FROM evento_calendario
    WHERE persona_id = ?
      AND fecha_inicio >= ? AND fecha_inicio < ?
    ORDER BY fecha_inicio ASC
  `,
    )
    .all(ctx.persona_id, todayISO, tomorrowISO) as any[];

  // 5. Stalled proposals
  const stalledScope = scopeFilter(ctx, "p.ae_id");
  const stalled = db
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

  return JSON.stringify({
    rol: "ae",
    fecha: todayISO.split("T")[0],
    carry_over: carryOver.map((r) => ({
      accion: r.siguiente_accion,
      fecha: r.fecha_siguiente_accion,
      cuenta: r.cuenta,
      propuesta: r.propuesta,
    })),
    cuentas_sin_contacto_14d: silentAccounts.map((r) => ({
      nombre: r.nombre,
      ultima_actividad: r.ultima_actividad,
    })),
    path_to_close: {
      cuota: cuota
        ? {
            meta: cuota.meta_total,
            logro: cuota.logro,
            porcentaje: Math.round(cuota.porcentaje * 10) / 10,
          }
        : null,
      gap,
      closeable_total: closeableTotal,
      closeable_deals: closeable.map((r) => ({
        titulo: r.titulo,
        cuenta: r.cuenta,
        valor: r.valor_estimado,
        etapa: r.etapa,
      })),
      deals_needed:
        gap !== null && closeableTotal > 0
          ? Math.ceil(gap / (closeableTotal / Math.max(closeable.length, 1)))
          : null,
    },
    agenda_hoy: events.map((e) => ({
      titulo: e.titulo,
      inicio: e.fecha_inicio,
      fin: e.fecha_fin,
      tipo: e.tipo,
    })),
    propuestas_estancadas: stalled.map((e) => ({
      titulo: e.titulo,
      cuenta: e.cuenta,
      valor: e.valor_estimado,
      dias_sin_actividad: e.dias_sin_actividad,
      etapa: e.etapa,
    })),
  });
}

// ---------------------------------------------------------------------------
// Gerente Briefing
// ---------------------------------------------------------------------------

function briefingGerente(ctx: ToolContext): string {
  const db = getDatabase();
  const scope = scopeFilter(ctx, "a.ae_id");
  const cutoff7 = dateCutoff(7);
  const cutoff14 = dateCutoff(14);

  // 1. Team mood aggregate (last 7d)
  const moodRows = db
    .prepare(
      `
    SELECT a.ae_id, p.nombre, a.sentimiento, COUNT(*) as count
    FROM actividad a
    JOIN persona p ON p.id = a.ae_id
    WHERE a.fecha >= ? ${scope.where}
    GROUP BY a.ae_id, a.sentimiento
    ORDER BY p.nombre
  `,
    )
    .all(cutoff7, ...scope.params) as any[];

  const teamMood: Record<
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
  for (const r of moodRows) {
    if (!teamMood[r.ae_id]) {
      teamMood[r.ae_id] = {
        nombre: r.nombre,
        positivo: 0,
        neutral: 0,
        negativo: 0,
        urgente: 0,
        total: 0,
      };
    }
    const entry = teamMood[r.ae_id];
    const key = r.sentimiento as keyof typeof entry;
    if (key in entry && key !== "nombre" && key !== "total") {
      (entry[key] as number) = r.count;
    }
    entry.total += r.count;
  }

  // 2. Declining sentiment: compare current 7d vs previous 7d per AE
  const prevCutoff = dateCutoff(14);
  const prevMoodRows = db
    .prepare(
      `
    SELECT a.ae_id, a.sentimiento, COUNT(*) as count
    FROM actividad a
    WHERE a.fecha >= ? AND a.fecha < ? ${scope.where}
    GROUP BY a.ae_id, a.sentimiento
  `,
    )
    .all(prevCutoff, cutoff7, ...scope.params) as any[];

  const prevByAe: Record<string, { neg: number; total: number }> = {};
  for (const r of prevMoodRows) {
    if (!prevByAe[r.ae_id]) prevByAe[r.ae_id] = { neg: 0, total: 0 };
    prevByAe[r.ae_id].total += r.count;
    if (r.sentimiento === "negativo" || r.sentimiento === "urgente")
      prevByAe[r.ae_id].neg += r.count;
  }

  const decliningAes: {
    nombre: string;
    prev_neg_pct: number;
    curr_neg_pct: number;
  }[] = [];
  for (const [aeId, curr] of Object.entries(teamMood)) {
    const currNegPct =
      curr.total > 0 ? ((curr.negativo + curr.urgente) / curr.total) * 100 : 0;
    const prev = prevByAe[aeId];
    const prevNegPct =
      prev && prev.total > 0 ? (prev.neg / prev.total) * 100 : 0;
    if (currNegPct - prevNegPct > 5) {
      decliningAes.push({
        nombre: curr.nombre,
        prev_neg_pct: Math.round(prevNegPct),
        curr_neg_pct: Math.round(currNegPct),
      });
    }
  }

  // 3. Wrap-up compliance: team members with NO activities yesterday
  const yesterdayStart = new Date();
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  yesterdayStart.setHours(0, 0, 0, 0);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const teamIds = [ctx.persona_id, ...ctx.team_ids];
  const teamPlaceholders = teamIds.map(() => "?").join(",");

  const activeYesterday = db
    .prepare(
      `
    SELECT DISTINCT ae_id FROM actividad
    WHERE fecha >= ? AND fecha < ?
      AND ae_id IN (${teamPlaceholders})
  `,
    )
    .all(
      yesterdayStart.toISOString(),
      todayStart.toISOString(),
      ...teamIds,
    ) as {
    ae_id: string;
  }[];

  const activeSet = new Set(activeYesterday.map((r) => r.ae_id));

  const teamPersonas = db
    .prepare(
      `SELECT id, nombre FROM persona WHERE id IN (${teamPlaceholders}) AND activo = 1 AND rol = 'ae'`,
    )
    .all(...teamIds) as { id: string; nombre: string }[];

  const noWrapUp = teamPersonas
    .filter((p) => !activeSet.has(p.id))
    .map((p) => p.nombre);

  // 4. Path-to-close per AE
  const semana = getCurrentWeek();
  const año = new Date().getFullYear();
  const closeableStages = [
    "en_negociacion",
    "confirmada_verbal",
    "orden_recibida",
  ];
  const csPlaceholders = closeableStages.map(() => "?").join(",");

  const pathPerAe: {
    nombre: string;
    meta: number;
    logro: number;
    gap: number;
    closeable: number;
  }[] = [];

  for (const p of teamPersonas) {
    const cuota = db
      .prepare(
        `SELECT meta_total, logro FROM cuota WHERE persona_id = ? AND año = ? AND semana = ?`,
      )
      .get(p.id, año, semana) as any;

    const closeRow = db
      .prepare(
        `SELECT COALESCE(SUM(valor_estimado), 0) as total FROM propuesta WHERE ae_id = ? AND etapa IN (${csPlaceholders})`,
      )
      .get(p.id, ...closeableStages) as any;

    if (cuota) {
      pathPerAe.push({
        nombre: p.nombre,
        meta: cuota.meta_total,
        logro: cuota.logro,
        gap: Math.max(0, cuota.meta_total - cuota.logro),
        closeable: closeRow?.total || 0,
      });
    }
  }

  // 5. Stalled in team
  const stalledScope = scopeFilter(ctx, "p.ae_id");
  const stalled = db
    .prepare(
      `
    SELECT p.titulo, c.nombre AS cuenta, pe.nombre AS ejecutivo,
           p.valor_estimado, p.dias_sin_actividad, p.etapa
    FROM propuesta p
    LEFT JOIN cuenta c ON p.cuenta_id = c.id
    LEFT JOIN persona pe ON p.ae_id = pe.id
    WHERE p.dias_sin_actividad >= 7 ${stalledScope.where}
      AND p.etapa NOT IN ('completada','perdida','cancelada')
    ORDER BY p.dias_sin_actividad DESC
    LIMIT 15
  `,
    )
    .all(...stalledScope.params) as any[];

  return JSON.stringify({
    rol: "gerente",
    fecha: todayStart.toISOString().split("T")[0],
    sentimiento_equipo: Object.values(teamMood),
    sentimiento_declinando: decliningAes,
    wrap_up_sin_completar: noWrapUp,
    path_to_close_por_ae: pathPerAe,
    propuestas_estancadas: stalled.map((e) => ({
      titulo: e.titulo,
      cuenta: e.cuenta,
      ejecutivo: e.ejecutivo,
      valor: e.valor_estimado,
      dias_sin_actividad: e.dias_sin_actividad,
      etapa: e.etapa,
    })),
  });
}

// ---------------------------------------------------------------------------
// Director Briefing
// ---------------------------------------------------------------------------

function briefingDirector(ctx: ToolContext): string {
  const db = getDatabase();
  const scope = scopeFilter(ctx, "a.ae_id");
  const cutoff7 = dateCutoff(7);

  // 1. Cross-team sentiment: grouped by gerente (via persona.reporta_a)
  const crossTeamRows = db
    .prepare(
      `
    SELECT mgr.id AS gerente_id, mgr.nombre AS gerente,
           a.sentimiento, COUNT(*) as count
    FROM actividad a
    JOIN persona ae ON ae.id = a.ae_id
    JOIN persona mgr ON mgr.id = ae.reporta_a AND mgr.rol = 'gerente'
    WHERE a.fecha >= ? ${scope.where}
    GROUP BY mgr.id, a.sentimiento
    ORDER BY mgr.nombre
  `,
    )
    .all(cutoff7, ...scope.params) as any[];

  const byGerente: Record<
    string,
    {
      gerente: string;
      positivo: number;
      neutral: number;
      negativo: number;
      urgente: number;
      total: number;
    }
  > = {};
  for (const r of crossTeamRows) {
    if (!byGerente[r.gerente_id]) {
      byGerente[r.gerente_id] = {
        gerente: r.gerente,
        positivo: 0,
        neutral: 0,
        negativo: 0,
        urgente: 0,
        total: 0,
      };
    }
    const entry = byGerente[r.gerente_id];
    const key = r.sentimiento as keyof typeof entry;
    if (key in entry && key !== "gerente" && key !== "total") {
      (entry[key] as number) = r.count;
    }
    entry.total += r.count;
  }

  // 2. Gerente coaching frequency: gerentes logging own activities last 7d
  const gerenteIds =
    ctx.full_team_ids.length > 0
      ? (db
          .prepare(
            `SELECT id, nombre FROM persona WHERE rol = 'gerente' AND activo = 1 AND id IN (${ctx.full_team_ids.map(() => "?").join(",")})`,
          )
          .all(...ctx.full_team_ids) as { id: string; nombre: string }[])
      : [];

  const coachingFreq: { nombre: string; actividades_7d: number }[] = [];
  for (const g of gerenteIds) {
    const row = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM actividad WHERE ae_id = ? AND fecha >= ?`,
      )
      .get(g.id, cutoff7) as any;
    coachingFreq.push({
      nombre: g.nombre,
      actividades_7d: row?.cnt || 0,
    });
  }

  // 3. Mega-deal trajectory: mega propuestas + recent sentiment
  const megaScope = scopeFilter(ctx, "p.ae_id");
  const megaDeals = db
    .prepare(
      `
    SELECT p.titulo, c.nombre AS cuenta, p.valor_estimado, p.etapa,
           p.dias_sin_actividad, pe.nombre AS ejecutivo
    FROM propuesta p
    LEFT JOIN cuenta c ON p.cuenta_id = c.id
    LEFT JOIN persona pe ON p.ae_id = pe.id
    WHERE p.es_mega = 1 ${megaScope.where}
      AND p.etapa NOT IN ('completada','perdida','cancelada')
    ORDER BY p.valor_estimado DESC
  `,
    )
    .all(...megaScope.params) as any[];

  // Attach recent sentiment per mega-deal
  const megaWithSentiment = megaDeals.map((m) => {
    const sentRows = db
      .prepare(
        `SELECT sentimiento, COUNT(*) as count FROM actividad
       WHERE propuesta_id = (SELECT id FROM propuesta WHERE titulo = ? AND ae_id IN (
         SELECT id FROM persona WHERE id = ? OR reporta_a IN (${ctx.full_team_ids.map(() => "?").join(",") || "'__none__'"})
       ) LIMIT 1)
       AND fecha >= ?
       GROUP BY sentimiento`,
      )
      .all(m.titulo, ctx.persona_id, ...ctx.full_team_ids, cutoff7) as any[];

    return {
      titulo: m.titulo,
      cuenta: m.cuenta,
      valor: m.valor_estimado,
      etapa: m.etapa,
      dias_sin_actividad: m.dias_sin_actividad,
      ejecutivo: m.ejecutivo,
      sentimiento_reciente: sentRows.reduce(
        (acc: Record<string, number>, r: any) => {
          acc[r.sentimiento] = r.count;
          return acc;
        },
        {},
      ),
    };
  });

  // 4. Pipeline by team
  const pipelineByTeam = Object.entries(byGerente).map(([id, g]) => {
    const row = db
      .prepare(
        `
      SELECT COUNT(*) as count, COALESCE(SUM(p.valor_estimado), 0) as total
      FROM propuesta p
      JOIN persona ae ON ae.id = p.ae_id AND ae.reporta_a = ?
      WHERE p.etapa NOT IN ('completada','perdida','cancelada')
    `,
      )
      .get(id) as any;
    return {
      gerente: g.gerente,
      propuestas: row?.count || 0,
      valor_total: row?.total || 0,
    };
  });

  // 5. Quota ranking for gerentes in scope
  const semana = getCurrentWeek();
  const año = new Date().getFullYear();
  const quotaRanking = gerenteIds
    .map((g) => {
      const q = db
        .prepare(
          `SELECT meta_total, logro, porcentaje FROM cuota WHERE persona_id = ? AND año = ? AND semana = ?`,
        )
        .get(g.id, año, semana) as any;
      return q
        ? {
            nombre: g.nombre,
            meta: q.meta_total,
            logro: q.logro,
            porcentaje: Math.round(q.porcentaje * 10) / 10,
          }
        : null;
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.porcentaje - a.porcentaje);

  return JSON.stringify({
    rol: "director",
    fecha: new Date().toISOString().split("T")[0],
    sentimiento_cross_equipo: Object.values(byGerente),
    coaching_gerentes: coachingFreq,
    mega_deals: megaWithSentiment,
    pipeline_por_equipo: pipelineByTeam,
    cuota_ranking_gerentes: quotaRanking,
  });
}

// ---------------------------------------------------------------------------
// VP Briefing
// ---------------------------------------------------------------------------

function briefingVP(ctx: ToolContext): string {
  const db = getDatabase();
  const cutoff7 = dateCutoff(7);
  // VP has no scope filter (sees everything)

  // 1. Org-wide mood pulse
  const moodRows = db
    .prepare(
      `
    SELECT sentimiento, COUNT(*) as count
    FROM actividad
    WHERE fecha >= ?
    GROUP BY sentimiento
  `,
    )
    .all(cutoff7) as { sentimiento: string; count: number }[];

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

  // 2. Teams >30% negative: per-gerente sentiment
  const gerenteSentiment = db
    .prepare(
      `
    SELECT mgr.id AS gerente_id, mgr.nombre AS gerente,
           a.sentimiento, COUNT(*) as count
    FROM actividad a
    JOIN persona ae ON ae.id = a.ae_id
    JOIN persona mgr ON mgr.id = ae.reporta_a AND mgr.rol = 'gerente'
    WHERE a.fecha >= ?
    GROUP BY mgr.id, a.sentimiento
  `,
    )
    .all(cutoff7) as any[];

  const gerenteAgg: Record<
    string,
    { gerente: string; neg: number; total: number }
  > = {};
  for (const r of gerenteSentiment) {
    if (!gerenteAgg[r.gerente_id])
      gerenteAgg[r.gerente_id] = {
        gerente: r.gerente,
        neg: 0,
        total: 0,
      };
    gerenteAgg[r.gerente_id].total += r.count;
    if (r.sentimiento === "negativo" || r.sentimiento === "urgente")
      gerenteAgg[r.gerente_id].neg += r.count;
  }

  const teamsHighNeg = Object.values(gerenteAgg)
    .filter((g) => g.total > 0 && g.neg / g.total > 0.3)
    .map((g) => ({
      gerente: g.gerente,
      negativo_pct: Math.round((g.neg / g.total) * 100),
      total_actividades: g.total,
    }));

  // 3. Revenue at risk: pipeline value from AEs with declining sentiment
  const prevCutoff = dateCutoff(14);
  const currByAe = db
    .prepare(
      `
    SELECT ae_id, sentimiento, COUNT(*) as count
    FROM actividad WHERE fecha >= ?
    GROUP BY ae_id, sentimiento
  `,
    )
    .all(cutoff7) as any[];

  const prevByAe = db
    .prepare(
      `
    SELECT ae_id, sentimiento, COUNT(*) as count
    FROM actividad WHERE fecha >= ? AND fecha < ?
    GROUP BY ae_id, sentimiento
  `,
    )
    .all(prevCutoff, cutoff7) as any[];

  const currAeMap: Record<string, { neg: number; total: number }> = {};
  for (const r of currByAe) {
    if (!currAeMap[r.ae_id]) currAeMap[r.ae_id] = { neg: 0, total: 0 };
    currAeMap[r.ae_id].total += r.count;
    if (r.sentimiento === "negativo" || r.sentimiento === "urgente")
      currAeMap[r.ae_id].neg += r.count;
  }

  const prevAeMap: Record<string, { neg: number; total: number }> = {};
  for (const r of prevByAe) {
    if (!prevAeMap[r.ae_id]) prevAeMap[r.ae_id] = { neg: 0, total: 0 };
    prevAeMap[r.ae_id].total += r.count;
    if (r.sentimiento === "negativo" || r.sentimiento === "urgente")
      prevAeMap[r.ae_id].neg += r.count;
  }

  // Declining = current neg% > prev neg% + 5pp
  const decliningAeIds: string[] = [];
  for (const [aeId, curr] of Object.entries(currAeMap)) {
    const currPct = curr.total > 0 ? (curr.neg / curr.total) * 100 : 0;
    const prev = prevAeMap[aeId];
    const prevPct = prev && prev.total > 0 ? (prev.neg / prev.total) * 100 : 0;
    if (currPct - prevPct > 5) decliningAeIds.push(aeId);
  }

  let revenueAtRisk = 0;
  if (decliningAeIds.length > 0) {
    const ph = decliningAeIds.map(() => "?").join(",");
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(valor_estimado), 0) as total FROM propuesta
       WHERE ae_id IN (${ph})
         AND etapa NOT IN ('completada','perdida','cancelada')`,
      )
      .get(...decliningAeIds) as any;
    revenueAtRisk = row?.total || 0;
  }

  // 4. Mega-deal status
  const megaDeals = db
    .prepare(
      `
    SELECT p.titulo, c.nombre AS cuenta, p.valor_estimado, p.etapa,
           p.dias_sin_actividad, pe.nombre AS ejecutivo
    FROM propuesta p
    LEFT JOIN cuenta c ON p.cuenta_id = c.id
    LEFT JOIN persona pe ON p.ae_id = pe.id
    WHERE p.es_mega = 1
      AND p.etapa NOT IN ('completada','perdida','cancelada')
    ORDER BY p.valor_estimado DESC
    LIMIT 10
  `,
    )
    .all() as any[];

  // Attach recent sentiment to mega-deals
  const megaWithSentiment = megaDeals.map((m) => {
    const sentRows = db
      .prepare(
        `SELECT sentimiento, COUNT(*) as count FROM actividad
       WHERE propuesta_id = (SELECT id FROM propuesta WHERE titulo = ? LIMIT 1)
       AND fecha >= ?
       GROUP BY sentimiento`,
      )
      .all(m.titulo, cutoff7) as any[];

    return {
      titulo: m.titulo,
      cuenta: m.cuenta,
      valor: m.valor_estimado,
      etapa: m.etapa,
      dias_sin_actividad: m.dias_sin_actividad,
      ejecutivo: m.ejecutivo,
      sentimiento_reciente: sentRows.reduce(
        (acc: Record<string, number>, r: any) => {
          acc[r.sentimiento] = r.count;
          return acc;
        },
        {},
      ),
    };
  });

  return JSON.stringify({
    rol: "vp",
    fecha: new Date().toISOString().split("T")[0],
    pulso_organizacional: {
      ...orgMood,
      total: orgTotal,
      negativo_urgente_pct:
        orgTotal > 0
          ? Math.round(((orgMood.negativo + orgMood.urgente) / orgTotal) * 100)
          : 0,
    },
    equipos_alto_negativo: teamsHighNeg,
    revenue_at_risk: {
      total: revenueAtRisk,
      aes_con_sentimiento_declinando: decliningAeIds.length,
    },
    mega_deals: megaWithSentiment,
  });
}
