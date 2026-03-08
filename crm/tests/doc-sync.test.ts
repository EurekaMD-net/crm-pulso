/**
 * Document Sync Pipeline Tests
 *
 * Tests chunking, storage (with sqlite-vec), search (KNN), and hierarchy scoping.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrmSchema } from '../src/schema.js';
import { embedTextLocal, EMBEDDING_DIMS } from '../src/embedding.js';

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

const { chunkText, storeDocument, searchDocuments } = await import('../src/doc-sync.js');

function setupDb() {
  testDb = new Database(':memory:');
  sqliteVec.load(testDb);
  testDb.pragma('foreign_keys = ON');
  createCrmSchema(testDb);

  // Seed personas
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo) VALUES ('ae1', 'María', 'ae', 'ae1', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo) VALUES ('ae2', 'Carlos', 'ae', 'ae2', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, reporta_a, activo) VALUES ('ger1', 'Miguel', 'gerente', 'ger1', null, 1)`).run();
  testDb.prepare(`UPDATE persona SET reporta_a = 'ger1' WHERE id IN ('ae1', 'ae2')`).run();
}

beforeEach(setupDb);

// ---------------------------------------------------------------------------
// chunkText
// ---------------------------------------------------------------------------

describe('chunkText', () => {
  it('returns empty for empty text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
  });

  it('returns single chunk for short text', () => {
    const chunks = chunkText('Hello world. This is a test.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].content).toContain('Hello world');
  });

  it('splits long text into multiple chunks', () => {
    // Create text with multiple paragraphs exceeding chunk size
    const paragraphs = Array.from({ length: 20 }, (_, i) =>
      `Paragraph ${i}. ` + 'This is a longer paragraph with enough content to approach the chunk boundary. '.repeat(5),
    );
    const text = paragraphs.join('\n\n');
    const chunks = chunkText(text, 256);
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk has sequential index
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  it('preserves content across chunks', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const chunks = chunkText(text, 1000);
    const combined = chunks.map(c => c.content).join(' ');
    expect(combined).toContain('First paragraph');
    expect(combined).toContain('Third paragraph');
  });
});

// ---------------------------------------------------------------------------
// storeDocument
// ---------------------------------------------------------------------------

describe('storeDocument', () => {
  it('stores document and chunks in database', async () => {
    const result = await storeDocument('ae1', 'manual', null, 'Test Doc', 'text', 'This is a test document with some content for chunking.');
    expect(result.docId).toMatch(/^doc-/);
    expect(result.chunkCount).toBeGreaterThan(0);

    const doc = testDb.prepare('SELECT * FROM crm_documents WHERE id = ?').get(result.docId) as any;
    expect(doc).toBeDefined();
    expect(doc.titulo).toBe('Test Doc');
    expect(doc.persona_id).toBe('ae1');

    const chunks = testDb.prepare('SELECT * FROM crm_embeddings WHERE document_id = ?').all(result.docId) as any[];
    expect(chunks.length).toBe(result.chunkCount);
  });

  it('stores vectors in crm_vec_embeddings', async () => {
    const result = await storeDocument('ae1', 'manual', null, 'Vec Test', null, 'Some content for vector storage test.');
    const chunks = testDb.prepare('SELECT rowid FROM crm_embeddings WHERE document_id = ?').all(result.docId) as any[];
    expect(chunks.length).toBeGreaterThan(0);

    // Verify vectors exist in vec table
    const vecCount = testDb.prepare('SELECT COUNT(*) as c FROM crm_vec_embeddings').get() as any;
    expect(vecCount.c).toBe(chunks.length);
  });

  it('skips duplicate documents with same hash', async () => {
    const text = 'Duplicate test content here.';
    const r1 = await storeDocument('ae1', 'drive', 'file-1', 'Doc A', 'text', text);
    const r2 = await storeDocument('ae1', 'drive', 'file-1', 'Doc A', 'text', text);

    expect(r1.chunkCount).toBeGreaterThan(0);
    expect(r2.chunkCount).toBe(0); // Skipped

    const docs = testDb.prepare('SELECT COUNT(*) as c FROM crm_documents').get() as any;
    expect(docs.c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// searchDocuments
// ---------------------------------------------------------------------------

describe('searchDocuments', () => {
  beforeEach(async () => {
    // Store some test documents
    await storeDocument('ae1', 'manual', null, 'Propuesta Coca-Cola', 'text',
      'Propuesta comercial para campaña de television abierta en horario estelar. Valor estimado quince millones de pesos.');
    await storeDocument('ae1', 'manual', null, 'Reporte Semanal', 'text',
      'Reporte de actividades de la semana. Tres reuniones con clientes, dos propuestas enviadas.');
    await storeDocument('ae2', 'manual', null, 'Propuesta Pepsi', 'text',
      'Propuesta digital para campaña de redes sociales y CTV. Cliente interesado en paquete premium.');
  });

  it('returns relevant results for query', async () => {
    const results = await searchDocuments('propuesta television', ['ae1'], 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].titulo).toBe('Propuesta Coca-Cola');
  });

  it('respects persona filter', async () => {
    const results = await searchDocuments('propuesta', ['ae1'], 10);
    const personaIds = new Set(results.map(r => r.persona_id));
    expect(personaIds.has('ae2')).toBe(false);
  });

  it('returns empty array when no documents exist', async () => {
    // Search with a persona that has no docs
    const results = await searchDocuments('xyz nonexistent query', ['ger1'], 5);
    expect(Array.isArray(results)).toBe(true);
  });

  it('empty personaIds returns all documents (VP access)', async () => {
    const results = await searchDocuments('propuesta', [], 10);
    const personaIds = new Set(results.map(r => r.persona_id));
    expect(personaIds.size).toBeGreaterThanOrEqual(2);
  });

  it('limits results to requested count', async () => {
    const results = await searchDocuments('propuesta reporte', ['ae1', 'ae2'], 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('truncates long fragments', async () => {
    const longText = 'A'.repeat(500) + '. More content after the long part.';
    await storeDocument('ae1', 'manual', null, 'Long Doc', 'text', longText);
    const results = await searchDocuments('long content', ['ae1'], 5);
    for (const r of results) {
      expect(r.fragmento.length).toBeLessThanOrEqual(303); // 300 + '...'
    }
  });

  it('returns similarity scores between 0 and 1', async () => {
    const results = await searchDocuments('propuesta television', ['ae1'], 5);
    for (const r of results) {
      expect(r.similitud).toBeGreaterThanOrEqual(0);
      expect(r.similitud).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// syncDocuments (graceful degradation)
// ---------------------------------------------------------------------------

describe('syncDocuments', () => {
  it('returns 0 when Google is not configured', async () => {
    const { syncDocuments } = await import('../src/doc-sync.js');
    const count = await syncDocuments();
    expect(count).toBe(0);
  });
});
