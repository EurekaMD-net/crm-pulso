/**
 * Overnight Commercial Analysis Engine
 *
 * Runs at 2 AM MX via IPC. Scans all accounts against events, inventory,
 * billing gaps, peer comparisons, and market signals. Produces structured
 * insights in insight_comercial table.
 *
 * 6 analyzers:
 *   1. Calendar-driven — brands that bought for an event last year but haven't been contacted
 *   2. Inventory-driven — unsold event inventory matched to account profiles
 *   3. Gap-driven — billing below plan, recovery opportunity
 *   4. Cross-sell — peer vertical gaps (shared modules)
 *   5. Market-driven — expiring contracts, inactive accounts
 *   6. Template scoring — correlates persona template versions with outcome quality
 */

import { getDatabase } from "./db.js";
import { logger } from "./logger.js";
import { getMxDateStr } from "./tools/helpers.js";
import { comparePeers } from "./analysis/peer-comparison.js";
import { getDaysSinceActivity } from "./analysis/media-mix.js";
import { detectCrossAgentPatterns } from "./cross-intelligence.js";
import { evaluateVariantPromotion } from "./template-evolution.js";

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
  template: number;
  total_generated: number;
  expired: number;
  errors: string[];
}

function genId(): string {
  return `ins-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Batch dedup: preload existing (tipo, cuenta_id, titulo) for a given tipo
// so each analyzer runs 1 query instead of N per-row checks
// ---------------------------------------------------------------------------

function loadExistingInsights(
  db: ReturnType<typeof getDatabase>,
  tipo: string,
): Set<string> {
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = db
    .prepare(
      `SELECT cuenta_id, titulo FROM insight_comercial
       WHERE tipo = ? AND fecha_generacion >= ?
         AND estado NOT IN ('expirado','descartado')`,
    )
    .all(tipo, cutoff) as Array<{ cuenta_id: string; titulo: string }>;
  return new Set(rows.map((r) => `${r.cuenta_id}\0${r.titulo}`));
}

function isDuplicate(
  existing: Set<string>,
  cuentaId: string,
  titulo: string,
): boolean {
  return existing.has(`${cuentaId}\0${titulo}`);
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
  const existing = loadExistingInsights(db, "oportunidad_calendario");
  const insert = db.prepare(
    `INSERT INTO insight_comercial (id, tipo, cuenta_id, ae_id, evento_id, titulo, descripcion, accion_recomendada, datos_soporte, confianza, sample_size, valor_potencial, fecha_expiracion, lote_nocturno)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of rows) {
    const titulo = `${row.gancho_temporal} — ${row.cuenta_nombre}`;
    if (isDuplicate(existing, row.cuenta_id, titulo)) continue;

    const confianza = row.times_bought >= 2 ? 0.85 : 0.65;
    // Expiration is user-facing — use Mexico City date so it doesn't expire
    // 6 hours early relative to the sales team's workday.
    const expiration = row.evento_id
      ? row.fecha_inicio
      : getMxDateStr(new Date(Date.now() + 56 * 86400000));

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
  const existing = loadExistingInsights(db, "oportunidad_inventario");
  const insert = db.prepare(
    `INSERT INTO insight_comercial (id, tipo, cuenta_id, ae_id, evento_id, titulo, descripcion, accion_recomendada, datos_soporte, confianza, sample_size, valor_potencial, fecha_expiracion, lote_nocturno)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Candidate accounts do not vary per event — fetch once outside the loop
  // instead of N+1 per-event (prior implementation re-ran this query on every
  // iteration, producing 10-50× redundant queries on busy nights).
  const candidateAccounts = db
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

    const accounts = candidateAccounts;

    for (const acc of accounts) {
      const titulo = `Inventario ${ev.nombre} — ${acc.nombre}`;
      if (isDuplicate(existing, acc.cuenta_id, titulo)) continue;

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
  const existingGap = loadExistingInsights(db, "oportunidad_gap");
  const insert = db.prepare(
    `INSERT INTO insight_comercial (id, tipo, cuenta_id, ae_id, titulo, descripcion, accion_recomendada, datos_soporte, confianza, sample_size, valor_potencial, fecha_expiracion, lote_nocturno)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of rows) {
    const titulo = `Gap de facturación — ${row.cuenta_nombre}`;
    if (isDuplicate(existingGap, row.cuenta_id, titulo)) continue;

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
  const existingCS = loadExistingInsights(db, "oportunidad_crosssell");
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
      if (isDuplicate(existingCS, acc.id, titulo)) continue;

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
      if (!isDuplicate(existingCS, acc.id, titulo)) {
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
  const existingMarket = loadExistingInsights(db, "oportunidad_mercado");
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
    if (isDuplicate(existingMarket, row.cuenta_id, titulo)) continue;

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
    if (isDuplicate(existingMarket, acc.cuenta_id, titulo)) continue;

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
// 6. Template scoring — correlates template versions with outcome quality
// ---------------------------------------------------------------------------

function analyzeTemplates(
  db: ReturnType<typeof getDatabase>,
  lote: string,
): number {
  let generated = 0;

  // Aggregate activities by template_version and sentimiento over last 7 days
  const rows = db
    .prepare(
      `SELECT
         template_version,
         p.rol,
         sentimiento,
         COUNT(*) AS cnt
       FROM actividad a
       JOIN persona p ON p.id = a.ae_id
       WHERE a.fecha >= datetime('now', '-7 days')
         AND a.template_version IS NOT NULL
       GROUP BY template_version, p.rol, sentimiento`,
    )
    .all() as Array<{
    template_version: string;
    rol: string;
    sentimiento: string;
    cnt: number;
  }>;

  // Build per-version aggregate
  const versionStats = new Map<
    string,
    { rol: string; positive: number; negative: number; total: number }
  >();
  for (const r of rows) {
    const key = r.template_version;
    if (!versionStats.has(key)) {
      versionStats.set(key, { rol: r.rol, positive: 0, negative: 0, total: 0 });
    }
    const stats = versionStats.get(key)!;
    stats.total += r.cnt;
    if (r.sentimiento === "positivo") stats.positive += r.cnt;
    if (r.sentimiento === "negativo") stats.negative += r.cnt;
  }

  // Insert scores and generate recommendations for high negative rate
  const insertScore = db.prepare(
    `INSERT INTO template_score (id, bullet_id, template_version, rol, outcome_type, sample_size, fecha)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  );

  const insertInsight = db.prepare(
    `INSERT INTO insight_comercial (id, tipo, titulo, descripcion, accion_recomendada, confianza, sample_size, fecha_generacion, fecha_expiracion, lote_nocturno)
     VALUES (?, 'recomendacion', ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+14 days'), ?)`,
  );

  for (const [version, stats] of versionStats) {
    // Record positive aggregate
    if (stats.positive > 0) {
      insertScore.run(
        genId(),
        `${stats.rol}-agg`,
        version,
        stats.rol,
        "actividad_positiva",
        stats.positive,
      );
      generated++;
    }

    // Record negative aggregate
    if (stats.negative > 0) {
      insertScore.run(
        genId(),
        `${stats.rol}-agg`,
        version,
        stats.rol,
        "actividad_negativa",
        stats.negative,
      );
      generated++;
    }

    // Generate recommendation if negative rate > 60% with sufficient sample
    if (stats.total >= 10) {
      const negativeRate = stats.negative / stats.total;
      if (negativeRate > 0.6) {
        const rateStr = Math.round(negativeRate * 100);
        insertInsight.run(
          genId(),
          `Revisar plantilla ${stats.rol} (${version})`,
          `La plantilla ${version} del rol ${stats.rol} tiene una tasa de sentimiento negativo del ${rateStr}% en ${stats.total} actividades (ultimos 7 dias). Revisar instrucciones para posibles mejoras.`,
          `Comparar version actual con version anterior y analizar instrucciones que generan fricciones con clientes.`,
          0.7,
          stats.total,
          lote,
        );
        generated++;
      }
    }
  }

  // Evaluate template variant promotions (HyperAgents pattern)
  generated += evaluateVariantPromotion(db, lote);

  return generated;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function runOvernightAnalysis(): OvernightResult {
  const db = getDatabase();
  const lote = getMxDateStr();

  // Run expiration + purge first
  const expired = expireStaleInsights(db);
  // Purge insights expired > 90 days to prevent unbounded table growth
  db.prepare(
    `DELETE FROM insight_comercial
     WHERE estado = 'expirado'
       AND fecha_generacion < datetime('now', '-90 days')`,
  ).run();

  // Run each analyzer in its own transaction so partial results survive.
  // If analyzer 3 fails, analyzers 1-2 results are still committed.
  const errors: string[] = [];
  let calendar = 0;
  let inventory = 0;
  let gap = 0;
  let crosssell = 0;
  let market = 0;
  let template = 0;

  const analyzers: Array<{ name: string; fn: () => number }> = [
    { name: "calendar", fn: () => analyzeCalendar(db, lote) },
    { name: "inventory", fn: () => analyzeInventory(db, lote) },
    { name: "gap", fn: () => analyzeGap(db, lote) },
    { name: "crosssell", fn: () => analyzeCrossSell(db, lote) },
    { name: "market", fn: () => analyzeMarket(db, lote) },
    { name: "template", fn: () => analyzeTemplates(db, lote) },
  ];

  const results = new Map<string, number>();
  for (const analyzer of analyzers) {
    try {
      const run = db.transaction(() => analyzer.fn());
      results.set(analyzer.name, run());
    } catch (err) {
      logger.error(
        { err, analyzer: analyzer.name, lote },
        "Overnight analyzer failed — partial results preserved",
      );
      errors.push(analyzer.name);
      results.set(analyzer.name, 0);
    }
  }

  calendar = results.get("calendar")!;
  inventory = results.get("inventory")!;
  gap = results.get("gap")!;
  crosssell = results.get("crosssell")!;
  market = results.get("market")!;
  template = results.get("template")!;

  // Post-analyzer: cross-agent pattern detection (also isolated)
  let patternTotal = 0;
  try {
    const patterns = detectCrossAgentPatterns(lote);
    patternTotal = patterns.total;
  } catch (err) {
    logger.error({ err, lote }, "Cross-agent pattern detection failed");
    errors.push("patterns");
  }

  const total = calendar + inventory + gap + crosssell + market + template;

  logger.info(
    {
      lote,
      calendar,
      inventory,
      gap,
      crosssell,
      market,
      template,
      total,
      expired,
      patterns: patternTotal,
      errors: errors.length > 0 ? errors : undefined,
    },
    errors.length > 0
      ? `Overnight analysis completed with ${errors.length} failed analyzer(s)`
      : "Overnight analysis completed",
  );

  return {
    lote,
    calendar,
    inventory,
    gap,
    crosssell,
    market,
    template,
    total_generated: total,
    expired,
    errors,
  };
}
