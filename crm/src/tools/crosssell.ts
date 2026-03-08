/**
 * Cross-sell Recommendation Tool
 *
 * Analyzes an account's purchase history and compares against peer accounts
 * (same vertical or tipo) to surface upsell/cross-sell opportunities.
 *
 * Signals used:
 * 1. Opportunity type gaps — tipos peers use that this account hasn't
 * 2. Value gap — account spends less than vertical average
 * 3. Activity recency — accounts with recent positive sentiment = warm
 * 4. Upcoming events — crm_events that match the account profile
 * 5. Peer success — what's working for similar accounts
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
    return { where: `AND c.ae_id IN (${ids.map(() => '?').join(',')})`, params: ids };
  }
  if (ctx.rol === 'gerente') {
    const ids = [ctx.persona_id, ...ctx.team_ids];
    return { where: `AND c.ae_id IN (${ids.map(() => '?').join(',')})`, params: ids };
  }
  return { where: 'AND c.ae_id = ?', params: [ctx.persona_id] };
}

interface Recommendation {
  tipo: 'tipo_oportunidad' | 'valor_upsell' | 'evento' | 'reactivacion';
  titulo: string;
  detalle: string;
  valor_potencial: number | null;
  confianza: 'alta' | 'media' | 'baja';
}

// ---------------------------------------------------------------------------
// recomendar_crosssell
// ---------------------------------------------------------------------------

export function recomendar_crosssell(args: Record<string, unknown>, ctx: ToolContext): string {
  const db = getDatabase();
  const cuentaNombre = args.cuenta_nombre as string;
  const limite = (args.limite as number) || 5;

  if (!cuentaNombre) {
    return JSON.stringify({ error: 'Se requiere cuenta_nombre.' });
  }

  // Verify scope access
  const scope = scopeFilter(ctx);
  const cuenta = db.prepare(`
    SELECT c.id, c.nombre, c.vertical, c.tipo, c.ae_id, c.años_relacion, c.es_fundador
    FROM cuenta c
    WHERE c.nombre LIKE ? ${scope.where}
  `).get(`%${cuentaNombre}%`, ...scope.params) as any;

  if (!cuenta) {
    return JSON.stringify({ error: `No encontré la cuenta "${cuentaNombre}" o no tienes acceso.` });
  }

  // 1. Account's completed proposals (what they've bought)
  const accountProps = db.prepare(`
    SELECT tipo_oportunidad, COUNT(*) as c, SUM(valor_estimado) as val
    FROM propuesta
    WHERE cuenta_id = ? AND etapa = 'completada'
    GROUP BY tipo_oportunidad
  `).all(cuenta.id) as any[];

  const accountTipos = new Set(accountProps.map((r: any) => r.tipo_oportunidad).filter(Boolean));
  const accountTotalValue = accountProps.reduce((s: number, r: any) => s + (r.val || 0), 0);

  // 2. Account's active proposals (what's in flight)
  const activeProps = db.prepare(`
    SELECT tipo_oportunidad, COUNT(*) as c
    FROM propuesta
    WHERE cuenta_id = ? AND etapa NOT IN ('completada','perdida','cancelada')
    GROUP BY tipo_oportunidad
  `).all(cuenta.id) as any[];

  const activeTipos = new Set(activeProps.map((r: any) => r.tipo_oportunidad).filter(Boolean));

  // 3. Peer analysis — same vertical accounts
  const peerProps = db.prepare(`
    SELECT p.tipo_oportunidad, COUNT(*) as c, AVG(p.valor_estimado) as avg_val,
           SUM(p.valor_estimado) as total_val, COUNT(DISTINCT p.cuenta_id) as num_cuentas
    FROM propuesta p
    JOIN cuenta c ON p.cuenta_id = c.id
    WHERE c.vertical = ? AND c.id != ? AND p.etapa = 'completada'
    GROUP BY p.tipo_oportunidad
  `).all(cuenta.vertical, cuenta.id) as any[];

  // 4. Peer total value for comparison
  const peerAvgValue = db.prepare(`
    SELECT AVG(total) as avg_total FROM (
      SELECT SUM(p.valor_estimado) as total
      FROM propuesta p
      JOIN cuenta c ON p.cuenta_id = c.id
      WHERE c.vertical = ? AND c.id != ? AND p.etapa = 'completada'
      GROUP BY p.cuenta_id
    )
  `).get(cuenta.vertical, cuenta.id) as any;

  // 5. Recent sentiment for this account
  const sentiment = db.prepare(`
    SELECT sentimiento, COUNT(*) as c
    FROM actividad
    WHERE cuenta_id = ? AND fecha >= datetime('now', '-30 days')
    GROUP BY sentimiento
  `).all(cuenta.id) as any[];

  const sentimentMap: Record<string, number> = {};
  for (const s of sentiment) sentimentMap[s.sentimiento] = s.c;
  const recentPositive = (sentimentMap['positivo'] || 0);
  const recentNegative = (sentimentMap['negativo'] || 0) + (sentimentMap['urgente'] || 0);
  const isWarm = recentPositive > recentNegative;

  // 6. Upcoming events
  const events = db.prepare(`
    SELECT nombre, tipo, fecha_inicio, meta_ingresos, ingresos_actual
    FROM crm_events
    WHERE fecha_inicio >= datetime('now') AND fecha_inicio <= datetime('now', '+90 days')
    ORDER BY fecha_inicio
    LIMIT 5
  `).all() as any[];

  // 7. Last activity date
  const lastActivity = db.prepare(`
    SELECT fecha FROM actividad WHERE cuenta_id = ? ORDER BY fecha DESC LIMIT 1
  `).get(cuenta.id) as any;

  const daysSinceActivity = lastActivity
    ? Math.floor((Date.now() - new Date(lastActivity.fecha).getTime()) / 86400000)
    : null;

  // ---------------------------------------------------------------------------
  // Generate recommendations
  // ---------------------------------------------------------------------------

  const recommendations: Recommendation[] = [];

  // Signal 1: Opportunity type gaps
  for (const peer of peerProps) {
    if (!peer.tipo_oportunidad) continue;
    if (accountTipos.has(peer.tipo_oportunidad)) continue; // already bought
    if (activeTipos.has(peer.tipo_oportunidad)) continue;  // already in flight

    const peerLabel: Record<string, string> = {
      estacional: 'campañas estacionales',
      lanzamiento: 'lanzamientos de producto',
      reforzamiento: 'reforzamiento de marca',
      evento_especial: 'eventos especiales',
      tentpole: 'tentpoles (grandes eventos)',
      prospeccion: 'prospección/nuevos formatos',
    };

    recommendations.push({
      tipo: 'tipo_oportunidad',
      titulo: `${peerLabel[peer.tipo_oportunidad] || peer.tipo_oportunidad}`,
      detalle: `${peer.num_cuentas} cuenta(s) en ${cuenta.vertical} compran ${peer.tipo_oportunidad} (prom. $${(peer.avg_val / 1e6).toFixed(1)}M). ${cuenta.nombre} no lo ha usado.`,
      valor_potencial: Math.round(peer.avg_val),
      confianza: peer.num_cuentas >= 2 ? 'alta' : 'media',
    });
  }

  // Signal 2: Value upsell — account below vertical average
  if (peerAvgValue?.avg_total && accountTotalValue > 0) {
    const gap = peerAvgValue.avg_total - accountTotalValue;
    if (gap > 1_000_000) {
      recommendations.push({
        tipo: 'valor_upsell',
        titulo: 'Incrementar inversión al promedio de la vertical',
        detalle: `${cuenta.nombre} ha invertido $${(accountTotalValue / 1e6).toFixed(1)}M vs promedio vertical de $${(peerAvgValue.avg_total / 1e6).toFixed(1)}M. Gap de $${(gap / 1e6).toFixed(1)}M.`,
        valor_potencial: Math.round(gap),
        confianza: 'media',
      });
    }
  }

  // Signal 3: Upcoming events
  for (const ev of events) {
    const remaining = ev.meta_ingresos ? ev.meta_ingresos - (ev.ingresos_actual || 0) : null;
    if (remaining && remaining > 0) {
      recommendations.push({
        tipo: 'evento',
        titulo: `Oportunidad en ${ev.nombre}`,
        detalle: `Evento ${ev.tipo} inicia ${ev.fecha_inicio.split('T')[0]}. Meta: $${(ev.meta_ingresos / 1e6).toFixed(1)}M, vendido: $${((ev.ingresos_actual || 0) / 1e6).toFixed(1)}M. Inventario disponible.`,
        valor_potencial: Math.round(Math.min(remaining * 0.1, 5_000_000)), // conservative 10% share
        confianza: 'baja',
      });
    }
  }

  // Signal 4: Reactivation — no recent activity on an account with history
  if (daysSinceActivity !== null && daysSinceActivity > 21 && accountTotalValue > 0) {
    recommendations.push({
      tipo: 'reactivacion',
      titulo: 'Reactivar relación',
      detalle: `${daysSinceActivity} días sin actividad. Historial de $${(accountTotalValue / 1e6).toFixed(1)}M en propuestas ganadas. ${isWarm ? 'Último sentimiento positivo — buen momento para contactar.' : 'Revisar relación antes de proponer.'}`,
      valor_potencial: null,
      confianza: isWarm ? 'alta' : 'media',
    });
  }

  // Sort: alta > media > baja, then by valor_potencial desc
  const confianzaOrder: Record<string, number> = { alta: 0, media: 1, baja: 2 };
  recommendations.sort((a, b) => {
    const c = confianzaOrder[a.confianza] - confianzaOrder[b.confianza];
    if (c !== 0) return c;
    return (b.valor_potencial || 0) - (a.valor_potencial || 0);
  });

  const limited = recommendations.slice(0, limite);

  return JSON.stringify({
    cuenta: cuenta.nombre,
    vertical: cuenta.vertical,
    tipo: cuenta.tipo,
    historial: {
      tipos_comprados: Array.from(accountTipos),
      tipos_en_vuelo: Array.from(activeTipos),
      valor_total_ganado: accountTotalValue,
      años_relacion: cuenta.años_relacion,
      es_fundador: cuenta.es_fundador === 1,
    },
    sentimiento_reciente: {
      positivo: sentimentMap['positivo'] || 0,
      neutral: sentimentMap['neutral'] || 0,
      negativo: sentimentMap['negativo'] || 0,
      urgente: sentimentMap['urgente'] || 0,
      es_calido: isWarm,
    },
    recomendaciones: limited,
    total_recomendaciones: recommendations.length,
  });
}
