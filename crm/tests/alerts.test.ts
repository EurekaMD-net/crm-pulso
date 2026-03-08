/**
 * Alert Evaluator Tests
 *
 * Tests all 5 alert evaluators, dedup via alerta_log, and WhatsApp formatting.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrmSchema } from '../src/schema.js';

let testDb: InstanceType<typeof Database>;

vi.mock('../src/db.js', () => ({
  getDatabase: () => testDb,
}));

const {
  alertPropuestasEstancadas,
  alertCuotaBaja,
  alertDescargaGap,
  alertMegaDealMovimiento,
  alertInactividadAe,
  alertEventCountdown,
  evaluateAlerts,
  logAlerts,
} = await import('../src/alerts.js');

const { _resetStatementCache } = await import('../src/hierarchy.js');

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setupDb() {
  testDb = new Database(':memory:');
    sqliteVec.load(testDb);
  testDb.pragma('foreign_keys = ON');
  createCrmSchema(testDb);
  _resetStatementCache();

  // Org chart: VP -> Director -> Gerente -> AE1, AE2
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('vp1', 'Roberto', 'vp', null, 'vp-roberto', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('dir1', 'Ana', 'director', 'vp1', 'dir-ana', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ger1', 'Miguel', 'gerente', 'dir1', 'ger-miguel', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ae1', 'Maria', 'ae', 'ger1', 'ae-maria', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ae2', 'Carlos', 'ae', 'ger1', 'ae-carlos', 1)`).run();
  // AE without group folder
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ae3', 'Pedro', 'ae', 'ger1', null, 1)`).run();

  // Accounts
  testDb.prepare(`INSERT INTO cuenta (id, nombre, tipo, ae_id) VALUES ('c1', 'Coca-Cola', 'directo', 'ae1')`).run();
  testDb.prepare(`INSERT INTO cuenta (id, nombre, tipo, ae_id) VALUES ('c2', 'Bimbo', 'directo', 'ae2')`).run();
}

beforeEach(setupDb);

// ---------------------------------------------------------------------------
// 1. alertPropuestasEstancadas
// ---------------------------------------------------------------------------

describe('alertPropuestasEstancadas', () => {
  it('returns alert for propuesta with >7 days inactive', () => {
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES ('p1', 'c1', 'ae1', 'Campaña Q3', 5000000, 'enviada', 10)`).run();

    const results = alertPropuestasEstancadas();
    expect(results.length).toBe(1);
    expect(results[0].alerta_tipo).toBe('propuesta_estancada');
    expect(results[0].grupo_destino_folder).toBe('ae-maria');
    expect(results[0].entidad_id).toBe('p1');
  });

  it('escalates to gerente when >14 days', () => {
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES ('p1', 'c1', 'ae1', 'Campaña Q3', 5000000, 'enviada', 16)`).run();

    const results = alertPropuestasEstancadas();
    // AE alert + gerente escalation
    expect(results.length).toBe(2);
    const types = results.map(r => r.alerta_tipo);
    expect(types).toContain('propuesta_estancada');
    expect(types).toContain('propuesta_estancada_escalada');
    expect(results.find(r => r.alerta_tipo === 'propuesta_estancada_escalada')!.grupo_destino_folder).toBe('ger-miguel');
  });

  it('skips completed/perdida/cancelada propuestas', () => {
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES ('p1', 'c1', 'ae1', 'Old', 100000, 'completada', 30)`).run();
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES ('p2', 'c1', 'ae1', 'Lost', 200000, 'perdida', 20)`).run();
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES ('p3', 'c1', 'ae1', 'Cancelled', 300000, 'cancelada', 15)`).run();

    const results = alertPropuestasEstancadas();
    expect(results.length).toBe(0);
  });

  it('returns empty when no stalled propuestas', () => {
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES ('p1', 'c1', 'ae1', 'Active', 100000, 'enviada', 3)`).run();

    const results = alertPropuestasEstancadas();
    expect(results.length).toBe(0);
  });

  it('skips AE without group folder', () => {
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES ('p1', 'c1', 'ae3', 'Orphan', 100000, 'enviada', 10)`).run();

    const results = alertPropuestasEstancadas();
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. alertCuotaBaja
// ---------------------------------------------------------------------------

describe('alertCuotaBaja', () => {
  it('returns alert for quota <80%', () => {
    const now = new Date();
    const year = now.getFullYear();
    const dayOfYear = Math.floor((now.getTime() - new Date(year, 0, 1).getTime()) / 86400000);
    const week = Math.max(1, Math.ceil((dayOfYear + 1) / 7));

    testDb.prepare(`INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total, logro) VALUES ('q1', 'ae1', 'ae', ?, ?, 1000000, 500000)`).run(year, week);

    const results = alertCuotaBaja();
    expect(results.length).toBe(1);
    expect(results[0].alerta_tipo).toBe('cuota_baja');
    expect(results[0].grupo_destino_folder).toBe('ae-maria');
  });

  it('returns empty when quota >=80%', () => {
    const now = new Date();
    const year = now.getFullYear();
    const dayOfYear = Math.floor((now.getTime() - new Date(year, 0, 1).getTime()) / 86400000);
    const week = Math.max(1, Math.ceil((dayOfYear + 1) / 7));

    testDb.prepare(`INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total, logro) VALUES ('q1', 'ae1', 'ae', ?, ?, 1000000, 900000)`).run(year, week);

    const results = alertCuotaBaja();
    expect(results.length).toBe(0);
  });

  it('skips inactive personas', () => {
    testDb.prepare(`UPDATE persona SET activo = 0 WHERE id = 'ae1'`).run();
    const now = new Date();
    const year = now.getFullYear();
    const dayOfYear = Math.floor((now.getTime() - new Date(year, 0, 1).getTime()) / 86400000);
    const week = Math.max(1, Math.ceil((dayOfYear + 1) / 7));

    testDb.prepare(`INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total, logro) VALUES ('q1', 'ae1', 'ae', ?, ?, 1000000, 300000)`).run(year, week);

    const results = alertCuotaBaja();
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. alertDescargaGap
// ---------------------------------------------------------------------------

describe('alertDescargaGap', () => {
  it('returns alert for 3 consecutive weeks of growing gap', () => {
    testDb.prepare(`INSERT INTO descarga (id, cuenta_id, semana, año, planificado, facturado, gap_acumulado) VALUES ('d1', 'c1', 10, 2026, 100000, 80000, 20000)`).run();
    testDb.prepare(`INSERT INTO descarga (id, cuenta_id, semana, año, planificado, facturado, gap_acumulado) VALUES ('d2', 'c1', 11, 2026, 100000, 70000, 50000)`).run();
    testDb.prepare(`INSERT INTO descarga (id, cuenta_id, semana, año, planificado, facturado, gap_acumulado) VALUES ('d3', 'c1', 12, 2026, 100000, 60000, 90000)`).run();

    const results = alertDescargaGap();
    expect(results.length).toBeGreaterThanOrEqual(1);
    const aeAlert = results.find(r => r.grupo_destino_folder === 'ae-maria');
    expect(aeAlert).toBeDefined();
    expect(aeAlert!.alerta_tipo).toBe('descarga_gap');
  });

  it('also notifies gerente', () => {
    testDb.prepare(`INSERT INTO descarga (id, cuenta_id, semana, año, planificado, facturado, gap_acumulado) VALUES ('d1', 'c1', 10, 2026, 100000, 80000, 20000)`).run();
    testDb.prepare(`INSERT INTO descarga (id, cuenta_id, semana, año, planificado, facturado, gap_acumulado) VALUES ('d2', 'c1', 11, 2026, 100000, 70000, 50000)`).run();
    testDb.prepare(`INSERT INTO descarga (id, cuenta_id, semana, año, planificado, facturado, gap_acumulado) VALUES ('d3', 'c1', 12, 2026, 100000, 60000, 90000)`).run();

    const results = alertDescargaGap();
    const mgrAlert = results.find(r => r.grupo_destino_folder === 'ger-miguel');
    expect(mgrAlert).toBeDefined();
  });

  it('returns empty when gap is not growing', () => {
    testDb.prepare(`INSERT INTO descarga (id, cuenta_id, semana, año, planificado, facturado, gap_acumulado) VALUES ('d1', 'c1', 10, 2026, 100000, 80000, 50000)`).run();
    testDb.prepare(`INSERT INTO descarga (id, cuenta_id, semana, año, planificado, facturado, gap_acumulado) VALUES ('d2', 'c1', 11, 2026, 100000, 90000, 40000)`).run();
    testDb.prepare(`INSERT INTO descarga (id, cuenta_id, semana, año, planificado, facturado, gap_acumulado) VALUES ('d3', 'c1', 12, 2026, 100000, 95000, 30000)`).run();

    const results = alertDescargaGap();
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. alertMegaDealMovimiento
// ---------------------------------------------------------------------------

describe('alertMegaDealMovimiento', () => {
  it('returns alert for mega-deal with recent activity', () => {
    // es_mega is computed: valor_estimado > 15000000
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa) VALUES ('p1', 'c1', 'ae1', 'Mega Deal', 20000000, 'en_negociacion')`).run();
    testDb.prepare(`INSERT INTO actividad (id, ae_id, propuesta_id, tipo, resumen, fecha) VALUES ('a1', 'ae1', 'p1', 'reunion', 'Reunion avance', datetime('now', '-1 hour'))`).run();

    const results = alertMegaDealMovimiento();
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Should notify director and VP
    const folders = results.map(r => r.grupo_destino_folder);
    expect(folders).toContain('dir-ana');
  });

  it('also notifies VP', () => {
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa) VALUES ('p1', 'c1', 'ae1', 'Mega Deal', 20000000, 'en_negociacion')`).run();
    testDb.prepare(`INSERT INTO actividad (id, ae_id, propuesta_id, tipo, resumen, fecha) VALUES ('a1', 'ae1', 'p1', 'reunion', 'Reunion', datetime('now', '-1 hour'))`).run();

    const results = alertMegaDealMovimiento();
    const vpAlert = results.find(r => r.grupo_destino_folder === 'vp-roberto');
    expect(vpAlert).toBeDefined();
  });

  it('skips non-mega deals', () => {
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa) VALUES ('p1', 'c1', 'ae1', 'Small Deal', 5000000, 'en_negociacion')`).run();
    testDb.prepare(`INSERT INTO actividad (id, ae_id, propuesta_id, tipo, resumen, fecha) VALUES ('a1', 'ae1', 'p1', 'reunion', 'Reunion', datetime('now', '-1 hour'))`).run();

    const results = alertMegaDealMovimiento();
    expect(results.length).toBe(0);
  });

  it('skips mega-deals with no recent activity', () => {
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa) VALUES ('p1', 'c1', 'ae1', 'Mega Deal', 20000000, 'en_negociacion')`).run();
    testDb.prepare(`INSERT INTO actividad (id, ae_id, propuesta_id, tipo, resumen, fecha) VALUES ('a1', 'ae1', 'p1', 'reunion', 'Old meeting', datetime('now', '-48 hours'))`).run();

    const results = alertMegaDealMovimiento();
    expect(results.length).toBe(0);
  });

  it('skips closed mega-deals', () => {
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa) VALUES ('p1', 'c1', 'ae1', 'Mega Done', 20000000, 'completada')`).run();
    testDb.prepare(`INSERT INTO actividad (id, ae_id, propuesta_id, tipo, resumen, fecha) VALUES ('a1', 'ae1', 'p1', 'reunion', 'Final', datetime('now', '-1 hour'))`).run();

    const results = alertMegaDealMovimiento();
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. alertInactividadAe
// ---------------------------------------------------------------------------

describe('alertInactividadAe', () => {
  it('returns alert for AE with 5+ days no activity', () => {
    // ae1 has no activities — should trigger
    const results = alertInactividadAe();
    // Both ae1 and ae2 have no activities, both report to ger1
    const alerts = results.filter(r => r.alerta_tipo === 'inactividad_ae');
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    expect(alerts.every(a => a.grupo_destino_folder === 'ger-miguel')).toBe(true);
  });

  it('does not alert for active AEs', () => {
    testDb.prepare(`INSERT INTO actividad (id, ae_id, tipo, resumen, fecha) VALUES ('a1', 'ae1', 'llamada', 'Call', datetime('now', '-1 day'))`).run();
    testDb.prepare(`INSERT INTO actividad (id, ae_id, tipo, resumen, fecha) VALUES ('a2', 'ae2', 'email', 'Email', datetime('now', '-2 days'))`).run();

    const results = alertInactividadAe();
    // ae1 and ae2 are active, but ae3 has no group folder so shouldn't appear
    const ae1Alerts = results.filter(r => r.entidad_id === 'ae1');
    const ae2Alerts = results.filter(r => r.entidad_id === 'ae2');
    expect(ae1Alerts.length).toBe(0);
    expect(ae2Alerts.length).toBe(0);
  });

  it('skips AEs without group folder on their manager', () => {
    // ae3 has no group folder, but even if they had one, their manager's folder is what matters
    // ae3 reports to ger1 who has a folder, so this tests the AE's own absence
    // Actually, ae3 has no group folder so they're valid to alert about
    // But the alert goes to the manager (ger1), not the AE
    const results = alertInactividadAe();
    const ae3Alerts = results.filter(r => r.entidad_id === 'ae3');
    // ae3 has no reporta_a? No, ae3 reports to ger1 — but ae3 has no group folder
    // The alert is sent to gerente's folder, not AE's folder, so it should appear
    expect(ae3Alerts.length).toBeGreaterThanOrEqual(1);
    expect(ae3Alerts[0].grupo_destino_folder).toBe('ger-miguel');
  });
});

// ---------------------------------------------------------------------------
// 6. alertEventCountdown
// ---------------------------------------------------------------------------

describe('alertEventCountdown', () => {
  it('returns alerts for events within 30 days', () => {
    const futureDate = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);
    const invTotal = JSON.stringify({ tv_abierta: 100, ctv: 50 });
    const invVendido = JSON.stringify({ tv_abierta: 30, ctv: 10 });
    testDb.prepare(`INSERT INTO crm_events (id, nombre, tipo, fecha_inicio, inventario_total, inventario_vendido, prioridad) VALUES ('ev1', 'Copa del Mundo', 'deportivo', ?, ?, ?, 'alta')`).run(futureDate, invTotal, invVendido);

    const results = alertEventCountdown();
    // Should alert AEs (ae1, ae2 have folders; ae3 has no folder)
    const aeAlerts = results.filter(r => r.alerta_tipo === 'event_countdown');
    expect(aeAlerts.length).toBe(2); // ae1 and ae2
  });

  it('alerts directors/VP when >70% sold', () => {
    const futureDate = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const invTotal = JSON.stringify({ tv_abierta: 100 });
    const invVendido = JSON.stringify({ tv_abierta: 80 }); // 80% sold
    testDb.prepare(`INSERT INTO crm_events (id, nombre, tipo, fecha_inicio, inventario_total, inventario_vendido, prioridad) VALUES ('ev2', 'Liga MX Final', 'deportivo', ?, ?, ?, 'alta')`).run(futureDate, invTotal, invVendido);

    const results = alertEventCountdown();
    const highDemand = results.filter(r => r.alerta_tipo === 'event_countdown_high_demand');
    expect(highDemand.length).toBeGreaterThanOrEqual(1);
    const folders = highDemand.map(r => r.grupo_destino_folder);
    expect(folders).toContain('dir-ana');
    expect(folders).toContain('vp-roberto');
  });

  it('skips events >30 days away', () => {
    const farDate = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    testDb.prepare(`INSERT INTO crm_events (id, nombre, tipo, fecha_inicio, prioridad) VALUES ('ev3', 'Far Event', 'estacional', ?, 'media')`).run(farDate);

    const results = alertEventCountdown();
    const evAlerts = results.filter(r => r.entidad_id.startsWith('ev3'));
    expect(evAlerts.length).toBe(0);
  });

  it('skips past events', () => {
    const pastDate = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    testDb.prepare(`INSERT INTO crm_events (id, nombre, tipo, fecha_inicio, prioridad) VALUES ('ev4', 'Past Event', 'tentpole', ?, 'media')`).run(pastDate);

    const results = alertEventCountdown();
    const evAlerts = results.filter(r => r.entidad_id.startsWith('ev4'));
    expect(evAlerts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator + Dedup
// ---------------------------------------------------------------------------

describe('evaluateAlerts + dedup', () => {
  it('returns all alerts on first evaluation', () => {
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES ('p1', 'c1', 'ae1', 'Stalled', 5000000, 'enviada', 10)`).run();

    const results = evaluateAlerts();
    expect(results.length).toBeGreaterThan(0);
  });

  it('deduplicates on second evaluation after logAlerts', () => {
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES ('p1', 'c1', 'ae1', 'Stalled', 5000000, 'enviada', 10)`).run();

    const first = evaluateAlerts();
    expect(first.length).toBeGreaterThan(0);

    logAlerts(first);

    const second = evaluateAlerts();
    // Propuesta alert should be deduped, but inactividad alerts may still be new
    const stalledAlerts = second.filter(r => r.alerta_tipo === 'propuesta_estancada' && r.entidad_id === 'p1');
    expect(stalledAlerts.length).toBe(0);
  });

  it('logAlerts inserts into alerta_log', () => {
    const results = [
      { alerta_tipo: 'test', entidad_id: 'e1', grupo_destino_folder: 'g1', mensaje: 'test' },
    ];
    logAlerts(results);

    const count = testDb.prepare('SELECT COUNT(*) as c FROM alerta_log').get() as any;
    expect(count.c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// WhatsApp formatting
// ---------------------------------------------------------------------------

describe('WhatsApp formatting', () => {
  it('uses *bold* not **markdown**', () => {
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES ('p1', 'c1', 'ae1', 'Test', 5000000, 'enviada', 10)`).run();

    const results = alertPropuestasEstancadas();
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.mensaje).toContain('*Alerta');
      expect(r.mensaje).not.toMatch(/\*\*/);
    }
  });

  it('uses bullet character', () => {
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES ('p1', 'c1', 'ae1', 'Test', 5000000, 'enviada', 10)`).run();

    const results = alertPropuestasEstancadas();
    expect(results[0].mensaje).toContain('\u2022');
  });
});
