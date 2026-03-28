/**
 * Map-Reduce Summarizer — Shared Analysis Module
 *
 * Token-budgeted summarization that handles arbitrarily large description
 * lists by chunking them into LLM-sized groups and recursively reducing.
 *
 * Adapted from LightRAG's _handle_entity_relation_summary pattern
 * (github.com/hkuds/lightrag, operate.py:166-300).
 *
 * Used by: overnight engine (account briefings), proposal drafter (reasoning
 * assembly), any pipeline that must merge N text fragments into a coherent
 * summary within a token budget.
 */

import type { ChatMessage } from "../inference-adapter.js";
import { infer } from "../inference-adapter.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Approximate token count. ~1 token per 4 chars for mixed Spanish/English. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SummarizerConfig {
  /**
   * Max tokens that can be sent to LLM in a single summarization call.
   * Includes the descriptions + system prompt overhead (~200 tokens).
   * Default: 3000 (safe for 4K context models with room for output).
   */
  contextWindowTokens?: number;

  /**
   * If the combined descriptions are below this token count AND there are
   * fewer than `forceLlmAbove` items, skip the LLM and just concatenate.
   * Default: 800.
   */
  skipLlmBelowTokens?: number;

  /**
   * Force LLM summarization when there are this many or more descriptions,
   * even if they fit within skipLlmBelowTokens.
   * Default: 4.
   */
  forceLlmAbove?: number;

  /** Separator used when concatenating without LLM. Default: "\n" */
  separator?: string;

  /** LLM temperature for summarization calls. Default: 0.3 */
  temperature?: number;

  /** Max output tokens for LLM response. Default: 600 */
  maxOutputTokens?: number;

  /**
   * Optional system prompt override. Receives `{subject}` placeholder.
   * Default provides a concise Spanish business summary prompt.
   */
  systemPrompt?: string;

  /** Language hint for the LLM. Default: "español" */
  language?: string;
}

