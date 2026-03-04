/**
 * Event Query Tools
 *
 * consultar_eventos — browse upcoming sporting/industry events
 * consultar_inventario_evento — detailed inventory for a specific event
 */

import { getDatabase } from '../db.js';
import type { ToolContext } from './index.js';

// ---------------------------------------------------------------------------
// consultar_eventos
// ---------------------------------------------------------------------------

export function consultar_eventos(args: Record<string, unknown>, _ctx: ToolContext): string {
  const db = getDatabase();
  const tipo = args.tipo as string | undefined;
  const diasAdelante = (args.dias_adelante as number) || 90;

  const today = new Date().toISOString().slice(0, 10);
  const futureDate = new Date(Date.now() + diasAdelante * 86400000).toISOString().slice(0, 10);

  let where = 'WHERE fecha_inicio >= ? AND fecha_inicio <= ?';
  const params: unknown[] = [today, futureDate];

  if (tipo) {
    where += ' AND tipo = ?';
    params.push(tipo);
  }

  const rows = db.prepare(`
    SELECT id, nombre, tipo, fecha_inicio, fecha_fin,
           inventario_total, inventario_vendido, meta_ingresos, ingresos_actual, prioridad
    FROM crm_events
    ${where}
    ORDER BY fecha_inicio
    LIMIT 50
  `).all(...params) as any[];

  if (rows.length === 0) {
    return JSON.stringify({ mensaje: 'No hay eventos en el periodo indicado.' });
  }

  return JSON.stringify({
    total: rows.length,
    eventos: rows.map(r => {
      const diasPara = Math.ceil((new Date(r.fecha_inicio).getTime() - Date.now()) / 86400000);
      let disponibilidad: string | undefined;
      if (r.inventario_total && r.inventario_vendido) {
        try {
          const total = JSON.parse(r.inventario_total);
          const vendido = JSON.parse(r.inventario_vendido);
          const totalUnits = Object.values(total).reduce((s: number, v: any) => s + Number(v), 0);
          const soldUnits = Object.values(vendido).reduce((s: number, v: any) => s + Number(v), 0);
          disponibilidad = totalUnits > 0 ? `${Math.round((1 - soldUnits / totalUnits) * 100)}% disponible` : undefined;
        } catch { /* ignore parse errors */ }
      }
      return {
        nombre: r.nombre,
        tipo: r.tipo,
        fecha_inicio: r.fecha_inicio,
        fecha_fin: r.fecha_fin,
        dias_para: diasPara,
        prioridad: r.prioridad,
        disponibilidad,
        meta_ingresos: r.meta_ingresos,
        ingresos_actual: r.ingresos_actual,
      };
    }),
  });
}

// ---------------------------------------------------------------------------
// consultar_inventario_evento
// ---------------------------------------------------------------------------

export function consultar_inventario_evento(args: Record<string, unknown>, _ctx: ToolContext): string {
  const db = getDatabase();
  const nombre = args.evento_nombre as string;

  const evento = db.prepare('SELECT * FROM crm_events WHERE nombre LIKE ?').get(`%${nombre}%`) as any;
  if (!evento) {
    return JSON.stringify({ error: `No encontre el evento "${nombre}".` });
  }

  const result: { medio: string; total: number; vendido: number; disponible_pct: number }[] = [];

  try {
    const total = evento.inventario_total ? JSON.parse(evento.inventario_total) : {};
    const vendido = evento.inventario_vendido ? JSON.parse(evento.inventario_vendido) : {};

    for (const medio of Object.keys(total)) {
      const t = Number(total[medio]) || 0;
      const v = Number(vendido[medio]) || 0;
      result.push({
        medio,
        total: t,
        vendido: v,
        disponible_pct: t > 0 ? Math.round((1 - v / t) * 100) : 100,
      });
    }
  } catch {
    return JSON.stringify({ error: 'Error al procesar inventario del evento.' });
  }

  return JSON.stringify({
    evento: {
      nombre: evento.nombre,
      tipo: evento.tipo,
      fecha_inicio: evento.fecha_inicio,
      fecha_fin: evento.fecha_fin,
      prioridad: evento.prioridad,
      meta_ingresos: evento.meta_ingresos,
      ingresos_actual: evento.ingresos_actual,
    },
    inventario: result,
  });
}
