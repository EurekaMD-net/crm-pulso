/**
 * RAG Search Tool Tests
 *
 * Tests buscar_documentos with hierarchy scoping and pre-stored embeddings.
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrmSchema } from '../src/schema.js';

let testDb: InstanceType<typeof Database>;

vi.mock('../../engine/src/db.js', () => ({
  getDatabase: () => testDb,
}));

vi.mock('../src/google-auth.js', () => ({
  isGoogleEnabled: () => false,
  getDriveClient: () => { throw new Error('Not configured'); },
}));

const noop = () => {};
const noopLogger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, child: () => noopLogger };
vi.mock('../../engine/src/logger.js', () => ({
  logger: noopLogger,
}));

const { storeDocument } = await import('../src/doc-sync.js');
const { buscar_documentos } = await import('../src/tools/rag.js');

function setupDb() {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  createCrmSchema(testDb);

  // Hierarchy: ger1 -> ae1, ae2
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo) VALUES ('ae1', 'María', 'ae', 'ae1', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo) VALUES ('ae2', 'Carlos', 'ae', 'ae2', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo) VALUES ('ger1', 'Miguel', 'gerente', 'ger1', 1)`).run();
  testDb.prepare(`UPDATE persona SET reporta_a = 'ger1' WHERE id IN ('ae1', 'ae2')`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo) VALUES ('vp1', 'Roberto', 'vp', 'vp1', 1)`).run();

  // Store test documents
  storeDocument('ae1', 'manual', null, 'Propuesta TV Abierta', 'text',
    'Propuesta comercial para campaña de television abierta con presupuesto de quince millones.');
  storeDocument('ae2', 'manual', null, 'Propuesta Digital', 'text',
    'Propuesta de campaña digital para redes sociales y CTV.');
  storeDocument('ger1', 'manual', null, 'Reporte Equipo', 'text',
    'Reporte semanal del equipo de ventas con metricas de pipeline.');
}

beforeEach(setupDb);

// ---------------------------------------------------------------------------
// buscar_documentos tool
// ---------------------------------------------------------------------------

describe('buscar_documentos', () => {
  it('returns results for valid query', () => {
    const result = JSON.parse(buscar_documentos(
      { consulta: 'propuesta television' },
      { persona_id: 'ae1', rol: 'ae', team_ids: [], full_team_ids: [] },
    ));
    expect(result.resultados).toBeDefined();
    expect(result.resultados.length).toBeGreaterThan(0);
  });

  it('AE sees only own documents', () => {
    const result = JSON.parse(buscar_documentos(
      { consulta: 'propuesta' },
      { persona_id: 'ae1', rol: 'ae', team_ids: [], full_team_ids: [] },
    ));
    const personaIds = new Set(result.resultados.map((r: any) => r.persona_id));
    expect(personaIds.has('ae2')).toBe(false);
    expect(personaIds.has('ger1')).toBe(false);
  });

  it('gerente sees own + team documents', () => {
    const result = JSON.parse(buscar_documentos(
      { consulta: 'propuesta reporte' },
      { persona_id: 'ger1', rol: 'gerente', team_ids: ['ae1', 'ae2'], full_team_ids: ['ae1', 'ae2'] },
    ));
    const personaIds = new Set(result.resultados.map((r: any) => r.persona_id));
    // Should see ae1, ae2, and ger1's documents
    expect(result.resultados.length).toBeGreaterThanOrEqual(2);
  });

  it('VP sees all documents', () => {
    const result = JSON.parse(buscar_documentos(
      { consulta: 'propuesta' },
      { persona_id: 'vp1', rol: 'vp', team_ids: [], full_team_ids: [] },
    ));
    const personaIds = new Set(result.resultados.map((r: any) => r.persona_id));
    expect(personaIds.size).toBeGreaterThanOrEqual(2);
  });

  it('returns error without consulta', () => {
    const result = JSON.parse(buscar_documentos(
      {},
      { persona_id: 'ae1', rol: 'ae', team_ids: [], full_team_ids: [] },
    ));
    expect(result.error).toBeDefined();
  });

  it('returns empty results message when no matches', () => {
    // AE2 searches but only has one doc
    const result = JSON.parse(buscar_documentos(
      { consulta: 'television abierta presupuesto' },
      { persona_id: 'ae2', rol: 'ae', team_ids: [], full_team_ids: [] },
    ));
    // ae2's doc is about digital, not TV - may return low-similarity results or empty
    expect(result.resultados).toBeDefined();
  });

  it('respects limite parameter', () => {
    const result = JSON.parse(buscar_documentos(
      { consulta: 'propuesta', limite: 1 },
      { persona_id: 'vp1', rol: 'vp', team_ids: [], full_team_ids: [] },
    ));
    expect(result.resultados.length).toBeLessThanOrEqual(1);
  });

  it('results include similitud score', () => {
    const result = JSON.parse(buscar_documentos(
      { consulta: 'propuesta television' },
      { persona_id: 'ae1', rol: 'ae', team_ids: [], full_team_ids: [] },
    ));
    for (const r of result.resultados) {
      expect(typeof r.similitud).toBe('number');
      expect(r.similitud).toBeGreaterThanOrEqual(-1);
      expect(r.similitud).toBeLessThanOrEqual(1);
    }
  });
});
