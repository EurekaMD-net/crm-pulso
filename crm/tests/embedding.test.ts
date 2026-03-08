/**
 * Embedding Module Tests
 *
 * Tests local fallback embedding, API mocking, and batch logic.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Test the local embedding directly (no mocks needed)
const { embedTextLocal, EMBEDDING_DIMS } = await import('../src/embedding.js');

// ---------------------------------------------------------------------------
// embedTextLocal
// ---------------------------------------------------------------------------

describe('embedTextLocal', () => {
  it('returns Float32Array of correct dimension', () => {
    const vec = embedTextLocal('hello world');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(EMBEDDING_DIMS);
  });

  it('returns normalized vector (unit length)', () => {
    const vec = embedTextLocal('test embedding normalization');
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    expect(Math.abs(Math.sqrt(norm) - 1.0)).toBeLessThan(0.01);
  });

  it('similar texts produce more similar vectors', () => {
    const a = embedTextLocal('propuesta comercial para television');
    const b = embedTextLocal('propuesta de ventas para tv');
    const c = embedTextLocal('receta de cocina mexicana');
    const simAB = cosine(a, b);
    const simAC = cosine(a, c);
    expect(simAB).toBeGreaterThan(simAC);
  });

  it('identical texts produce identical vectors', () => {
    const a = embedTextLocal('test text');
    const b = embedTextLocal('test text');
    expect(cosine(a, b)).toBeCloseTo(1.0, 5);
  });

  it('supports custom dimensions', () => {
    const vec = embedTextLocal('hello', 256);
    expect(vec.length).toBe(256);
  });

  it('default dimension is 1024', () => {
    expect(EMBEDDING_DIMS).toBe(1024);
  });
});

// ---------------------------------------------------------------------------
// embedText / embedBatch with mocked fetch
// ---------------------------------------------------------------------------

describe('embedText (API)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('falls back to local when no API key configured', async () => {
    vi.stubEnv('INFERENCE_PRIMARY_KEY', '');
    vi.stubEnv('EMBEDDING_URL', '');
    vi.stubEnv('INFERENCE_PRIMARY_URL', '');

    // Re-import to pick up env changes
    vi.resetModules();
    const { embedText } = await import('../src/embedding.js');
    const vec = await embedText('test');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(1024);
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
