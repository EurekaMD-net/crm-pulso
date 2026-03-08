/**
 * RAG Search Tool Tests
 *
 * Tests buscar_documentos with hierarchy scoping and sqlite-vec KNN search.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrmSchema } from '../src/schema.js';

let testDb: InstanceType<typeof Database>;

vi.mock('../src/db.js', () => ({
  getDatabase: () => testDb,
}));

vi.mock('../src/google-auth.js', () => ({
  isGoogleEnabled: () => false,
  getDriveClient: () => { throw new Error('Not configured'); },
}));

const noop = () => {};
const noopLogger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, child: () => noopLogger };
vi.mock('../src/logger.js', () => ({
  logger: noopLogger,
}));

// Mock embedding module to use local fallback (no API calls in tests)
vi.mock('../src/embedding.js', async (importOriginal) => {
  const orig = await importOriginal() as any;
  return {
    ...orig,
    embedText: async (text: string) => orig.embedTextLocal(text),
    embedBatch: async (texts: string[]) => texts.map((t: string) => orig.embedTextLocal(t)),
  };
});

const { storeDocument } = await import('../src/doc-sync.js');
const { buscar_documentos } = await import('../src/tools/rag.js');

function setupDb() {
  testDb = new Database(':memory:');
  sqliteVec.load(testDb);
  testDb.pragma('foreign_keys = ON');
  createCrmSchema(testDb);

  // Hierarchy: ger1 -> ae1, ae2
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo) VALUES ('ae1', 'María', 'ae', 'ae1', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo) VALUES ('ae2', 'Carlos', 'ae', 'ae2', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo) VALUES ('ger1', 'Miguel', 'gerente', 'ger1', 1)`).run();
  testDb.prepare(`UPDATE persona SET reporta_a = 'ger1' WHERE id IN ('ae1', 'ae2')`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo) VALUES ('vp1', 'Roberto', 'vp', 'vp1', 1)`).run();
}

beforeEach(async () => {
  setupDb();

  // Store test documents
  await storeDocument('ae1', 'manual', null, 'Propuesta TV Abierta', 'text',
    'Propuesta comercial para campaña de television abierta con presupuesto de quince millones.');
  await storeDocument('ae2', 'manual', null, 'Propuesta Digital', 'text',
    'Propuesta de campaña digital para redes sociales y CTV.');
  await storeDocument('ger1', 'manual', null, 'Reporte Equipo', 'text',
    'Reporte semanal del equipo de ventas con metricas de pipeline.');
});

// ---------------------------------------------------------------------------
// buscar_documentos tool
// ---------------------------------------------------------------------------

describe('buscar_documentos', () => {
  it('returns results for valid query', async () => {
    const result = JSON.parse(await buscar_documentos(
      { consulta: 'propuesta television' },
      { persona_id: 'ae1', rol: 'ae', team_ids: [], full_team_ids: [] },
    ));
    expect(result.resultados).toBeDefined();
    expect(result.resultados.length).toBeGreaterThan(0);
  });

  it('AE sees only own documents', async () => {
    const result = JSON.parse(await buscar_documentos(
      { consulta: 'propuesta' },
      { persona_id: 'ae1', rol: 'ae', team_ids: [], full_team_ids: [] },
    ));
    const personaIds = new Set(result.resultados.map((r: any) => r.persona_id));
    expect(personaIds.has('ae2')).toBe(false);
    expect(personaIds.has('ger1')).toBe(false);
  });

  it('gerente sees own + team documents', async () => {
    const result = JSON.parse(await buscar_documentos(
      { consulta: 'propuesta reporte' },
      { persona_id: 'ger1', rol: 'gerente', team_ids: ['ae1', 'ae2'], full_team_ids: ['ae1', 'ae2'] },
    ));
    // Should see ae1, ae2, and ger1's documents
    expect(result.resultados.length).toBeGreaterThanOrEqual(2);
  });

  it('VP sees all documents', async () => {
    const result = JSON.parse(await buscar_documentos(
      { consulta: 'propuesta' },
      { persona_id: 'vp1', rol: 'vp', team_ids: [], full_team_ids: [] },
    ));
    const personaIds = new Set(result.resultados.map((r: any) => r.persona_id));
    expect(personaIds.size).toBeGreaterThanOrEqual(2);
  });

  it('returns error without consulta', async () => {
    const result = JSON.parse(await buscar_documentos(
      {},
      { persona_id: 'ae1', rol: 'ae', team_ids: [], full_team_ids: [] },
    ));
    expect(result.error).toBeDefined();
  });

  it('respects limite parameter', async () => {
    const result = JSON.parse(await buscar_documentos(
      { consulta: 'propuesta', limite: 1 },
      { persona_id: 'vp1', rol: 'vp', team_ids: [], full_team_ids: [] },
    ));
    expect(result.resultados.length).toBeLessThanOrEqual(1);
  });

  it('results include similitud score', async () => {
    const result = JSON.parse(await buscar_documentos(
      { consulta: 'propuesta television' },
      { persona_id: 'ae1', rol: 'ae', team_ids: [], full_team_ids: [] },
    ));
    for (const r of result.resultados) {
      expect(typeof r.similitud).toBe('number');
      expect(r.similitud).toBeGreaterThanOrEqual(0);
      expect(r.similitud).toBeLessThanOrEqual(1);
    }
  });
});
