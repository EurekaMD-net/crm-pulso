/**
 * Query Tools — Read-only CRM queries
 *
 * All queries respect role-based scoping via ToolContext.
 * AE sees own data. Gerente sees direct reports. Director/VP see broader scope.
 */

import { getDatabase } from '../db.js';
import type { ToolContext } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
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

function getCurrentWeek(): number {
  const d = new Date();
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7);
}

// ---------------------------------------------------------------------------
// consultar_pipeline
// ---------------------------------------------------------------------------

export function consultar_pipeline(args: Record<string, unknown>, ctx: ToolContext): string {
  const db = getDatabase();
  const scope = scopeFilter(ctx);

  let where = 'WHERE 1=1 ' + scope.where.replace(/ae_id/g, 'p.ae_id');
  const params: unknown[] = [...scope.params];

  if (args.etapa) {
    where += ' AND p.etapa = ?';
    params.push(args.etapa);
  }
  if (args.cuenta_nombre) {
    const cid = findCuentaId(args.cuenta_nombre as string);
    if (cid) { where += ' AND p.cuenta_id = ?'; params.push(cid); }
  }
  if (args.tipo_oportunidad) {
    where += ' AND p.tipo_oportunidad = ?';
    params.push(args.tipo_oportunidad);
  }
  if (args.solo_estancadas) {
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
    LIMIT 50
  `).all(...params) as any[];

  if (rows.length === 0) {
    return JSON.stringify({ mensaje: 'No hay propuestas con esos filtros.' });
  }

  const total = rows.reduce((sum, r) => sum + (r.valor_estimado || 0), 0);
  return JSON.stringify({
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
  });
}

// ---------------------------------------------------------------------------
// consultar_descarga
// ---------------------------------------------------------------------------

export function consultar_descarga(args: Record<string, unknown>, ctx: ToolContext): string {
  const db = getDatabase();
  const semana = (args.semana as number) || getCurrentWeek();
  const año = (args.año as number) || new Date().getFullYear();

  let where = 'WHERE d.año = ? AND d.semana = ?';
  const params: unknown[] = [año, semana];

  if (args.cuenta_nombre) {
    const cid = findCuentaId(args.cuenta_nombre as string);
    if (cid) { where += ' AND d.cuenta_id = ?'; params.push(cid); }
  }

  // Scope: filter by accounts assigned to the person's team
  if (ctx.rol === 'ae') {
    where += ' AND c.ae_id = ?';
    params.push(ctx.persona_id);
  } else if (ctx.rol === 'gerente') {
    const ids = [ctx.persona_id, ...ctx.team_ids];
    where += ` AND c.ae_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }

  const rows = db.prepare(`
    SELECT c.nombre AS cuenta, d.planificado, d.facturado, d.gap, d.gap_acumulado, d.notas_ae
    FROM descarga d
    JOIN cuenta c ON d.cuenta_id = c.id
    ${where}
    ORDER BY d.gap DESC
  `).all(...params) as any[];

  if (rows.length === 0) {
    return JSON.stringify({ mensaje: `No hay datos de descarga para semana ${semana}/${año}.` });
  }

  const totalPlan = rows.reduce((s, r) => s + (r.planificado || 0), 0);
  const totalFact = rows.reduce((s, r) => s + (r.facturado || 0), 0);

  return JSON.stringify({
    semana, año,
    total_planificado: totalPlan,
    total_facturado: totalFact,
    gap_total: totalPlan - totalFact,
    cuentas: rows.map(r => ({
      cuenta: r.cuenta,
      planificado: r.planificado,
      facturado: r.facturado,
      gap: r.gap,
      gap_acumulado: r.gap_acumulado,
      notas: r.notas_ae,
    })),
  });
}

// ---------------------------------------------------------------------------
// consultar_cuota
// ---------------------------------------------------------------------------

