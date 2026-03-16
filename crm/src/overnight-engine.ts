/**
 * Overnight Commercial Analysis Engine
 *
 * Runs at 2 AM MX via IPC. Scans all accounts against events, inventory,
 * billing gaps, peer comparisons, and market signals. Produces structured
 * insights in insight_comercial table.
 *
 * 5 analyzers:
 *   1. Calendar-driven — brands that bought for an event last year but haven't been contacted
 *   2. Inventory-driven — unsold event inventory matched to account profiles
 *   3. Gap-driven — billing below plan, recovery opportunity
 *   4. Cross-sell — peer vertical gaps (shared modules)
 *   5. Market-driven — expiring contracts, inactive accounts
 */

import { getDatabase } from "./db.js";
import { logger } from "./logger.js";
import { comparePeers } from "./analysis/peer-comparison.js";
import { getDaysSinceActivity } from "./analysis/media-mix.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OvernightResult {
  lote: string;
  calendar: number;
  inventory: number;
  gap: number;
  crosssell: number;
  market: number;
  total_generated: number;
  expired: number;
}

function genId(): string {
  return `ins-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Dedup: skip if same (tipo, cuenta_id) with similar titulo in last 7 days
// ---------------------------------------------------------------------------

function isDuplicate(
  db: ReturnType<typeof getDatabase>,
  tipo: string,
  cuentaId: string,
  titulo: string,
): boolean {
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const existing = db
    .prepare(
      `SELECT 1 FROM insight_comercial
       WHERE tipo = ? AND cuenta_id = ? AND titulo = ?
         AND fecha_generacion >= ? AND estado NOT IN ('expirado','descartado')`,
    )
    .get(tipo, cuentaId, titulo, cutoff);
  return !!existing;
}

// ---------------------------------------------------------------------------
// Analyzer 1: Calendar-Driven Opportunities
// ---------------------------------------------------------------------------

function analyzeCalendar(
  db: ReturnType<typeof getDatabase>,
  lote: string,
): number {
  // Find accounts that completed proposals for a gancho_temporal in the last 18 months
  // but have no current pipeline proposal for the same trigger,
  // AND a matching crm_event is upcoming within 8 weeks
  const rows = db
    .prepare(
      `SELECT c.id AS cuenta_id, c.nombre AS cuenta_nombre, c.ae_id,
              p.tipo_oportunidad, p.gancho_temporal,
              COUNT(*) AS times_bought,
              AVG(p.valor_estimado) AS avg_valor,
              e.id AS evento_id, e.nombre AS evento_nombre, e.fecha_inicio
       FROM propuesta p
       JOIN cuenta c ON p.cuenta_id = c.id
       LEFT JOIN crm_events e ON LOWER(p.gancho_temporal) = LOWER(e.nombre)
         AND e.fecha_inicio >= date('now') AND e.fecha_inicio <= date('now', '+56 days')
       WHERE p.etapa = 'completada'
         AND p.gancho_temporal IS NOT NULL
         AND p.fecha_vuelo_inicio >= date('now', '-18 months')
         AND c.estado = 'activo'
         AND NOT EXISTS (
           SELECT 1 FROM propuesta p2
           WHERE p2.cuenta_id = c.id AND p2.gancho_temporal = p.gancho_temporal
             AND p2.etapa NOT IN ('completada','perdida','cancelada')
         )
       GROUP BY c.id, p.gancho_temporal`,
    )
    .all() as any[];

  let count = 0;
  const insert = db.prepare(
    `INSERT INTO insight_comercial (id, tipo, cuenta_id, ae_id, evento_id, titulo, descripcion, accion_recomendada, datos_soporte, confianza, sample_size, valor_potencial, fecha_expiracion, lote_nocturno)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of rows) {
    const titulo = `${row.gancho_temporal} — ${row.cuenta_nombre}`;
    if (isDuplicate(db, "oportunidad_calendario", row.cuenta_id, titulo))
      continue;

    const confianza = row.times_bought >= 2 ? 0.85 : 0.65;
    const expiration = row.evento_id
      ? row.fecha_inicio
      : new Date(Date.now() + 56 * 86400000).toISOString();

    insert.run(
      genId(),
      "oportunidad_calendario",
      row.cuenta_id,
      row.ae_id,
      row.evento_id ?? null,
      titulo,
      `${row.cuenta_nombre} compró ${row.tipo_oportunidad} para "${row.gancho_temporal}" ${row.times_bought} vez/veces (prom. $${(row.avg_valor / 1e6).toFixed(1)}M). No hay propuesta activa para este trigger.${row.evento_nombre ? ` Evento "${row.evento_nombre}" inicia ${row.fecha_inicio}.` : ""}`,
      `Contactar al cliente para propuesta ${row.gancho_temporal}`,
      JSON.stringify({
        times_bought: row.times_bought,
        avg_valor: row.avg_valor,
        evento: row.evento_nombre ?? null,
      }),
      confianza,
      row.times_bought,
      Math.round(row.avg_valor),
      expiration,
      lote,
    );
    count++;
  }

  return count;
}