export interface SummaryResult {
  /** The final summarized text. */
  text: string;
  /** Whether the LLM was invoked (at least once). */
  llmUsed: boolean;
  /** Number of LLM calls made during the entire reduce pipeline. */
  llmCalls: number;
  /** Total tokens consumed across all LLM calls (prompt + completion). */
  totalTokensUsed: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: Required<Omit<SummarizerConfig, "systemPrompt">> & {
  systemPrompt: string;
} = {
  contextWindowTokens: 3000,
  skipLlmBelowTokens: 800,
  forceLlmAbove: 4,
  separator: "\n",
  temperature: 0.3,
  maxOutputTokens: 600,
  language: "español",
  systemPrompt: `Eres un analista comercial. Sintetiza las siguientes descripciones sobre "{subject}" en un resumen conciso y coherente en {language}. Conserva todos los datos clave (montos, fechas, nombres, métricas). No inventes información. Responde SOLO con el resumen, sin encabezados ni viñetas.`,
};

// ---------------------------------------------------------------------------
// Core: map-reduce summarize
// ---------------------------------------------------------------------------

/**
 * Summarize a list of text descriptions into a single coherent summary.
 *
 * Strategy (adapted from LightRAG):
 * 1. Empty/single → return as-is (no LLM).
 * 2. Few items + small total tokens → concatenate (no LLM).
 * 3. Fits in one context window → single LLM call.
 * 4. Too large → chunk into groups → summarize each → recursive reduce.
 */
export async function mapReduceSummarize(
  descriptions: string[],
  subject: string,
  config?: SummarizerConfig,
): Promise<SummaryResult> {
  const cfg = { ...DEFAULTS, ...config };
  const result: SummaryResult = {
    text: "",
    llmUsed: false,
    llmCalls: 0,
    totalTokensUsed: 0,
  };

  // --- Short-circuit: empty or single ---
  if (descriptions.length === 0) return result;
  if (descriptions.length === 1) {
    result.text = descriptions[0];
    return result;
  }

  let current = [...descriptions];

  // --- Iterative map-reduce loop ---
  while (true) {
    const totalTokens = current.reduce((sum, d) => sum + estimateTokens(d), 0);

    // Can we skip LLM entirely? (small enough + few enough items)
    if (
      totalTokens <= cfg.skipLlmBelowTokens &&
      current.length < cfg.forceLlmAbove
    ) {
      result.text = current.join(cfg.separator);
      return result;
    }

    // Fits in one context window → single LLM summarization
    if (totalTokens <= cfg.contextWindowTokens) {
      const summary = await _summarizeChunk(current, subject, cfg, result);
      result.text = summary;
      return result;
    }

    // Too large — split into chunks and reduce
    const chunks = _splitIntoChunks(current, cfg.contextWindowTokens);

    logger.info(
      { subject, descriptions: current.length, chunks: chunks.length },
      "map-reduce: splitting into chunks",
    );

    // Reduce: summarize each chunk
    const reduced: string[] = [];
    for (const chunk of chunks) {
      if (chunk.length === 1) {
        // Single-item chunk: no LLM needed
        reduced.push(chunk[0]);
      } else {
        const summary = await _summarizeChunk(chunk, subject, cfg, result);
        reduced.push(summary);
      }
    }

    // If reduce didn't make progress (stuck at same size), force final merge
    if (reduced.length >= current.length) {
      logger.warn(
        { subject, before: current.length, after: reduced.length },
        "map-reduce: no progress, forcing final merge",
      );
      const summary = await _summarizeChunk(
        reduced.slice(0, 2),
        subject,
        cfg,
        result,
      );
      reduced.splice(0, 2, summary);
    }

    current = reduced;

    // Converged to single result
    if (current.length === 1) {
      result.text = current[0];
      return result;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Split descriptions into groups that fit within the token budget.
 * Guarantees each chunk has at least 2 items (when possible) to ensure
 * the reduce phase always makes progress.
 */
function _splitIntoChunks(
  descriptions: string[],
  maxTokens: number,
): string[][] {
  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentTokens = 0;

  for (const desc of descriptions) {
    const descTokens = estimateTokens(desc);

    if (currentTokens + descTokens > maxTokens && currentChunk.length > 0) {
      if (currentChunk.length === 1) {
        // Force at least 2 per chunk to guarantee progress
        currentChunk.push(desc);
        chunks.push(currentChunk);
        currentChunk = [];
        currentTokens = 0;
      } else {
        chunks.push(currentChunk);
        currentChunk = [desc];
        currentTokens = descTokens;
      }
    } else {
      currentChunk.push(desc);
      currentTokens += descTokens;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Summarize a single chunk of descriptions via one LLM call.
 * Mutates the `tracking` object to record usage stats.
 */
async function _summarizeChunk(
  descriptions: string[],
  subject: string,
  cfg: Required<Omit<SummarizerConfig, "systemPrompt">> & {
    systemPrompt: string;
  },
  tracking: SummaryResult,
): Promise<string> {
  const systemPrompt = cfg.systemPrompt
    .replace("{subject}", subject)
    .replace("{language}", cfg.language);

  const userContent = descriptions
    .map((d, i) => `[${i + 1}] ${d}`)
    .join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  try {
    const response = await infer({
      messages,
      temperature: cfg.temperature,
      max_tokens: cfg.maxOutputTokens,
    });

    tracking.llmUsed = true;
    tracking.llmCalls += 1;
    tracking.totalTokensUsed += response.usage?.total_tokens ?? 0;

    const text = (response.content ?? "").trim();
    if (!text) {
      logger.warn(
        { subject },
        "map-reduce: LLM returned empty, falling back to concat",
      );
      return descriptions.join(cfg.separator);
    }
    return text;
  } catch (err) {
    logger.error(
      { err, subject },
      "map-reduce: LLM call failed, falling back to concat",
    );
    return descriptions.join(cfg.separator);
  }
}
