/**
 * Embedding API client for Dashscope text-embedding-v3.
 *
 * OpenAI-compatible /v1/embeddings endpoint. Falls back to a
 * deterministic trigram hash when the API is unavailable.
 */

import { logger as parentLogger } from "./logger.js";
import { CircuitBreaker } from "./circuit-breaker.js";

const logger = parentLogger.child({ component: "embedding" });

const embeddingBreaker = new CircuitBreaker({ name: "embedding" });

/** @internal — exposed for testing only */
export function _resetEmbeddingBreaker(): void {
  embeddingBreaker.reset();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EMBEDDING_DIMS = 1024;

const EMBEDDING_BATCH_SIZE = 10; // text-embedding-v3 max per request
const EMBEDDING_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Endpoint resolution
// ---------------------------------------------------------------------------

interface EmbeddingEndpoint {
  url: string;
  key: string;
  model: string;
}

function getEndpoint(): EmbeddingEndpoint | null {
  const key = process.env.INFERENCE_PRIMARY_KEY;
  if (!key) return null;

  const baseUrl =
    process.env.EMBEDDING_URL || process.env.INFERENCE_PRIMARY_URL;
  if (!baseUrl) return null;

  const model = process.env.EMBEDDING_MODEL || "text-embedding-v3";
  return { url: `${baseUrl.replace(/\/+$/, "")}/embeddings`, key, model };
}

// ---------------------------------------------------------------------------
// API embedding
// ---------------------------------------------------------------------------

async function callEmbeddingApi(
  texts: string[],
  endpoint: EmbeddingEndpoint,
): Promise<Float32Array[]> {
  const body = JSON.stringify({
    model: endpoint.model,
    input: texts,
    dimensions: EMBEDDING_DIMS,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.key}`,
      },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Embedding API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      data: { embedding: number[]; index: number }[];
    };

    // Sort by index (API may return out of order)
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => new Float32Array(d.embedding));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embed a single text. Uses API if configured, falls back to local hash.
 */
export async function embedText(text: string): Promise<Float32Array> {
  const results = await embedBatch([text]);
  return results[0];
}

/**
 * Embed multiple texts in batches of 10. Returns one Float32Array per input.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const endpoint = getEndpoint();
  if (!endpoint) {
    logger.warn("No embedding API configured — using local fallback");
    return texts.map((t) => embedTextLocal(t));
  }

  // Skip all batches to local fallback if circuit is open
  if (embeddingBreaker.isOpen()) {
    logger.warn("Embedding circuit open — using local fallback for all");
    return texts.map((t) => embedTextLocal(t));
  }

  const results: Float32Array[] = new Array(texts.length);

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    try {
      const embeddings = await callEmbeddingApi(batch, endpoint);
      for (let j = 0; j < embeddings.length; j++) {
        results[i + j] = embeddings[j];
      }
      embeddingBreaker.recordSuccess();
    } catch (err) {
      embeddingBreaker.recordFailure(err);
      logger.warn(
        { err, batchStart: i, batchSize: batch.length },
        "Embedding API failed — falling back to local",
      );
      for (let j = 0; j < batch.length; j++) {
        results[i + j] = embedTextLocal(batch[j]);
      }

      // If breaker just opened, fast-forward remaining batches to local
      if (embeddingBreaker.isOpen()) {
        logger.warn(
          "Embedding circuit opened mid-batch — remaining batches use local",
        );
        for (let k = i + EMBEDDING_BATCH_SIZE; k < texts.length; k++) {
          results[k] = embedTextLocal(texts[k]);
        }
        break;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Local fallback (deterministic trigram hash — not semantic)
// ---------------------------------------------------------------------------

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Deterministic trigram-based embedding. Not semantic — used only as a
 * fallback when the embedding API is unavailable.
 */
export function embedTextLocal(
  text: string,
  dims = EMBEDDING_DIMS,
): Float32Array {
  const vec = new Float32Array(dims);
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, "");
  const words = normalized.split(/\s+/).filter((w) => w.length > 1);

  for (const word of words) {
    for (let i = 0; i < Math.min(word.length - 1, 3); i++) {
      const trigram = word.slice(i, i + 3) || word;
      const hash = simpleHash(trigram);
      const dim = Math.abs(hash) % dims;
      vec[dim] += hash > 0 ? 1 : -1;
    }
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) vec[i] /= norm;

  return vec;
}