// ---------------------------------------------------------------------------
// Analyzer 2: Inventory-Driven Opportunities
// ---------------------------------------------------------------------------

function analyzeInventory(
  db: ReturnType<typeof getDatabase>,
  lote: string,
): number {
  // Find events 4-8 weeks out with inventory <70% sold
  const events = db
    .prepare(
      `SELECT id, nombre, tipo, fecha_inicio, inventario_total, inventario_vendido, meta_ingresos, ingresos_actual
       FROM crm_events
       WHERE date(fecha_inicio) BETWEEN date('now', '+28 days') AND date('now', '+56 days')`,
    )
    .all() as any[];

  let count = 0;
  const insert = db.prepare(
    `INSERT INTO insight_comercial (id, tipo, cuenta_id, ae_id, evento_id, titulo, descripcion, accion_recomendada, datos_soporte, confianza, sample_size, valor_potencial, fecha_expiracion, lote_nocturno)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const ev of events) {
    let soldPct = 0;
    if (ev.inventario_total && ev.inventario_vendido) {
      try {
        const total = JSON.parse(ev.inventario_total);
        const vendido = JSON.parse(ev.inventario_vendido);
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
      } catch {
        /* ignore */
      }
    }
    if (soldPct >= 70) continue; // enough sold, skip

    // Find active accounts that have historically bought this type of event
    const accounts = db
      .prepare(
        `SELECT DISTINCT c.id AS cuenta_id, c.nombre, c.ae_id
         FROM cuenta c
         JOIN propuesta p ON p.cuenta_id = c.id
         WHERE p.etapa = 'completada'
           AND p.tipo_oportunidad IN ('tentpole','evento_especial','estacional')
           AND c.estado = 'activo'
           AND c.ae_id IS NOT NULL
         LIMIT 10`,
      )
      .all() as any[];

    for (const acc of accounts) {
      const titulo = `Inventario ${ev.nombre} — ${acc.nombre}`;
      if (isDuplicate(db, "oportunidad_inventario", acc.cuenta_id, titulo))
        continue;

      const remaining = ev.meta_ingresos
        ? ev.meta_ingresos - (ev.ingresos_actual || 0)
        : null;
      insert.run(
        genId(),
        "oportunidad_inventario",
        acc.cuenta_id,
        acc.ae_id,
        ev.id,
        titulo,
        `Evento "${ev.nombre}" (${ev.tipo}) inicia ${ev.fecha_inicio}. Inventario ${soldPct}% vendido, ${100 - soldPct}% disponible. ${acc.nombre} ha comprado eventos similares.`,
        `Proponer paquete de ${ev.nombre} a ${acc.nombre}`,
        JSON.stringify({
          evento: ev.nombre,
          sold_pct: soldPct,
          remaining_revenue: remaining,
        }),
        0.55, // medium confidence — based on type match, not specific history
        1,
        remaining ? Math.round(remaining * 0.05) : null, // conservative 5% share
        ev.fecha_inicio,
        lote,
      );
      count++;
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Analyzer 3: Gap-Driven Opportunities
// ---------------------------------------------------------------------------

function analyzeGap(db: ReturnType<typeof getDatabase>, lote: string): number {
  // Accounts with active contracts where billing gap > 10% of commitment over 3+ weeks
  const year = new Date().getFullYear();
  const rows = db
    .prepare(
      `SELECT c.id AS cuenta_id, c.nombre AS cuenta_nombre, c.ae_id,
              ct.monto_comprometido,
              SUM(d.facturado) AS facturado_acum,
              SUM(d.planificado) AS plan_acum,
              SUM(d.gap) AS gap_acum,
              COUNT(*) AS semanas_con_gap
       FROM descarga d
       JOIN contrato ct ON d.contrato_id = ct.id
       JOIN cuenta c ON d.cuenta_id = c.id
       WHERE d.año = ? AND d.gap > 0 AND c.estado = 'activo'
         AND ct.estatus IN ('firmado','en_ejecucion')
       GROUP BY c.id
       HAVING gap_acum > ct.monto_comprometido * 0.10 AND semanas_con_gap >= 3`,
    )
    .all(year) as any[];

  let count = 0;
  const insert = db.prepare(
    `INSERT INTO insight_comercial (id, tipo, cuenta_id, ae_id, titulo, descripcion, accion_recomendada, datos_soporte, confianza, sample_size, valor_potencial, fecha_expiracion, lote_nocturno)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of rows) {
    const titulo = `Gap de facturación — ${row.cuenta_nombre}`;
    if (isDuplicate(db, "oportunidad_gap", row.cuenta_id, titulo)) continue;

    const gapPct = Math.round((row.gap_acum / row.monto_comprometido) * 100);

    insert.run(
      genId(),
      "oportunidad_gap",
      row.cuenta_id,
      row.ae_id,
      titulo,
      `${row.cuenta_nombre} tiene gap de facturación de $${(row.gap_acum / 1e6).toFixed(1)}M (${gapPct}% del compromiso). ${row.semanas_con_gap} semanas con gap positivo. Plan: $${(row.plan_acum / 1e6).toFixed(1)}M, Facturado: $${(row.facturado_acum / 1e6).toFixed(1)}M.`,
      `Contactar al cliente con propuesta de recuperación (paquete más pequeño a precio ajustado)`,
      JSON.stringify({
        gap_acum: row.gap_acum,
        gap_pct: gapPct,
        semanas: row.semanas_con_gap,
        monto_comprometido: row.monto_comprometido,
      }),
      0.8, // high confidence — based on hard billing data
      row.semanas_con_gap,
      Math.round(row.gap_acum * 0.5), // recovery target: 50% of gap
      new Date(Date.now() + 30 * 86400000).toISOString(), // 30-day window
      lote,
    );
    count++;
  }

  return count;
}

