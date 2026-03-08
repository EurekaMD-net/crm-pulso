/**
 * Dashboard API — JSON endpoint handlers
 *
 * Each handler takes query params + ToolContext and returns a JSON-serializable object.
 * Reuses the same scopeFilter pattern as CRM tools for identical permissions.
 */

import { getDatabase } from '../db.js';
import type { ToolContext } from '../tools/index.js';

// ---------------------------------------------------------------------------
// Shared helpers (same pattern as crm/src/tools/consulta.ts)
// ---------------------------------------------------------------------------

function scopeFilter(ctx: ToolContext, alias = 'ae_id'): { where: string; params: string[] } {
  if (ctx.rol === 'vp') return { where: '', params: [] };
  if (ctx.rol === 'director') {
    const ids = [ctx.persona_id, ...ctx.full_team_ids];
    return { where: `AND ${alias} IN (${ids.map(() => '?').join(',')})`, params: ids };
  }
  if (ctx.rol === 'gerente') {
    const ids = [ctx.persona_id, ...ctx.team_ids];
    return { where: `AND ${alias} IN (${ids.map(() => '?').join(',')})`, params: ids };
  }
  return { where: `AND ${alias} = ?`, params: [ctx.persona_id] };
}

function getCurrentWeek(): number {
  const d = new Date();
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7);
}

// ---------------------------------------------------------------------------
// GET /api/v1/pipeline
// ---------------------------------------------------------------------------

