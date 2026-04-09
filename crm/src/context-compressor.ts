/**
 * Context Compressor — deterministic compression for long conversations.
 *
 * Two levels (no LLM calls required):
 * L0: Truncate old tool results (keep first 200 chars, mark truncated)
 * L1: Pair-drain — remove oldest assistant+tool_calls + matching tool results
 *
 * Ported from mission-control's context-compressor.ts (L0-L1 only).
 * L2 (LLM summary) and L3 (emergency) are omitted — CRM agents run in
 * containers with short sessions, so deterministic levels suffice.
 */

import type { ChatMessage } from "./inference-adapter.js";

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Rough token estimate: chars / 4. */
export function estimateTokens(messages: ChatMessage[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      totalChars += JSON.stringify(msg.content).length;
    }
    if (msg.tool_calls) {
      totalChars += JSON.stringify(msg.tool_calls).length;
    }
  }
  return Math.ceil(totalChars / 4);
}

/**
 * Returns true if estimated tokens exceed threshold fraction of contextLimit.
 */
export function shouldCompress(
  messages: ChatMessage[],
  contextLimit: number,
  threshold = 0.8,
): boolean {
  return estimateTokens(messages) > contextLimit * threshold;
}

// ---------------------------------------------------------------------------
// L0: Truncate old tool results
// ---------------------------------------------------------------------------

/**
 * Truncate tool results older than the last `recentRounds` rounds.
 * Keeps first 200 chars of each old tool result to preserve structure.
 * Operates in-place on the array.
 */
export function truncateOldToolResults(
  messages: ChatMessage[],
  recentRounds = 6,
  maxChars = 200,
): number {
  // Find the index where "recent" messages begin (last N assistant messages)
  let assistantCount = 0;
  let recentStart = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      assistantCount++;
      if (assistantCount >= recentRounds) {
        recentStart = i;
        break;
      }
    }
  }

  let truncated = 0;
  for (let i = 0; i < recentStart; i++) {
    const msg = messages[i];
    if (
      msg.role === "tool" &&
      typeof msg.content === "string" &&
      msg.content.length > maxChars
    ) {
      msg.content =
        msg.content.slice(0, maxChars) +
        `\n... [truncated from ${msg.content.length} chars]`;
      truncated++;
    }
  }

  return truncated;
}

// ---------------------------------------------------------------------------
// L1: Pair drain — remove oldest tool exchange pairs
// ---------------------------------------------------------------------------

/**
 * Remove the oldest assistant+tool_calls message and its matching tool results.
 * Protects the first `keepHead` messages (system prompts) and last `keepTail`.
 * Returns the number of messages removed.
 */
export function pairDrain(
  messages: ChatMessage[],
  keepHead = 2,
  keepTail = 6,
): number {
  const total = messages.length;
  if (total <= keepHead + keepTail) return 0;

  // Find the first assistant message with tool_calls in the drainable zone
  const drainEnd = total - keepTail;
  for (let i = keepHead; i < drainEnd; i++) {
    const msg = messages[i];
    if (
      msg.role === "assistant" &&
      msg.tool_calls &&
      msg.tool_calls.length > 0
    ) {
      // Collect IDs of tool calls to remove
      const callIds = new Set(msg.tool_calls.map((tc) => tc.id));
      // Find and remove matching tool results (they follow the assistant message)
      const indicesToRemove = new Set<number>();
      indicesToRemove.add(i);
      for (let j = i + 1; j < drainEnd; j++) {
        const m = messages[j];
        if (
          m.role === "tool" &&
          m.tool_call_id &&
          callIds.has(m.tool_call_id)
        ) {
          indicesToRemove.add(j);
          callIds.delete(m.tool_call_id);
        }
        if (callIds.size === 0) break;
      }
      // Remove in reverse order to maintain indices
      const sorted = Array.from(indicesToRemove).sort((a, b) => b - a);
      for (const idx of sorted) {
        messages.splice(idx, 1);
      }
      return sorted.length;
    }
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Sanitize tool pairs (orphan cleanup after compression)
// ---------------------------------------------------------------------------

/**
 * Remove orphaned tool results (whose assistant tool_call was removed)
 * and insert stubs for orphaned tool_calls (whose results were removed).
 */
export function sanitizeToolPairs(messages: ChatMessage[]): number {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) callIds.add(tc.id);
    }
    if (msg.role === "tool" && msg.tool_call_id) {
      resultIds.add(msg.tool_call_id);
    }
  }

  let removed = 0;

  // Remove orphaned tool results
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.role === "tool" &&
      msg.tool_call_id &&
      !callIds.has(msg.tool_call_id)
    ) {
      messages.splice(i, 1);
      removed++;
    }
  }

  // Insert stubs for unmatched tool calls
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (!resultIds.has(tc.id)) {
          messages.splice(i + 1, 0, {
            role: "tool",
            content: "[Result compressed]",
            tool_call_id: tc.id,
          });
          removed--; // net accounting
        }
      }
    }
  }

  return removed;
}

// ---------------------------------------------------------------------------
// Public API: apply compression levels
// ---------------------------------------------------------------------------

/**
 * Apply deterministic compression to conversation messages.
 * Applies L0 first, then L1 if still over budget. Repeats L1 up to 5x.
 * Returns the number of changes made.
 */
export function compressContext(
  messages: ChatMessage[],
  contextLimit: number,
  threshold = 0.8,
): { changes: number; level: "none" | "L0" | "L1" } {
  if (!shouldCompress(messages, contextLimit, threshold)) {
    return { changes: 0, level: "none" };
  }

  // L0: Truncate old tool results
  const l0 = truncateOldToolResults(messages);
  if (!shouldCompress(messages, contextLimit, threshold)) {
    return { changes: l0, level: "L0" };
  }

  // L1: Pair drain (repeat up to 5x)
  let l1Total = 0;
  for (let i = 0; i < 5; i++) {
    const drained = pairDrain(messages);
    if (drained === 0) break;
    l1Total += drained;
    sanitizeToolPairs(messages);
    if (!shouldCompress(messages, contextLimit, threshold)) break;
  }

  return { changes: l0 + l1Total, level: l1Total > 0 ? "L1" : "L0" };
}