export function consultar_cuota(args: Record<string, unknown>, ctx: ToolContext): string {
  const db = getDatabase();
  const semana = (args.semana as number) || getCurrentWeek();
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
    SELECT p.nombre, q.meta_total, q.logro, q.porcentaje, q.rol
    FROM cuota q
    JOIN persona p ON q.persona_id = p.id
    ${where}
    ORDER BY q.porcentaje DESC
  `).all(...params) as any[];

  if (rows.length === 0) {
    return JSON.stringify({ mensaje: `No hay datos de cuota para semana ${semana}/${año}.` });
  }

  return JSON.stringify({
    semana, año,
    cuotas: rows.map(r => ({
      nombre: r.nombre,
      meta: r.meta_total,
      logro: r.logro,
      porcentaje: Math.round(r.porcentaje * 10) / 10,
      rol: r.rol,
    })),
  });
}

// ---------------------------------------------------------------------------
// consultar_cuenta
// ---------------------------------------------------------------------------

export function consultar_cuenta(args: Record<string, unknown>, ctx: ToolContext): string {
  const db = getDatabase();
  const nombre = args.cuenta_nombre as string;
  const cuenta = db.prepare('SELECT * FROM cuenta WHERE nombre LIKE ?').get(`%${nombre}%`) as any;
  if (!cuenta) {
    return JSON.stringify({ error: `No encontré la cuenta "${nombre}".` });
  }

  const contactos = db.prepare('SELECT nombre, rol, seniority, email, telefono FROM contacto WHERE cuenta_id = ?').all(cuenta.id) as any[];
  const propuestas = db.prepare(`
    SELECT titulo, valor_estimado, etapa, dias_sin_actividad, fecha_ultima_actividad
    FROM propuesta WHERE cuenta_id = ? AND etapa NOT IN ('completada','perdida','cancelada')
    ORDER BY valor_estimado DESC
  `).all(cuenta.id) as any[];
  const contrato = db.prepare('SELECT * FROM contrato WHERE cuenta_id = ? ORDER BY año DESC LIMIT 1').get(cuenta.id) as any;
  const actividades = db.prepare(`
    SELECT a.tipo, a.resumen, a.sentimiento, a.fecha, p.nombre AS ae
    FROM actividad a
    LEFT JOIN persona p ON a.ae_id = p.id
    WHERE a.cuenta_id = ? ORDER BY a.fecha DESC LIMIT 10
  `).all(cuenta.id) as any[];

  return JSON.stringify({
    cuenta: {
      nombre: cuenta.nombre,
      tipo: cuenta.tipo,
      vertical: cuenta.vertical,
      agencia_medios: cuenta.agencia_medios,
      años_relacion: cuenta.años_relacion,
      es_fundador: cuenta.es_fundador === 1,
    },
    contactos,
    propuestas_activas: propuestas,
    contrato_vigente: contrato ? {
      año: contrato.año,
      monto: contrato.monto_comprometido,
      estatus: contrato.estatus,
    } : null,
    actividades_recientes: actividades.map((a: any) => ({ ...a, ejecutivo: a.ae, ae: undefined })),
  });
}

// ---------------------------------------------------------------------------
// consultar_actividades
// ---------------------------------------------------------------------------

export function consultar_actividades(args: Record<string, unknown>, ctx: ToolContext): string {
  const db = getDatabase();
  const limite = (args.limite as number) || 20;
  const scope = scopeFilter(ctx);

  let where = 'WHERE 1=1 ' + scope.where;
  const params: unknown[] = [...scope.params];

  if (args.cuenta_nombre) {
    const cid = findCuentaId(args.cuenta_nombre as string);
    if (cid) { where += ' AND a.cuenta_id = ?'; params.push(cid); }
  }
  if (args.propuesta_titulo) {
    where += ' AND pr.titulo LIKE ?';
    params.push(`%${args.propuesta_titulo}%`);
  }

  const rows = db.prepare(`
    SELECT a.tipo, a.resumen, a.sentimiento, a.fecha, a.siguiente_accion,
           c.nombre AS cuenta, pr.titulo AS propuesta, p.nombre AS ae
    FROM actividad a
    LEFT JOIN cuenta c ON a.cuenta_id = c.id
    LEFT JOIN propuesta pr ON a.propuesta_id = pr.id
    LEFT JOIN persona p ON a.ae_id = p.id
    ${where}
    ORDER BY a.fecha DESC
    LIMIT ?
  `).all(...params, limite) as any[];

  if (rows.length === 0) {
    return JSON.stringify({ mensaje: 'No hay actividades con esos filtros.' });
  }

  return JSON.stringify({
    total: rows.length,
    actividades: rows.map(r => ({
      tipo: r.tipo,
      resumen: r.resumen,
      sentimiento: r.sentimiento,
      fecha: r.fecha,
      cuenta: r.cuenta,
      propuesta: r.propuesta,
      ejecutivo: r.ae,
      siguiente_accion: r.siguiente_accion,
    })),
  });
}

// ---------------------------------------------------------------------------
// consultar_inventario
// ---------------------------------------------------------------------------

export function consultar_inventario(args: Record<string, unknown>, _ctx: ToolContext): string {
  const db = getDatabase();

  let where = 'WHERE 1=1';
  const params: unknown[] = [];

  if (args.medio) {
    where += ' AND medio = ?';
    params.push(args.medio);
  }
  if (args.propiedad) {
    where += ' AND propiedad LIKE ?';
    params.push(`%${args.propiedad}%`);
  }

  const rows = db.prepare(`
    SELECT medio, propiedad, formato, unidad_venta, precio_referencia, precio_piso, cpm_referencia, disponibilidad
    FROM inventario
    ${where}
    ORDER BY medio, propiedad
  `).all(...params) as any[];

  if (rows.length === 0) {
    return JSON.stringify({ mensaje: 'No hay productos en inventario con esos filtros.' });
  }

  return JSON.stringify({ productos: rows });
}