export function getPipeline(query: Record<string, string>, ctx: ToolContext): unknown {
  const db = getDatabase();
  const scope = scopeFilter(ctx, 'p.ae_id');

  let where = 'WHERE 1=1 ' + scope.where;
  const params: unknown[] = [...scope.params];

  if (query.etapa) {
    where += ' AND p.etapa = ?';
    params.push(query.etapa);
  }
  if (query.ejecutivo) {
    where += ' AND p.ae_id = ?';
    params.push(query.ejecutivo);
  }
  if (query.solo_estancadas === 'true') {
    where += ' AND p.dias_sin_actividad >= 7';
  }

  const rows = db.prepare(`
    SELECT p.titulo, c.nombre AS cuenta, p.valor_estimado, p.etapa,
           p.dias_sin_actividad, p.fecha_ultima_actividad, p.es_mega,
           per.nombre AS ae_nombre
    FROM propuesta p
    LEFT JOIN cuenta c ON p.cuenta_id = c.id
    LEFT JOIN persona per ON p.ae_id = per.id
    ${where}
    ORDER BY p.valor_estimado DESC NULLS LAST
    LIMIT 100
  `).all(...params) as any[];

  const total = rows.reduce((sum, r) => sum + (r.valor_estimado || 0), 0);
  return {
    total_propuestas: rows.length,
    valor_total: total,
    propuestas: rows.map(r => ({
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

export function getCuota(query: Record<string, string>, ctx: ToolContext): unknown {
  const db = getDatabase();
  const semana = query.semana ? parseInt(query.semana, 10) : getCurrentWeek();
  const año = new Date().getFullYear();

  let where = 'WHERE q.año = ? AND q.semana = ?';
  const params: unknown[] = [año, semana];

  if (ctx.rol === 'ae') {
    where += ' AND q.persona_id = ?';
    params.push(ctx.persona_id);
  } else if (ctx.rol === 'gerente') {
    const ids = [ctx.persona_id, ...ctx.team_ids];
    where += ` AND q.persona_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  } else if (ctx.rol === 'director') {
    const ids = [ctx.persona_id, ...ctx.full_team_ids];
    where += ` AND q.persona_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }

  const rows = db.prepare(`
    SELECT q.persona_id, p.nombre, q.meta_total, q.logro, q.porcentaje, q.rol
    FROM cuota q
    JOIN persona p ON q.persona_id = p.id
    ${where}
    ORDER BY q.porcentaje DESC
  `).all(...params) as any[];

  return {
    semana,
    año,
    cuotas: rows.map(r => ({
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

export function getDescarga(query: Record<string, string>, ctx: ToolContext): unknown {
  const db = getDatabase();
  const semana = query.semana ? parseInt(query.semana, 10) : getCurrentWeek();
  const año = query.año ? parseInt(query.año, 10) : new Date().getFullYear();

  let where = 'WHERE d.año = ? AND d.semana = ?';
  const params: unknown[] = [año, semana];

  if (query.cuenta) {
    where += ' AND c.nombre LIKE ?';
    params.push(`%${query.cuenta}%`);
  }

  if (ctx.rol === 'ae') {
    where += ' AND c.ae_id = ?';
    params.push(ctx.persona_id);
  } else if (ctx.rol === 'gerente') {
    const ids = [ctx.persona_id, ...ctx.team_ids];
    where += ` AND c.ae_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  } else if (ctx.rol === 'director') {
    const ids = [ctx.persona_id, ...ctx.full_team_ids];
    where += ` AND c.ae_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }

  const rows = db.prepare(`
    SELECT c.nombre AS cuenta, d.planificado, d.facturado, d.gap, d.gap_acumulado
    FROM descarga d
    JOIN cuenta c ON d.cuenta_id = c.id
    ${where}
    ORDER BY d.gap DESC
  `).all(...params) as any[];

  const totalPlan = rows.reduce((s, r) => s + (r.planificado || 0), 0);
  const totalFact = rows.reduce((s, r) => s + (r.facturado || 0), 0);

  return {
    semana,
    año,
    total_planificado: totalPlan,
    total_facturado: totalFact,
    gap_total: totalPlan - totalFact,
    cuentas: rows.map(r => ({
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

export function getActividades(query: Record<string, string>, ctx: ToolContext): unknown {
  const db = getDatabase();
  const limite = query.limite ? parseInt(query.limite, 10) : 50;
  const scope = scopeFilter(ctx, 'a.ae_id');

  let where = 'WHERE 1=1 ' + scope.where;
  const params: unknown[] = [...scope.params];

  if (query.ejecutivo) {
    where += ' AND a.ae_id = ?';
    params.push(query.ejecutivo);
  }
  if (query.cuenta) {
    where += ' AND c.nombre LIKE ?';
    params.push(`%${query.cuenta}%`);
  }

  const rows = db.prepare(`
    SELECT a.tipo, a.resumen, a.sentimiento, a.fecha,
           c.nombre AS cuenta, pr.titulo AS propuesta, p.nombre AS ae
    FROM actividad a
    LEFT JOIN cuenta c ON a.cuenta_id = c.id
    LEFT JOIN propuesta pr ON a.propuesta_id = pr.id
    LEFT JOIN persona p ON a.ae_id = p.id
    ${where}
    ORDER BY a.fecha DESC
    LIMIT ?
  `).all(...params, limite) as any[];

  return {
    total: rows.length,
    actividades: rows.map(r => ({
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

export function getEquipo(_query: Record<string, string>, ctx: ToolContext): unknown {
  const db = getDatabase();

  let where = 'WHERE p.activo = 1';
  const params: unknown[] = [];

  // Scope: only show the hierarchy the user can see
  if (ctx.rol === 'ae') {
    where += ' AND p.id = ?';
    params.push(ctx.persona_id);
  } else if (ctx.rol === 'gerente') {
    const ids = [ctx.persona_id, ...ctx.team_ids];
    where += ` AND p.id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  } else if (ctx.rol === 'director') {
    const ids = [ctx.persona_id, ...ctx.full_team_ids];
    where += ` AND p.id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }
  // VP: no filter, sees all

  const rows = db.prepare(`
    SELECT p.id, p.nombre, p.rol, p.reporta_a, m.nombre AS manager_nombre
    FROM persona p
    LEFT JOIN persona m ON p.reporta_a = m.id
    ${where}
    ORDER BY
      CASE p.rol WHEN 'vp' THEN 0 WHEN 'director' THEN 1 WHEN 'gerente' THEN 2 ELSE 3 END,
      p.nombre
  `).all(...params) as any[];

  return {
    total: rows.length,
    personas: rows.map(r => ({
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

export function getAlertas(query: Record<string, string>, ctx: ToolContext): unknown {
  const db = getDatabase();
  const dias = query.dias ? parseInt(query.dias, 10) : 7;

  let where = `WHERE a.fecha_envio >= datetime('now', '-${dias} days')`;
  const params: unknown[] = [];

  // Scope: only show alerts for groups the user has access to
  if (ctx.rol === 'ae') {
    where += ' AND a.grupo_destino IN (SELECT whatsapp_group_folder FROM persona WHERE id = ?)';
    params.push(ctx.persona_id);
  } else if (ctx.rol === 'gerente') {
    const ids = [ctx.persona_id, ...ctx.team_ids];
    where += ` AND a.grupo_destino IN (SELECT whatsapp_group_folder FROM persona WHERE id IN (${ids.map(() => '?').join(',')}))`;
    params.push(...ids);
  } else if (ctx.rol === 'director') {
    const ids = [ctx.persona_id, ...ctx.full_team_ids];
    where += ` AND a.grupo_destino IN (SELECT whatsapp_group_folder FROM persona WHERE id IN (${ids.map(() => '?').join(',')}))`;
    params.push(...ids);
  }

  // Filter out -mgr/-vp escalation copies and deduplicate by (tipo, base_entity)
  where += ` AND a.entidad_id NOT LIKE '%-mgr' AND a.entidad_id NOT LIKE '%-vp'`;

  const rows = db.prepare(`
    SELECT a.alerta_tipo, a.entidad_id, a.grupo_destino, MAX(a.fecha_envio) AS fecha_envio
    FROM alerta_log a
    ${where}
    GROUP BY a.alerta_tipo, a.entidad_id
    ORDER BY fecha_envio DESC
    LIMIT 50
  `).all(...params) as any[];

  // Resolve entity IDs to human-readable names
  const resolveEntity = (tipo: string, entityId: string): string => {
    try {
      if (tipo === 'inactividad_ae') {
        const p = db.prepare('SELECT nombre FROM persona WHERE id = ?').get(entityId) as any;
        return p?.nombre || entityId;
      }
      if (tipo === 'descarga_gap') {
        const c = db.prepare('SELECT nombre FROM cuenta WHERE id = ?').get(entityId) as any;
        return c?.nombre || entityId;
      }
      if (tipo === 'propuesta_estancada' || tipo === 'mega_deal_movimiento') {
        const pr = db.prepare('SELECT titulo FROM propuesta WHERE id = ?').get(entityId) as any;
        return pr?.titulo || entityId;
      }
      if (tipo === 'coaching_alert' || tipo === 'cuota_alert') {
        const p = db.prepare('SELECT nombre FROM persona WHERE id = ?').get(entityId) as any;
        return p?.nombre || entityId;
      }
    } catch {}
    return entityId;
  };

  const TIPO_LABELS: Record<string, string> = {
    descarga_gap: 'Gap descarga',
    propuesta_estancada: 'Deal estancado',
    inactividad_ae: 'AE inactivo',
    mega_deal_movimiento: 'Mega-deal',
    coaching_alert: 'Coaching',
    cuota_alert: 'Cuota',
    evento_countdown: 'Evento',
  };

  return {
    total: rows.length,
    alertas: rows.map(r => ({
      tipo: TIPO_LABELS[r.alerta_tipo] || r.alerta_tipo,
      entidad: resolveEntity(r.alerta_tipo, r.entidad_id),
      fecha: r.fecha_envio,
    })),
  };
}
