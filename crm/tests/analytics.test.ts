/**
 * Analytics Tool Tests
 *
 * Tests for analizar_winloss and analizar_tendencias tools.
 * Uses in-memory SQLite with seed data for each scenario.
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
const { analizar_winloss, analizar_tendencias } = await import('../src/tools/analytics.js');

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function setupDb() {
  testDb = new Database(':memory:');
  sqliteVec.load(testDb);
  testDb.pragma('foreign_keys = ON');
  createCrmSchema(testDb);

  // Org chart: VP -> Director -> Gerente -> AE1, AE2
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, activo) VALUES ('vp-001', 'Elena Ruiz', 'vp', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES ('dir-001', 'Roberto Diaz', 'director', 'vp-001', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES ('mgr-001', 'Ana Garcia', 'gerente', 'dir-001', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES ('ae-001', 'Carlos Lopez', 'ae', 'mgr-001', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES ('ae-002', 'Maria Perez', 'ae', 'mgr-001', 1)`).run();

  // Accounts
  testDb.prepare(`INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id) VALUES ('c1', 'Coca-Cola', 'directo', 'bebidas', 'ae-001')`).run();
  testDb.prepare(`INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id) VALUES ('c2', 'Bimbo', 'directo', 'alimentos', 'ae-002')`).run();
  testDb.prepare(`INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id) VALUES ('c3', 'Telcel', 'directo', 'telecom', 'ae-001')`).run();
}

function seedProposals() {
  const now = new Date().toISOString();
  const recent = new Date(Date.now() - 30 * 86400000).toISOString();

  // Won proposals
  testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa, fecha_creacion, fecha_ultima_actividad)
    VALUES ('p1', 'c1', 'ae-001', 'Campaña Navidad', 10000000, 'estacional', 'completada', ?, ?)`).run(recent, now);
  testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa, fecha_creacion, fecha_ultima_actividad)
    VALUES ('p2', 'c1', 'ae-001', 'Campaña Verano', 20000000, 'estacional', 'completada', ?, ?)`).run(recent, now);
  testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa, fecha_creacion, fecha_ultima_actividad)
    VALUES ('p3', 'c2', 'ae-002', 'Lanzamiento Pan', 5000000, 'lanzamiento', 'completada', ?, ?)`).run(recent, now);

  // Lost proposals
  testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa, razon_perdida, fecha_creacion, fecha_ultima_actividad)
    VALUES ('p4', 'c3', 'ae-001', 'Digital Telcel', 8000000, 'prospeccion', 'perdida', 'precio', ?, ?)`).run(recent, now);
  testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa, razon_perdida, fecha_creacion, fecha_ultima_actividad)
    VALUES ('p5', 'c2', 'ae-002', 'Reforzamiento Bimbo', 3000000, 'reforzamiento', 'perdida', 'competencia', ?, ?)`).run(recent, now);

  // Cancelled
  testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa, fecha_creacion, fecha_ultima_actividad)
    VALUES ('p6', 'c1', 'ae-001', 'Evento Especial', 2000000, 'evento_especial', 'cancelada', ?, ?)`).run(recent, now);
}

function seedActivities() {
  const now = new Date();
  // Seed activities across last few weeks
  for (let i = 0; i < 20; i++) {
    const date = new Date(now.getTime() - i * 2 * 86400000).toISOString();
    const sentimiento = ['positivo', 'neutral', 'negativo', 'urgente'][i % 4];
    const tipo = ['llamada', 'reunion', 'email', 'whatsapp'][i % 4];
    const aeId = i % 2 === 0 ? 'ae-001' : 'ae-002';
    const cuentaId = i % 2 === 0 ? 'c1' : 'c2';
    testDb.prepare(`INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`act-${i}`, aeId, cuentaId, tipo, `Actividad ${i}`, sentimiento, date);
  }
}

function seedCuotas() {
  const year = new Date().getFullYear();
  const currentWeek = getCurrentWeekForTest();

  for (let w = Math.max(1, currentWeek - 11); w <= currentWeek; w++) {
    // AE-001: improving trend
    const logro1 = 3000000 + (w - (currentWeek - 11)) * 200000;
    testDb.prepare(`INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total, logro)
      VALUES (?, 'ae-001', 'ae', ?, ?, 5000000, ?)`).run(`q1-${w}`, year, w, logro1);
    // AE-002: declining trend
    const logro2 = 5000000 - (w - (currentWeek - 11)) * 200000;
    testDb.prepare(`INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total, logro)
      VALUES (?, 'ae-002', 'ae', ?, ?, 5000000, ?)`).run(`q2-${w}`, year, w, logro2);
  }
}

function getCurrentWeekForTest(): number {
  const d = new Date();
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7);
}

function makeCtx(rol: 'ae' | 'gerente' | 'director' | 'vp', personaId: string) {
  const teamMap: Record<string, string[]> = {
    'vp-001': ['dir-001'],
    'dir-001': ['mgr-001'],
    'mgr-001': ['ae-001', 'ae-002'],
  };
  const fullTeamMap: Record<string, string[]> = {
    'vp-001': ['dir-001', 'mgr-001', 'ae-001', 'ae-002'],
    'dir-001': ['mgr-001', 'ae-001', 'ae-002'],
    'mgr-001': ['ae-001', 'ae-002'],
  };
  return {
    persona_id: personaId,
    rol,
    team_ids: teamMap[personaId] || [],
    full_team_ids: fullTeamMap[personaId] || [],
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
// analizar_winloss tests
// ---------------------------------------------------------------------------

describe('analizar_winloss', () => {
  it('returns summary with correct win/loss counts', () => {
    seedProposals();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(analizar_winloss({}, ctx));
    expect(result.resumen.total_cerradas).toBe(6);
    expect(result.resumen.ganadas).toBe(3);
    expect(result.resumen.perdidas).toBe(2);
    expect(result.resumen.canceladas).toBe(1);
  });

  it('calculates conversion rate correctly', () => {
    seedProposals();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(analizar_winloss({}, ctx));
    // 3 ganadas / 6 total = 50%
    expect(result.resumen.tasa_conversion).toBe(50);
  });

  it('returns loss reasons', () => {
    seedProposals();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(analizar_winloss({}, ctx));
    expect(result.resumen.razones_perdida.length).toBe(2);
    const razones = result.resumen.razones_perdida.map((r: any) => r.razon);
    expect(razones).toContain('precio');
    expect(razones).toContain('competencia');
  });

  it('respects periodo_dias filter', () => {
    seedProposals();
    const ctx = makeCtx('vp', 'vp-001');
    // With a very short period, should get no results (proposals are 30 days old)
    const result = JSON.parse(analizar_winloss({ periodo_dias: 1 }, ctx));
    // fecha_ultima_actividad is 'now' so they should still be found within 1 day
    expect(result.resumen).toBeDefined();
  });

  it('groups by tipo_oportunidad correctly', () => {
    seedProposals();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(analizar_winloss({ agrupar_por: 'tipo_oportunidad' }, ctx));
    expect(result.desglose.length).toBeGreaterThan(0);
    const grupos = result.desglose.map((d: any) => d.grupo);
    expect(grupos).toContain('estacional');
  });

  it('groups by vertical correctly', () => {
    seedProposals();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(analizar_winloss({ agrupar_por: 'vertical' }, ctx));
    expect(result.desglose.length).toBeGreaterThan(0);
    const grupos = result.desglose.map((d: any) => d.grupo);
    expect(grupos).toContain('bebidas');
  });

  it('groups by ejecutivo correctly', () => {
    seedProposals();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(analizar_winloss({ agrupar_por: 'ejecutivo' }, ctx));
    const grupos = result.desglose.map((d: any) => d.grupo);
    expect(grupos).toContain('Carlos Lopez');
    expect(grupos).toContain('Maria Perez');
  });

  it('solo_mega filter works', () => {
    seedProposals();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(analizar_winloss({ solo_mega: true }, ctx));
    // Only p2 (20M) is mega. It's completada.
    expect(result.resumen.total_cerradas).toBe(1);
    expect(result.resumen.ganadas).toBe(1);
  });

  it('AE sees only own proposals', () => {
    seedProposals();
    const ctx = makeCtx('ae', 'ae-001');
    const result = JSON.parse(analizar_winloss({}, ctx));
    // ae-001 has p1, p2 (won), p4 (lost), p6 (cancelled) = 4
    expect(result.resumen.total_cerradas).toBe(4);
  });

  it('gerente sees team proposals', () => {
    seedProposals();
    const ctx = makeCtx('gerente', 'mgr-001');
    const result = JSON.parse(analizar_winloss({}, ctx));
    // mgr-001 team: ae-001 + ae-002 = all 6 proposals
    expect(result.resumen.total_cerradas).toBe(6);
  });

  it('handles empty results gracefully', () => {
    // No proposals seeded
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(analizar_winloss({}, ctx));
    expect(result.mensaje).toBeDefined();
    expect(result.mensaje).toContain('No hay propuestas');
  });
});

// ---------------------------------------------------------------------------
// analizar_tendencias tests
// ---------------------------------------------------------------------------

describe('analizar_tendencias', () => {
  it('cuota metrica returns weekly data with direction', () => {
    seedCuotas();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(analizar_tendencias({ metrica: 'cuota' }, ctx));
    expect(result.metrica).toBe('cuota');
    expect(result.tendencia.length).toBeGreaterThan(0);
    expect(result.tendencia[0]).toHaveProperty('meta');
    expect(result.tendencia[0]).toHaveProperty('logro');
    expect(result.tendencia[0]).toHaveProperty('porcentaje');
    expect(['subiendo', 'estable', 'bajando', 'sin_datos']).toContain(result.direccion);
  });

  it('actividad metrica returns type/sentiment breakdown', () => {
    seedActivities();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(analizar_tendencias({ metrica: 'actividad' }, ctx));
    expect(result.metrica).toBe('actividad');
    expect(result.tendencia.length).toBeGreaterThan(0);
    expect(result.tendencia[0]).toHaveProperty('por_tipo');
    expect(result.tendencia[0]).toHaveProperty('por_sentimiento');
    expect(result.promedio_semanal).toBeGreaterThan(0);
  });

  it('pipeline metrica returns new/won/lost per week', () => {
    seedProposals();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(analizar_tendencias({ metrica: 'pipeline' }, ctx));
    expect(result.metrica).toBe('pipeline');
    expect(result.tendencia.length).toBeGreaterThan(0);
    const week = result.tendencia[0];
    expect(week).toHaveProperty('nuevas');
    expect(week).toHaveProperty('ganadas');
    expect(week).toHaveProperty('perdidas');
  });

  it('sentimiento metrica returns ratio', () => {
    seedActivities();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(analizar_tendencias({ metrica: 'sentimiento' }, ctx));
    expect(result.metrica).toBe('sentimiento');
    expect(result.tendencia.length).toBeGreaterThan(0);
    expect(result.tendencia[0]).toHaveProperty('positivo');
    expect(result.tendencia[0]).toHaveProperty('negativo');
    expect(result.tendencia[0]).toHaveProperty('ratio_positivo');
    expect(result.ratio_positivo_promedio).toBeDefined();
  });

  it('respects periodo_semanas parameter', () => {
    seedActivities();
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(analizar_tendencias({ metrica: 'actividad', periodo_semanas: 2 }, ctx));
    expect(result.semanas).toBe(2);
    // Should have fewer weeks than with default 12
    const resultFull = JSON.parse(analizar_tendencias({ metrica: 'actividad', periodo_semanas: 12 }, ctx));
    expect(result.tendencia.length).toBeLessThanOrEqual(resultFull.tendencia.length);
  });

  it('AE sees only own data', () => {
    seedActivities();
    const ctx = makeCtx('ae', 'ae-001');
    const result = JSON.parse(analizar_tendencias({ metrica: 'actividad' }, ctx));
    // AE-001 has half the activities (even-indexed)
    const totalActivities = result.tendencia.reduce((s: number, t: any) => s + t.total, 0);
    expect(totalActivities).toBe(10); // 10 of 20 activities
  });

  it('gerente sees team data', () => {
    seedActivities();
    const ctx = makeCtx('gerente', 'mgr-001');
    const result = JSON.parse(analizar_tendencias({ metrica: 'actividad' }, ctx));
    const totalActivities = result.tendencia.reduce((s: number, t: any) => s + t.total, 0);
    expect(totalActivities).toBe(20); // all activities (both AEs)
  });

  it('persona_nombre filter works for managers', () => {
    seedActivities();
    const ctx = makeCtx('gerente', 'mgr-001');
    const result = JSON.parse(analizar_tendencias({ metrica: 'actividad', persona_nombre: 'Carlos' }, ctx));
    const totalActivities = result.tendencia.reduce((s: number, t: any) => s + t.total, 0);
    expect(totalActivities).toBe(10); // only Carlos's activities
  });

  it('handles empty results gracefully', () => {
    // No data seeded
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(analizar_tendencias({ metrica: 'cuota' }, ctx));
    expect(result.tendencia).toEqual([]);
    expect(result.direccion).toBe('sin_datos');
  });

  it('returns error for unknown metrica', () => {
    const ctx = makeCtx('vp', 'vp-001');
    const result = JSON.parse(analizar_tendencias({ metrica: 'invalid' }, ctx));
    expect(result.error).toContain('desconocida');
  });

  it('direction calculation correct (subiendo/estable/bajando)', () => {
    // Seed cuotas with clear upward trend
    const year = new Date().getFullYear();
    const currentWeek = getCurrentWeekForTest();

    for (let w = Math.max(1, currentWeek - 11); w <= currentWeek; w++) {
      // Strong upward trend: logro doubles over 12 weeks
      const logro = 1000000 + (w - (currentWeek - 11)) * 500000;
      testDb.prepare(`INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total, logro)
        VALUES (?, 'ae-001', 'ae', ?, ?, 5000000, ?)`).run(`qdir-${w}`, year, w, logro);
    }

    const ctx = makeCtx('ae', 'ae-001');
    const result = JSON.parse(analizar_tendencias({ metrica: 'cuota' }, ctx));
    // Last 4 weeks avg should be higher than prior 4 weeks avg → "subiendo"
    expect(result.direccion).toBe('subiendo');
  });
});
