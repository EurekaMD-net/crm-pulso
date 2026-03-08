/**
 * Cross-sell Recommendation Tool Tests
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCrmSchema } from '../src/schema.js';

let testDb: InstanceType<typeof Database>;
vi.mock('../src/db.js', () => ({
  getDatabase: () => testDb,
}));

const noop = () => {};
const noopLogger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, child: () => noopLogger };
vi.mock('../src/logger.js', () => ({
  logger: noopLogger,
}));

vi.mock('../src/google-auth.js', () => ({
  isGoogleEnabled: () => false,
  getGmailClient: () => { throw new Error('Not configured'); },
  getGmailReadClient: () => { throw new Error('Not configured'); },
  getCalendarClient: () => { throw new Error('Not configured'); },
  getCalendarReadClient: () => { throw new Error('Not configured'); },
  getDriveClient: () => { throw new Error('Not configured'); },
}));

const { _resetStatementCache } = await import('../src/hierarchy.js');
const { recomendar_crosssell } = await import('../src/tools/crosssell.js');

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setupDb() {
  testDb = new Database(':memory:');
  sqliteVec.load(testDb);
  testDb.pragma('foreign_keys = ON');
  createCrmSchema(testDb);

  // Org chart
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, activo) VALUES ('vp-001', 'Elena Ruiz', 'vp', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES ('mgr-001', 'Ana Garcia', 'gerente', 'vp-001', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES ('ae-001', 'Carlos Lopez', 'ae', 'mgr-001', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES ('ae-002', 'Maria Perez', 'ae', 'mgr-001', 1)`).run();

  // Accounts — same vertical (Consumo) for peer comparison
  testDb.prepare(`INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id, años_relacion, es_fundador) VALUES ('c1', 'Acme Corp', 'directo', 'Consumo', 'ae-001', 5, 1)`).run();
  testDb.prepare(`INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id, años_relacion, es_fundador) VALUES ('c2', 'Beta Inc', 'directo', 'Consumo', 'ae-002', 3, 0)`).run();
  testDb.prepare(`INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id, años_relacion, es_fundador) VALUES ('c3', 'Gamma SA', 'agencia', 'Consumo', 'ae-001', 2, 0)`).run();
  // Different vertical
  testDb.prepare(`INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id, años_relacion) VALUES ('c4', 'Delta Tech', 'directo', 'Tecnologia', 'ae-002', 1)`).run();
}

function seedCompletedProposals() {
  const now = new Date().toISOString();
  const recent = new Date(Date.now() - 30 * 86400000).toISOString();

  // Acme (c1): has estacional + reforzamiento
  testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa, fecha_creacion, fecha_ultima_actividad)
    VALUES ('p1', 'c1', 'ae-001', 'Acme Verano', 5000000, 'estacional', 'completada', ?, ?)`).run(recent, now);
  testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa, fecha_creacion, fecha_ultima_actividad)
    VALUES ('p2', 'c1', 'ae-001', 'Acme Refuerzo', 3000000, 'reforzamiento', 'completada', ?, ?)`).run(recent, now);

  // Beta (c2): has estacional + tentpole + lanzamiento (more diverse)
  testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa, fecha_creacion, fecha_ultima_actividad)
    VALUES ('p3', 'c2', 'ae-002', 'Beta Navidad', 8000000, 'estacional', 'completada', ?, ?)`).run(recent, now);
  testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa, fecha_creacion, fecha_ultima_actividad)
    VALUES ('p4', 'c2', 'ae-002', 'Beta Copa', 12000000, 'tentpole', 'completada', ?, ?)`).run(recent, now);
  testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa, fecha_creacion, fecha_ultima_actividad)
    VALUES ('p5', 'c2', 'ae-002', 'Beta Lanzamiento', 4000000, 'lanzamiento', 'completada', ?, ?)`).run(recent, now);

  // Gamma (c3): has tentpole
  testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa, fecha_creacion, fecha_ultima_actividad)
    VALUES ('p6', 'c3', 'ae-001', 'Gamma Evento', 6000000, 'tentpole', 'completada', ?, ?)`).run(recent, now);
}

function seedActivities() {
  const now = new Date();
  // Recent positive activity on c1
  for (let i = 0; i < 5; i++) {
    const date = new Date(now.getTime() - i * 3 * 86400000).toISOString();
    testDb.prepare(`INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha)
      VALUES (?, 'ae-001', 'c1', 'llamada', 'Seguimiento', 'positivo', ?)`).run(`act-${i}`, date);
  }
  // Old activity on c4 (stale)
  testDb.prepare(`INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha)
    VALUES ('act-old', 'ae-002', 'c4', 'email', 'Contacto inicial', 'neutral', ?)`).run(
    new Date(now.getTime() - 45 * 86400000).toISOString()
  );
}

function seedEvents() {
  const futureDate = new Date(Date.now() + 30 * 86400000).toISOString();
  testDb.prepare(`INSERT INTO crm_events (id, nombre, tipo, fecha_inicio, meta_ingresos, ingresos_actual, prioridad)
    VALUES ('ev1', 'Copa del Mundo', 'deportivo', ?, 50000000, 30000000, 'alta')`).run(futureDate);
}

function makeCtx(rol: 'ae' | 'gerente' | 'director' | 'vp', personaId: string) {
  const teamMap: Record<string, string[]> = {
    'vp-001': ['mgr-001', 'ae-001', 'ae-002'],
    'mgr-001': ['ae-001', 'ae-002'],
  };
  return {
    persona_id: personaId,
    rol,
    team_ids: teamMap[personaId] || [],
    full_team_ids: teamMap[personaId] || [],
  };
}

beforeEach(() => {
  setupDb();
  if (typeof _resetStatementCache === 'function') _resetStatementCache();
});

afterEach(() => {
  testDb.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recomendar_crosssell', () => {
  it('returns error when cuenta_nombre is missing', () => {
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(recomendar_crosssell({}, ctx));
    expect(result.error).toContain('cuenta_nombre');
  });

  it('returns error for unknown account', () => {
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Nonexistent' }, ctx));
    expect(result.error).toContain('No encontré');
  });

  it('returns account context info', () => {
    seedCompletedProposals();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Acme' }, ctx));
    expect(result.cuenta).toBe('Acme Corp');
    expect(result.vertical).toBe('Consumo');
    expect(result.historial.tipos_comprados).toContain('estacional');
    expect(result.historial.tipos_comprados).toContain('reforzamiento');
  });

  it('identifies tipo_oportunidad gaps from peers', () => {
    seedCompletedProposals();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Acme' }, ctx));
    // Acme has estacional + reforzamiento. Peers (Beta, Gamma) have tentpole + lanzamiento.
    const tipoRecs = result.recomendaciones.filter((r: any) => r.tipo === 'tipo_oportunidad');
    const titulos = tipoRecs.map((r: any) => r.titulo);
    expect(titulos.some((t: string) => t.includes('tentpole'))).toBe(true);
    expect(titulos.some((t: string) => t.includes('lanzamiento'))).toBe(true);
  });

  it('does not recommend tipos already purchased', () => {
    seedCompletedProposals();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Acme' }, ctx));
    const tipoRecs = result.recomendaciones.filter((r: any) => r.tipo === 'tipo_oportunidad');
    const titulos = tipoRecs.map((r: any) => r.titulo);
    expect(titulos.some((t: string) => t.includes('estacional'))).toBe(false);
    expect(titulos.some((t: string) => t.includes('reforzamiento'))).toBe(false);
  });

  it('does not recommend tipos already in flight', () => {
    seedCompletedProposals();
    // Add active tentpole proposal for Acme
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa, fecha_creacion, fecha_ultima_actividad)
      VALUES ('p-active', 'c1', 'ae-001', 'Acme Tentpole', 10000000, 'tentpole', 'en_discusion', datetime('now'), datetime('now'))`).run();

    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Acme' }, ctx));
    const tipoRecs = result.recomendaciones.filter((r: any) => r.tipo === 'tipo_oportunidad');
    const titulos = tipoRecs.map((r: any) => r.titulo);
    expect(titulos.some((t: string) => t.includes('tentpole'))).toBe(false);
  });

  it('includes valor_potencial from peer averages', () => {
    seedCompletedProposals();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Acme' }, ctx));
    const tipoRecs = result.recomendaciones.filter((r: any) => r.tipo === 'tipo_oportunidad');
    for (const rec of tipoRecs) {
      expect(rec.valor_potencial).toBeGreaterThan(0);
    }
  });

  it('includes event recommendations when events exist', () => {
    seedCompletedProposals();
    seedEvents();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Acme' }, ctx));
    const eventRecs = result.recomendaciones.filter((r: any) => r.tipo === 'evento');
    expect(eventRecs.length).toBeGreaterThan(0);
    expect(eventRecs[0].titulo).toContain('Copa del Mundo');
  });

  it('includes sentiment info', () => {
    seedCompletedProposals();
    seedActivities();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Acme' }, ctx));
    expect(result.sentimiento_reciente).toBeDefined();
    expect(result.sentimiento_reciente.positivo).toBe(5);
    expect(result.sentimiento_reciente.es_calido).toBe(true);
  });

  it('AE only sees own accounts', () => {
    seedCompletedProposals();
    const ctx = makeCtx('ae', 'ae-001');
    // Acme belongs to ae-001 — should work
    const result = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Acme' }, ctx));
    expect(result.cuenta).toBe('Acme Corp');

    // Beta belongs to ae-002 — should fail for ae-001
    const result2 = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Beta' }, ctx));
    expect(result2.error).toContain('No encontré');
  });

  it('gerente sees team accounts', () => {
    seedCompletedProposals();
    const ctx = makeCtx('gerente', 'mgr-001');
    // Both ae-001 and ae-002 accounts visible
    const r1 = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Acme' }, ctx));
    expect(r1.cuenta).toBe('Acme Corp');
    const r2 = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Beta' }, ctx));
    expect(r2.cuenta).toBe('Beta Inc');
  });

  it('respects limite parameter', () => {
    seedCompletedProposals();
    seedEvents();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Acme', limite: 2 }, ctx));
    expect(result.recomendaciones.length).toBeLessThanOrEqual(2);
    expect(result.total_recomendaciones).toBeGreaterThanOrEqual(result.recomendaciones.length);
  });

  it('detects reactivation opportunity for stale accounts', () => {
    // c4 (Delta Tech) has old activity and some completed proposals
    testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa, fecha_creacion, fecha_ultima_actividad)
      VALUES ('p-delta', 'c4', 'ae-002', 'Delta Campaign', 3000000, 'estacional', 'completada', datetime('now', '-60 days'), datetime('now', '-30 days'))`).run();
    seedActivities(); // includes old activity for c4

    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Delta' }, ctx));
    const reactivacion = result.recomendaciones.filter((r: any) => r.tipo === 'reactivacion');
    expect(reactivacion.length).toBe(1);
    expect(reactivacion[0].detalle).toContain('días sin actividad');
  });

  it('handles account with no purchase history', () => {
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Delta' }, ctx));
    expect(result.historial.tipos_comprados).toEqual([]);
    expect(result.historial.valor_total_ganado).toBe(0);
  });

  it('sorts by confianza then valor_potencial', () => {
    seedCompletedProposals();
    seedEvents();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(recomendar_crosssell({ cuenta_nombre: 'Acme' }, ctx));
    const recs = result.recomendaciones;
    for (let i = 1; i < recs.length; i++) {
      const order: Record<string, number> = { alta: 0, media: 1, baja: 2 };
      const prev = order[recs[i - 1].confianza];
      const curr = order[recs[i].confianza];
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });
});