// ---------------------------------------------------------------------------
// Analyzer 4: Cross-Sell Opportunities (uses shared peer comparison)
// ---------------------------------------------------------------------------

function analyzeCrossSell(
  db: ReturnType<typeof getDatabase>,
  lote: string,
): number {
  // Run peer comparison for all active accounts with completed proposals
  const accounts = db
    .prepare(
      `SELECT DISTINCT c.id, c.nombre, c.vertical, c.ae_id
       FROM cuenta c
       JOIN propuesta p ON p.cuenta_id = c.id AND p.etapa = 'completada'
       WHERE c.estado = 'activo' AND c.vertical IS NOT NULL AND c.ae_id IS NOT NULL`,
    )
    .all() as any[];

  let count = 0;
  const insert = db.prepare(
    `INSERT INTO insight_comercial (id, tipo, cuenta_id, ae_id, titulo, descripcion, accion_recomendada, datos_soporte, confianza, sample_size, valor_potencial, fecha_expiracion, lote_nocturno)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const acc of accounts) {
    const comparison = comparePeers(db, acc.id, acc.vertical);

    // Only create insights for high-confidence gaps (2+ peer accounts)
    for (const gap of comparison.tipo_gaps) {
      if (!gap.tipo_oportunidad || gap.num_cuentas < 2) continue;

      const titulo = `Cross-sell ${gap.tipo_oportunidad} — ${acc.nombre}`;
      if (isDuplicate(db, "oportunidad_crosssell", acc.id, titulo)) continue;

      insert.run(
        genId(),
        "oportunidad_crosssell",
        acc.id,
        acc.ae_id,
        titulo,
        `${gap.num_cuentas} cuentas en ${acc.vertical} compran ${gap.tipo_oportunidad} (prom. $${(gap.avg_val / 1e6).toFixed(1)}M). ${acc.nombre} no lo ha explorado.`,
        `Proponer ${gap.tipo_oportunidad} a ${acc.nombre}`,
        JSON.stringify({
          peer_count: gap.num_cuentas,
          peer_avg_val: gap.avg_val,
          tipo: gap.tipo_oportunidad,
        }),
        gap.num_cuentas >= 3 ? 0.8 : 0.65,
        gap.num_cuentas,
        Math.round(gap.avg_val),
        new Date(Date.now() + 60 * 86400000).toISOString(),
        lote,
      );
      count++;
    }

    // Value upsell if gap > $1M
    if (comparison.value_gap && comparison.value_gap > 1_000_000) {
      const titulo = `Upsell inversión — ${acc.nombre}`;
      if (!isDuplicate(db, "oportunidad_crosssell", acc.id, titulo)) {
        insert.run(
          genId(),
          "oportunidad_crosssell",
          acc.id,
          acc.ae_id,
          titulo,
          `${acc.nombre} invierte $${(comparison.account.valor_total_ganado / 1e6).toFixed(1)}M vs. promedio vertical $${(comparison.peer_avg_total_value! / 1e6).toFixed(1)}M. Gap de $${(comparison.value_gap / 1e6).toFixed(1)}M.`,
          `Explorar oportunidad de upsell con ${acc.nombre}`,
          JSON.stringify({
            account_total: comparison.account.valor_total_ganado,
            peer_avg: comparison.peer_avg_total_value,
            gap: comparison.value_gap,
          }),
          0.6,
          comparison.peer_tipos.length,
          Math.round(comparison.value_gap),
          new Date(Date.now() + 90 * 86400000).toISOString(),
          lote,
        );
        count++;
      }
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Analyzer 5: Market-Driven (Lightweight)
// ---------------------------------------------------------------------------

function analyzeMarket(
  db: ReturnType<typeof getDatabase>,
  lote: string,
): number {
  let count = 0;
  const insert = db.prepare(
    `INSERT INTO insight_comercial (id, tipo, cuenta_id, ae_id, titulo, descripcion, accion_recomendada, datos_soporte, confianza, sample_size, valor_potencial, fecha_expiracion, lote_nocturno)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // 5a. Expiring contracts within 60 days
  const expiring = db
    .prepare(
      `SELECT ct.id AS contrato_id, ct.monto_comprometido, ct.fecha_cierre,
              c.id AS cuenta_id, c.nombre AS cuenta_nombre, c.ae_id
       FROM contrato ct
       JOIN cuenta c ON ct.cuenta_id = c.id
       WHERE ct.estatus IN ('firmado','en_ejecucion')
         AND ct.fecha_cierre IS NOT NULL
         AND date(ct.fecha_cierre) BETWEEN date('now') AND date('now', '+60 days')
         AND c.estado = 'activo'`,
    )
    .all() as any[];

  for (const row of expiring) {
    const titulo = `Contrato por vencer — ${row.cuenta_nombre}`;
    if (isDuplicate(db, "oportunidad_mercado", row.cuenta_id, titulo)) continue;

    insert.run(
      genId(),
      "oportunidad_mercado",
      row.cuenta_id,
      row.ae_id,
      titulo,
      `Contrato de ${row.cuenta_nombre} ($${(row.monto_comprometido / 1e6).toFixed(1)}M) vence ${row.fecha_cierre}. Oportunidad de renovación.`,
      `Agendar reunión de renovación con ${row.cuenta_nombre}`,
      JSON.stringify({
        contrato_id: row.contrato_id,
        monto: row.monto_comprometido,
        fecha_cierre: row.fecha_cierre,
      }),
      0.9, // high — hard date
      1,
      Math.round(row.monto_comprometido),
      row.fecha_cierre,
      lote,
    );
    count++;
  }

  // 5b. Inactive accounts with purchase history (30+ days no activity)
  const accounts = db
    .prepare(
      `SELECT c.id AS cuenta_id, c.nombre AS cuenta_nombre, c.ae_id
       FROM cuenta c
       WHERE c.estado = 'activo' AND c.ae_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM propuesta p WHERE p.cuenta_id = c.id AND p.etapa = 'completada')`,
    )
    .all() as any[];

  for (const acc of accounts) {
    const days = getDaysSinceActivity(db, acc.cuenta_id);
    if (days === null || days < 30) continue;

    const titulo = `Reactivación — ${acc.cuenta_nombre}`;
    if (isDuplicate(db, "oportunidad_mercado", acc.cuenta_id, titulo)) continue;

    insert.run(
      genId(),
      "oportunidad_mercado",
      acc.cuenta_id,
      acc.ae_id,
      titulo,
      `${acc.cuenta_nombre} tiene ${days} días sin actividad pero tiene historial de propuestas ganadas. Oportunidad de reactivación.`,
      `Contactar a ${acc.cuenta_nombre} para retomar relación`,
      JSON.stringify({ days_inactive: days }),
      0.55,
      1,
      null,
      new Date(Date.now() + 30 * 86400000).toISOString(),
      lote,
    );
    count++;
  }

  return count;
}

// ---------------------------------------------------------------------------
// Expiration: mark stale insights
// ---------------------------------------------------------------------------

function expireStaleInsights(db: ReturnType<typeof getDatabase>): number {
  const result = db
    .prepare(
      `UPDATE insight_comercial SET estado = 'expirado'
       WHERE estado = 'nuevo' AND fecha_expiracion IS NOT NULL
         AND datetime(fecha_expiracion) < datetime('now')`,
    )
    .run();
  return result.changes;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function runOvernightAnalysis(): OvernightResult {
  const db = getDatabase();
  const lote = new Date().toISOString().slice(0, 10);

  // Run expiration first
  const expired = expireStaleInsights(db);

  // Run all 5 analyzers in a transaction
  let calendar = 0;
  let inventory = 0;
  let gap = 0;
  let crosssell = 0;
  let market = 0;

  const runAll = db.transaction(() => {
    calendar = analyzeCalendar(db, lote);
    inventory = analyzeInventory(db, lote);
    gap = analyzeGap(db, lote);
    crosssell = analyzeCrossSell(db, lote);
    market = analyzeMarket(db, lote);
  });

  runAll();

  const total = calendar + inventory + gap + crosssell + market;

  logger.info(
    { lote, calendar, inventory, gap, crosssell, market, total, expired },
    "Overnight analysis completed",
  );

  return {
    lote,
    calendar,
    inventory,
    gap,
    crosssell,
    market,
    total_generated: total,
    expired,
  };
}
