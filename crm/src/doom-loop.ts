/**
 * Multi-layer doom-loop detection — 4 layers of progressively expensive checks.
 *
 * Layer 0: Content-chanting (sliding window hash on LLM text)
 * Layer 1: Canonical JSON fingerprint + outcome-aware tracking
 * Layer 2: Ping-pong cycle detection (period 2-3)
 * Layer 3: N-gram Jaccard similarity on text responses
 *
 * Ported from mission-control's doom-loop.ts. All pure functions, no side effects.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANTING_CHUNK = 200;
// Threshold of 2: a single repeat is the loop. The previous value of 3
// burned an extra round before flagging — long enough for one more bad
// LLM call, plus tool execution, before we noticed.
const CHANTING_THRESHOLD = 2;
const FINGERPRINT_THRESHOLD = 2;
const JACCARD_THRESHOLD = 0.85;
const JACCARD_WINDOW = 3;
const CYCLE_HISTORY = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DoomLoopState {
  /** Layer 0: sliding window of text chunk hashes. */
  textHashes: Map<number, number>;
  /** Layer 1: (callHash:resultHash) → occurrence count. */
  callResultPairs: Map<string, number>;
  /** Layer 2: recent canonical call signatures for cycle detection. */
  signatureHistory: string[];
  /** Layer 3: recent LLM text responses for Jaccard comparison. */
  recentTexts: string[];
}

export interface DoomLoopSignal {
  layer: 0 | 1 | 2 | 3;
  severity: "low" | "medium" | "high";
  description: string;
}

