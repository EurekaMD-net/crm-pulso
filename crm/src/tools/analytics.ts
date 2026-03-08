/**
 * Analytics Tools — Historical analysis queries
 *
 * analizar_winloss: Win/loss pattern analysis over configurable periods
 * analizar_tendencias: Weekly bucketed performance trends
 *
 * Both tools respect role-based scoping via ToolContext.
 */

import { getDatabase } from '../db.js';
import type { ToolContext } from './index.js';

// ---------------------------------------------------------------------------
// Helpers (replicated from consulta.ts — private there)
// ---------------------------------------------------------------------------

function scopeFilter(ctx: ToolContext): { where: string; params: string[] } {
  if (ctx.rol === 'vp') return { where: '', params: [] };
  if (ctx.rol === 'director') {
    const ids = [ctx.persona_id, ...ctx.full_team_ids];
    return { where: `AND ae_id IN (${ids.map(() => '?').join(',')})`, params: ids };
  }
  if (ctx.rol === 'gerente') {
    const ids = [ctx.persona_id, ...ctx.team_ids];
    return { where: `AND ae_id IN (${ids.map(() => '?').join(',')})`, params: ids };
  }
  return { where: 'AND ae_id = ?', params: [ctx.persona_id] };
}

function findCuentaId(nombre: string): string | null {
  const db = getDatabase();
  const row = db.prepare('SELECT id FROM cuenta WHERE nombre LIKE ?').get(`%${nombre}%`) as any;
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// analizar_winloss
// ---------------------------------------------------------------------------

export function analizar_winloss(args: Record<string, unknown>, ctx: ToolContext): string {
  const db = getDatabase();
  const periodoDias = (args.periodo_dias as number) || 90;
  const agruparPor = (args.agrupar_por as string) || 'tipo_oportunidad';
  const cuentaNombre = args.cuenta_nombre as string | undefined;
  const soloMega = args.solo_mega as boolean | undefined;

  const scope = scopeFilter(ctx);

  let where = `WHERE p.etapa IN ('completada','perdida','cancelada')
    AND p.fecha_ultima_actividad >= datetime('now', '-${periodoDias} days')
    ${scope.where}`;
  const params: unknown[] = [...scope.params];

  if (cuentaNombre) {
    const cid = findCuentaId(cuentaNombre);
    if (cid) { where += ' AND p.cuenta_id = ?'; params.push(cid); }
    else return JSON.stringify({ error: `No encontré la cuenta "${cuentaNombre}".` });
  }

  if (soloMega) {
    where += ' AND p.es_mega = 1';
  }

  // Summary query
  const summaryRows = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN p.etapa = 'completada' THEN 1 ELSE 0 END) AS ganadas,
      SUM(CASE WHEN p.etapa = 'perdida' THEN 1 ELSE 0 END) AS perdidas,
      SUM(CASE WHEN p.etapa = 'cancelada' THEN 1 ELSE 0 END) AS canceladas,
      SUM(CASE WHEN p.etapa = 'completada' THEN p.valor_estimado ELSE 0 END) AS valor_ganado,
      SUM(CASE WHEN p.etapa = 'perdida' THEN p.valor_estimado ELSE 0 END) AS valor_perdido,
      AVG(CASE WHEN p.fecha_creacion IS NOT NULL
        THEN julianday(p.fecha_ultima_actividad) - julianday(p.fecha_creacion)
        ELSE NULL END) AS ciclo_promedio
    FROM propuesta p
    ${where}
  `).get(...params) as any;

  if (!summaryRows || summaryRows.total === 0) {
    return JSON.stringify({ mensaje: `No hay propuestas cerradas en los últimos ${periodoDias} días.` });
  }

  const total = summaryRows.total;
  const ganadas = summaryRows.ganadas || 0;
  const perdidas = summaryRows.perdidas || 0;
  const canceladas = summaryRows.canceladas || 0;
  const tasaConversion = total > 0 ? Math.round((ganadas / total) * 1000) / 10 : 0;

  // Loss reasons
  const razonesRows = db.prepare(`
    SELECT p.razon_perdida AS razon, COUNT(*) AS conteo
    FROM propuesta p
    ${where} AND p.razon_perdida IS NOT NULL AND p.razon_perdida != ''
    GROUP BY p.razon_perdida
    ORDER BY conteo DESC
  `).all(...params) as any[];

  // Group by dimension
  let groupCol: string;
  let joinExtra = '';
  switch (agruparPor) {
    case 'vertical':
      groupCol = 'c.vertical';
      joinExtra = 'LEFT JOIN cuenta c ON p.cuenta_id = c.id';
      break;
    case 'ejecutivo':
      groupCol = 'per.nombre';
      joinExtra = 'LEFT JOIN persona per ON p.ae_id = per.id';
      break;
    case 'cuenta':
      groupCol = 'c.nombre';
      joinExtra = 'LEFT JOIN cuenta c ON p.cuenta_id = c.id';
      break;
    default: // tipo_oportunidad
      groupCol = 'p.tipo_oportunidad';
      break;
  }

  const desgloseRows = db.prepare(`
    SELECT
      ${groupCol} AS grupo,
      SUM(CASE WHEN p.etapa = 'completada' THEN 1 ELSE 0 END) AS ganadas,
      SUM(CASE WHEN p.etapa = 'perdida' THEN 1 ELSE 0 END) AS perdidas,
      SUM(CASE WHEN p.etapa = 'cancelada' THEN 1 ELSE 0 END) AS canceladas,
      SUM(CASE WHEN p.etapa = 'completada' THEN p.valor_estimado ELSE 0 END) AS valor_ganado
    FROM propuesta p
    ${joinExtra}
    ${where}
    GROUP BY ${groupCol}
    ORDER BY valor_ganado DESC
  `).all(...params) as any[];

  return JSON.stringify({
    periodo: `últimos ${periodoDias} días`,
    resumen: {
      total_cerradas: total,
      ganadas,
      perdidas,
      canceladas,
      tasa_conversion: tasaConversion,
      valor_ganado: summaryRows.valor_ganado || 0,
      valor_perdido: summaryRows.valor_perdido || 0,
      ciclo_promedio_dias: summaryRows.ciclo_promedio ? Math.round(summaryRows.ciclo_promedio) : null,
      razones_perdida: razonesRows.map((r: any) => ({ razon: r.razon, conteo: r.conteo })),
    },
    desglose: desgloseRows.map((r: any) => ({
      grupo: r.grupo || 'sin_clasificar',
      ganadas: r.ganadas || 0,
      perdidas: r.perdidas || 0,
      canceladas: r.canceladas || 0,
      tasa: (r.ganadas + r.perdidas) > 0
        ? Math.round((r.ganadas / (r.ganadas + r.perdidas)) * 1000) / 10
        : 0,
      valor_ganado: r.valor_ganado || 0,
    })),
  });
}

// ---------------------------------------------------------------------------
// analizar_tendencias
// ---------------------------------------------------------------------------

export function analizar_tendencias(args: Record<string, unknown>, ctx: ToolContext): string {
  const db = getDatabase();
  const periodoSemanas = (args.periodo_semanas as number) || 12;
  const metrica = (args.metrica as string) || 'cuota';
  const personaNombre = args.persona_nombre as string | undefined;

  switch (metrica) {
    case 'cuota':
      return tendenciaCuota(db, periodoSemanas, ctx, personaNombre);
    case 'actividad':
      return tendenciaActividad(db, periodoSemanas, ctx, personaNombre);
    case 'pipeline':
      return tendenciaPipeline(db, periodoSemanas, ctx, personaNombre);
    case 'sentimiento':
      return tendenciaSentimiento(db, periodoSemanas, ctx, personaNombre);
    default:
      return JSON.stringify({ error: `Métrica desconocida: ${metrica}. Usa: cuota, actividad, pipeline, sentimiento.` });
  }
}

// ---------------------------------------------------------------------------
// Trend sub-queries
// ---------------------------------------------------------------------------

function personaIdFromName(nombre: string): string | null {
  const db = getDatabase();
  const row = db.prepare('SELECT id FROM persona WHERE nombre LIKE ?').get(`%${nombre}%`) as any;
  return row?.id ?? null;
}

function cuotaScopeFilter(ctx: ToolContext, personaNombre?: string): { where: string; params: unknown[] } {
  // If a specific person is requested (for managers+)
  if (personaNombre && ctx.rol !== 'ae') {
    const pid = personaIdFromName(personaNombre);
    if (pid) {
      return { where: 'AND q.persona_id = ?', params: [pid] };
    }
  }

  if (ctx.rol === 'vp') return { where: '', params: [] };
  if (ctx.rol === 'director') {
    const ids = [ctx.persona_id, ...ctx.full_team_ids];
    return { where: `AND q.persona_id IN (${ids.map(() => '?').join(',')})`, params: ids };
  }
  if (ctx.rol === 'gerente') {
    const ids = [ctx.persona_id, ...ctx.team_ids];
    return { where: `AND q.persona_id IN (${ids.map(() => '?').join(',')})`, params: ids };
  }
  return { where: 'AND q.persona_id = ?', params: [ctx.persona_id] };
}

function activityScopeFilter(ctx: ToolContext, personaNombre?: string): { where: string; params: unknown[] } {
  if (personaNombre && ctx.rol !== 'ae') {
    const pid = personaIdFromName(personaNombre);
    if (pid) {
      return { where: 'AND a.ae_id = ?', params: [pid] };
    }
  }

  const scope = scopeFilter(ctx);
  return {
    where: scope.where.replace(/ae_id/g, 'a.ae_id'),
    params: scope.params,
  };
}

function proposalScopeFilter(ctx: ToolContext, personaNombre?: string): { where: string; params: unknown[] } {
  if (personaNombre && ctx.rol !== 'ae') {
    const pid = personaIdFromName(personaNombre);
    if (pid) {
      return { where: 'AND p.ae_id = ?', params: [pid] };
    }
  }

  const scope = scopeFilter(ctx);
  return {
    where: scope.where.replace(/ae_id/g, 'p.ae_id'),
    params: scope.params,
  };
}

function tendenciaCuota(
  db: InstanceType<any>,
  periodoSemanas: number,
  ctx: ToolContext,
  personaNombre?: string,
): string {
  const año = new Date().getFullYear();
  const scope = cuotaScopeFilter(ctx, personaNombre);

  const rows = db.prepare(`
    SELECT q.semana, q.año,
      SUM(q.meta_total) AS meta,
      SUM(q.logro) AS logro
    FROM cuota q
    WHERE (q.año * 100 + q.semana) >= (? * 100 + ?)
      ${scope.where}
    GROUP BY q.año, q.semana
    ORDER BY q.año, q.semana
  `).all(año, Math.max(1, getCurrentWeek() - periodoSemanas), ...scope.params) as any[];

  if (rows.length === 0) {
    return JSON.stringify({ metrica: 'cuota', semanas: periodoSemanas, tendencia: [], direccion: 'sin_datos', promedio_porcentaje: 0 });
  }

  const tendencia = rows.map((r: any) => ({
    semana: r.semana,
    año: r.año,
    meta: r.meta || 0,
    logro: r.logro || 0,
    porcentaje: r.meta > 0 ? Math.round((r.logro / r.meta) * 1000) / 10 : 0,
  }));

  const promedio = tendencia.reduce((s, t) => s + t.porcentaje, 0) / tendencia.length;

  // Direction: compare last 4 vs prior 4
  let direccion = 'estable';
  if (tendencia.length >= 8) {
    const recent = tendencia.slice(-4).reduce((s, t) => s + t.porcentaje, 0) / 4;
    const prior = tendencia.slice(-8, -4).reduce((s, t) => s + t.porcentaje, 0) / 4;
    if (recent > prior * 1.05) direccion = 'subiendo';
    else if (recent < prior * 0.95) direccion = 'bajando';
  }

  return JSON.stringify({
    metrica: 'cuota',
    semanas: periodoSemanas,
    tendencia,
    direccion,
    promedio_porcentaje: Math.round(promedio * 10) / 10,
  });
}

function tendenciaActividad(
  db: InstanceType<any>,
  periodoSemanas: number,
  ctx: ToolContext,
  personaNombre?: string,
): string {
  const scope = activityScopeFilter(ctx, personaNombre);

  const rows = db.prepare(`
    SELECT
      CAST(strftime('%W', a.fecha) AS INTEGER) AS semana,
      CAST(strftime('%Y', a.fecha) AS INTEGER) AS año,
      COUNT(*) AS total,
      a.tipo,
      a.sentimiento
    FROM actividad a
    WHERE a.fecha >= datetime('now', '-${periodoSemanas * 7} days')
      ${scope.where}
    GROUP BY año, semana, a.tipo, a.sentimiento
    ORDER BY año, semana
  `).all(...scope.params) as any[];

  // Aggregate into weekly buckets
  const weekMap = new Map<string, {
    semana: number; año: number; total: number;
    por_tipo: Record<string, number>;
    por_sentimiento: Record<string, number>;
  }>();

  for (const r of rows) {
    const key = `${r.año}-${r.semana}`;
    if (!weekMap.has(key)) {
      weekMap.set(key, { semana: r.semana, año: r.año, total: 0, por_tipo: {}, por_sentimiento: {} });
    }
    const w = weekMap.get(key)!;
    w.total += r.total;
    if (r.tipo) w.por_tipo[r.tipo] = (w.por_tipo[r.tipo] || 0) + r.total;
    if (r.sentimiento) w.por_sentimiento[r.sentimiento] = (w.por_sentimiento[r.sentimiento] || 0) + r.total;
  }

  const tendencia = Array.from(weekMap.values()).sort((a, b) => a.año * 100 + a.semana - (b.año * 100 + b.semana));
  const promedioSemanal = tendencia.length > 0
    ? Math.round(tendencia.reduce((s, t) => s + t.total, 0) / tendencia.length)
    : 0;

  return JSON.stringify({
    metrica: 'actividad',
    semanas: periodoSemanas,
    tendencia,
    promedio_semanal: promedioSemanal,
  });
}

function tendenciaPipeline(
  db: InstanceType<any>,
  periodoSemanas: number,
  ctx: ToolContext,
  personaNombre?: string,
): string {
  const scope = proposalScopeFilter(ctx, personaNombre);

  // New proposals per week
  const nuevasRows = db.prepare(`
    SELECT
      CAST(strftime('%W', p.fecha_creacion) AS INTEGER) AS semana,
      CAST(strftime('%Y', p.fecha_creacion) AS INTEGER) AS año,
      COUNT(*) AS nuevas,
      SUM(p.valor_estimado) AS valor_nuevo
    FROM propuesta p
    WHERE p.fecha_creacion >= datetime('now', '-${periodoSemanas * 7} days')
      ${scope.where}
    GROUP BY año, semana
    ORDER BY año, semana
  `).all(...scope.params) as any[];

  // Won/lost per week (by fecha_ultima_actividad for closed ones)
  const cerradasRows = db.prepare(`
    SELECT
      CAST(strftime('%W', p.fecha_ultima_actividad) AS INTEGER) AS semana,
      CAST(strftime('%Y', p.fecha_ultima_actividad) AS INTEGER) AS año,
      SUM(CASE WHEN p.etapa = 'completada' THEN 1 ELSE 0 END) AS ganadas,
      SUM(CASE WHEN p.etapa IN ('perdida','cancelada') THEN 1 ELSE 0 END) AS perdidas,
      SUM(CASE WHEN p.etapa = 'completada' THEN p.valor_estimado ELSE 0 END) AS valor_ganado
    FROM propuesta p
    WHERE p.etapa IN ('completada','perdida','cancelada')
      AND p.fecha_ultima_actividad >= datetime('now', '-${periodoSemanas * 7} days')
      ${scope.where}
    GROUP BY año, semana
    ORDER BY año, semana
  `).all(...scope.params) as any[];

  // Merge into weekly view
  const weekMap = new Map<string, {
    semana: number; año: number;
    nuevas: number; ganadas: number; perdidas: number;
    valor_nuevo: number; valor_ganado: number;
  }>();

  for (const r of nuevasRows) {
    const key = `${r.año}-${r.semana}`;
    weekMap.set(key, {
      semana: r.semana, año: r.año,
      nuevas: r.nuevas || 0, ganadas: 0, perdidas: 0,
      valor_nuevo: r.valor_nuevo || 0, valor_ganado: 0,
    });
  }

  for (const r of cerradasRows) {
    const key = `${r.año}-${r.semana}`;
    const existing = weekMap.get(key);
    if (existing) {
      existing.ganadas = r.ganadas || 0;
      existing.perdidas = r.perdidas || 0;
      existing.valor_ganado = r.valor_ganado || 0;
    } else {
      weekMap.set(key, {
        semana: r.semana, año: r.año,
        nuevas: 0, ganadas: r.ganadas || 0, perdidas: r.perdidas || 0,
        valor_nuevo: 0, valor_ganado: r.valor_ganado || 0,
      });
    }
  }

  const tendencia = Array.from(weekMap.values()).sort((a, b) => a.año * 100 + a.semana - (b.año * 100 + b.semana));
  const totalValorNuevo = tendencia.reduce((s, t) => s + t.valor_nuevo, 0);
  const totalValorGanado = tendencia.reduce((s, t) => s + t.valor_ganado, 0);

  return JSON.stringify({
    metrica: 'pipeline',
    semanas: periodoSemanas,
    tendencia,
    total_valor_nuevo: totalValorNuevo,
    total_valor_ganado: totalValorGanado,
  });
}

function tendenciaSentimiento(
  db: InstanceType<any>,
  periodoSemanas: number,
  ctx: ToolContext,
  personaNombre?: string,
): string {
  const scope = activityScopeFilter(ctx, personaNombre);

  const rows = db.prepare(`
    SELECT
      CAST(strftime('%W', a.fecha) AS INTEGER) AS semana,
      CAST(strftime('%Y', a.fecha) AS INTEGER) AS año,
      a.sentimiento,
      COUNT(*) AS conteo
    FROM actividad a
    WHERE a.fecha >= datetime('now', '-${periodoSemanas * 7} days')
      AND a.sentimiento IS NOT NULL
      ${scope.where}
    GROUP BY año, semana, a.sentimiento
    ORDER BY año, semana
  `).all(...scope.params) as any[];

  const weekMap = new Map<string, {
    semana: number; año: number;
    positivo: number; neutral: number; negativo: number; urgente: number;
  }>();

  for (const r of rows) {
    const key = `${r.año}-${r.semana}`;
    if (!weekMap.has(key)) {
      weekMap.set(key, { semana: r.semana, año: r.año, positivo: 0, neutral: 0, negativo: 0, urgente: 0 });
    }
    const w = weekMap.get(key)!;
    if (r.sentimiento in w) {
      (w as any)[r.sentimiento] += r.conteo;
    }
  }

  const tendencia = Array.from(weekMap.values())
    .sort((a, b) => a.año * 100 + a.semana - (b.año * 100 + b.semana))
    .map(w => {
      const total = w.positivo + w.neutral + w.negativo + w.urgente;
      return {
        ...w,
        ratio_positivo: total > 0 ? Math.round((w.positivo / total) * 1000) / 10 : 0,
      };
    });

  const allPositivo = tendencia.reduce((s, t) => s + t.positivo, 0);
  const allTotal = tendencia.reduce((s, t) => s + t.positivo + t.neutral + t.negativo + t.urgente, 0);

  return JSON.stringify({
    metrica: 'sentimiento',
    semanas: periodoSemanas,
    tendencia,
    ratio_positivo_promedio: allTotal > 0 ? Math.round((allPositivo / allTotal) * 1000) / 10 : 0,
  });
}

// ---------------------------------------------------------------------------
// Helper (same as consulta.ts)
// ---------------------------------------------------------------------------

function getCurrentWeek(): number {
  const d = new Date();
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7);
}
