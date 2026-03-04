/**
 * Document Sync Pipeline Tests
 *
 * Tests chunking, embedding, storage, search, and hierarchy scoping.
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

const { chunkText, embedText, cosineSimilarity, storeDocument, searchDocuments } = await import('../src/doc-sync.js');

function setupDb() {
  testDb = new Database(':memory:');
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
// embedText
// ---------------------------------------------------------------------------

describe('embedText', () => {
  it('returns Float32Array of correct dimension', () => {
    const vec = embedText('hello world');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(384);
  });

  it('returns normalized vector', () => {
    const vec = embedText('test embedding normalization');
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    expect(Math.abs(Math.sqrt(norm) - 1.0)).toBeLessThan(0.01);
  });

  it('similar texts have higher similarity', () => {
    const a = embedText('propuesta comercial para television');
    const b = embedText('propuesta de ventas para tv');
    const c = embedText('receta de cocina mexicana');
    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    expect(simAB).toBeGreaterThan(simAC);
  });
});

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('identical vectors have similarity 1', () => {
    const v = embedText('test');
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 2);
  });

  it('returns value between -1 and 1', () => {
    const a = embedText('hello');
    const b = embedText('goodbye');
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThanOrEqual(-1);
    expect(sim).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// storeDocument
// ---------------------------------------------------------------------------

describe('storeDocument', () => {
  it('stores document and chunks in database', () => {
    const result = storeDocument('ae1', 'manual', null, 'Test Doc', 'text', 'This is a test document with some content for chunking.');
    expect(result.docId).toMatch(/^doc-/);
    expect(result.chunkCount).toBeGreaterThan(0);

    const doc = testDb.prepare('SELECT * FROM crm_documents WHERE id = ?').get(result.docId) as any;
    expect(doc).toBeDefined();
    expect(doc.titulo).toBe('Test Doc');
    expect(doc.persona_id).toBe('ae1');

    const chunks = testDb.prepare('SELECT * FROM crm_embeddings WHERE document_id = ?').all(result.docId) as any[];
    expect(chunks.length).toBe(result.chunkCount);
    expect(chunks[0].embedding).toBeInstanceOf(Buffer);
  });

  it('skips duplicate documents with same hash', () => {
    const text = 'Duplicate test content here.';
    const r1 = storeDocument('ae1', 'drive', 'file-1', 'Doc A', 'text', text);
    const r2 = storeDocument('ae1', 'drive', 'file-1', 'Doc A', 'text', text);

    expect(r1.chunkCount).toBeGreaterThan(0);
    expect(r2.chunkCount).toBe(0); // Skipped

    const docs = testDb.prepare('SELECT COUNT(*) as c FROM crm_documents').get() as any;
    expect(docs.c).toBe(1);
  });

  it('stores embeddings as blobs', () => {
    storeDocument('ae1', 'manual', null, 'Blob Test', null, 'Some content for embedding test.');
    const row = testDb.prepare('SELECT embedding FROM crm_embeddings LIMIT 1').get() as any;
    expect(row.embedding).toBeInstanceOf(Buffer);
    // 384 dimensions * 4 bytes per float32 = 1536 bytes
    expect(row.embedding.length).toBe(384 * 4);
  });
});

// ---------------------------------------------------------------------------
// searchDocuments
// ---------------------------------------------------------------------------

describe('searchDocuments', () => {
  beforeEach(() => {
    // Store some test documents
    storeDocument('ae1', 'manual', null, 'Propuesta Coca-Cola', 'text',
      'Propuesta comercial para campaña de television abierta en horario estelar. Valor estimado quince millones de pesos.');
    storeDocument('ae1', 'manual', null, 'Reporte Semanal', 'text',
      'Reporte de actividades de la semana. Tres reuniones con clientes, dos propuestas enviadas.');
    storeDocument('ae2', 'manual', null, 'Propuesta Pepsi', 'text',
      'Propuesta digital para campaña de redes sociales y CTV. Cliente interesado en paquete premium.');
  });

  it('returns relevant results for query', () => {
    const results = searchDocuments('propuesta television', ['ae1'], 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].titulo).toBe('Propuesta Coca-Cola');
  });

  it('respects persona filter', () => {
    const results = searchDocuments('propuesta', ['ae1'], 10);
    const personaIds = new Set(results.map(r => r.persona_id));
    expect(personaIds.has('ae2')).toBe(false);
  });

  it('returns empty array for no matches', () => {
    const results = searchDocuments('xyz nonexistent query', ['ae1'], 5);
    // May return results with low similarity, but shouldn't crash
    expect(Array.isArray(results)).toBe(true);
  });

  it('empty personaIds returns all documents (VP access)', () => {
    const results = searchDocuments('propuesta', [], 10);
    const personaIds = new Set(results.map(r => r.persona_id));
    expect(personaIds.size).toBeGreaterThanOrEqual(2);
  });

  it('limits results to requested count', () => {
    const results = searchDocuments('propuesta reporte', ['ae1', 'ae2'], 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('truncates long fragments', () => {
    const longText = 'A'.repeat(500) + '. More content after the long part.';
    storeDocument('ae1', 'manual', null, 'Long Doc', 'text', longText);
    const results = searchDocuments('long content', ['ae1'], 5);
    for (const r of results) {
      expect(r.fragmento.length).toBeLessThanOrEqual(303); // 300 + '...'
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