export interface RoundData {
  toolCalls: Array<{
    function: { name: string; arguments: string };
  }>;
  toolResults: Array<{ content: string | unknown }>;
  llmText: string;
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

export function createDoomLoopState(): DoomLoopState {
  return {
    textHashes: new Map(),
    callResultPairs: new Map(),
    signatureHistory: [],
    recentTexts: [],
  };
}

// ---------------------------------------------------------------------------
// Hash utility (FNV-1a 32-bit — fast, no deps)
// ---------------------------------------------------------------------------

export function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Layer 0: Content chanting
// ---------------------------------------------------------------------------

export function detectContentChanting(
  state: DoomLoopState,
  text: string,
  chunkSize = CHANTING_CHUNK,
  threshold = CHANTING_THRESHOLD,
): DoomLoopSignal | null {
  if (text.length < chunkSize) return null;

  for (let i = 0; i <= text.length - chunkSize; i += chunkSize) {
    const h = fnv1a(text.slice(i, i + chunkSize));
    const prev = state.textHashes.get(h) ?? 0;
    // Delete + re-set so existing keys move to insertion-order tail; the
    // first key is then truly the least-recently-used.
    if (prev > 0) state.textHashes.delete(h);
    state.textHashes.set(h, prev + 1);
    if (state.textHashes.size > 500) {
      const first = state.textHashes.keys().next().value;
      if (first !== undefined) state.textHashes.delete(first);
    }
    const count = prev + 1;
    if (count >= threshold) {
      return {
        layer: 0,
        severity: "high",
        description: `Content chanting: text chunk repeated ${count}x`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer 1: Canonical JSON fingerprint + outcome-aware
// ---------------------------------------------------------------------------

export function canonicalize(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalize).join(",") + "]";
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  return (
    "{" +
    sorted
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonicalize((obj as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

export function fingerprintCalls(
  toolCalls: Array<{ function: { name: string; arguments: string } }>,
): string {
  const parts = toolCalls
    .map((tc) => {
      let args: unknown;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = tc.function.arguments;
      }
      return `${tc.function.name}:${canonicalize(args)}`;
    })
    .sort();
  return String(fnv1a(parts.join("|")));
}

function fingerprintResults(
  results: Array<{ content: string | unknown }>,
): string {
  const parts = results
    .map((r) => (typeof r.content === "string" ? r.content.slice(0, 500) : ""))
    .join("|");
  return String(fnv1a(parts));
}

export function detectFingerprint(
  state: DoomLoopState,
  toolCalls: RoundData["toolCalls"],
  toolResults: RoundData["toolResults"],
  threshold = FINGERPRINT_THRESHOLD,
): { signal: DoomLoopSignal | null; callSig: string } {
  const callSig = fingerprintCalls(toolCalls);
  const resultSig = fingerprintResults(toolResults);
  const pairKey = `${callSig}:${resultSig}`;

  const prev = state.callResultPairs.get(pairKey) ?? 0;
  // Delete + re-set so existing keys move to insertion-order tail; the first
  // key is then truly the least-recently-used.
  if (prev > 0) state.callResultPairs.delete(pairKey);
  state.callResultPairs.set(pairKey, prev + 1);
  if (state.callResultPairs.size > 200) {
    const first = state.callResultPairs.keys().next().value;
    if (first !== undefined) state.callResultPairs.delete(first);
  }
  const count = prev + 1;

  if (count >= threshold) {
    return {
      signal: {
        layer: 1,
        severity: "medium",
        description: `Identical call+result pair repeated ${count}x`,
      },
      callSig,
    };
  }
  return { signal: null, callSig };
}

// ---------------------------------------------------------------------------
// Layer 2: Ping-pong cycle detection
// ---------------------------------------------------------------------------

export function detectCycle(
  state: DoomLoopState,
  callSig: string,
  maxHistory = CYCLE_HISTORY,
): DoomLoopSignal | null {
  state.signatureHistory.push(callSig);
  if (state.signatureHistory.length > maxHistory) {
    state.signatureHistory.shift();
  }

  const sigs = state.signatureHistory;
  for (let period = 2; period <= 3; period++) {
    if (sigs.length < period * 2) continue;
    const tail = sigs.slice(-period * 2);
    const first = tail.slice(0, period);
    const second = tail.slice(period);
    if (first.every((f, i) => f === second[i])) {
      return {
        layer: 2,
        severity: "high",
        description: `Ping-pong cycle detected: period-${period}`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer 3: N-gram Jaccard similarity
// ---------------------------------------------------------------------------

function ngrams(str: string, n = 3): Set<string> {
  const set = new Set<string>();
  const lower = str.toLowerCase();
  for (let i = 0; i <= lower.length - n; i++) {
    set.add(lower.slice(i, i + n));
  }
  return set;
}

export function jaccardSimilarity(a: string, b: string, n = 3): number {
  const setA = ngrams(a, n);
  const setB = ngrams(b, n);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const g of setA) {
    if (setB.has(g)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

export function detectTextStalled(
  state: DoomLoopState,
  text: string,
  window = JACCARD_WINDOW,
  threshold = JACCARD_THRESHOLD,
): DoomLoopSignal | null {
  if (text.length < 50) return null;

  state.recentTexts.push(text);
  if (state.recentTexts.length > window) {
    state.recentTexts.shift();
  }

  if (state.recentTexts.length < window) return null;

  for (let i = 0; i < state.recentTexts.length; i++) {
    for (let j = i + 1; j < state.recentTexts.length; j++) {
      if (
        jaccardSimilarity(state.recentTexts[i], state.recentTexts[j]) <
        threshold
      ) {
        return null;
      }
    }
  }

  return {
    layer: 3,
    severity: "medium",
    description: `Text stalled: ${window} responses with Jaccard > ${threshold}`,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run all 4 detection layers (cheapest first). Returns the first signal
 * that fires, or null if no doom loop detected.
 */
export function updateDoomLoop(
  state: DoomLoopState,
  round: RoundData,
): DoomLoopSignal | null {
  // Layer 0: content chanting (cheapest)
  if (round.llmText) {
    const chanting = detectContentChanting(state, round.llmText);
    if (chanting) return chanting;
  }

  // Layer 1: canonical fingerprint + outcome-aware
  const { signal: fpSignal, callSig } = detectFingerprint(
    state,
    round.toolCalls,
    round.toolResults,
  );
  if (fpSignal) return fpSignal;

  // Layer 2: ping-pong cycle
  const cycle = detectCycle(state, callSig);
  if (cycle) return cycle;

  // Layer 3: n-gram Jaccard (most expensive)
  if (round.llmText) {
    const stalled = detectTextStalled(state, round.llmText);
    if (stalled) return stalled;
  }

  return null;
}
