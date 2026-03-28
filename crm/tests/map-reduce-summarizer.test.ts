/**
 * Map-Reduce Summarizer Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock inference adapter before importing the module under test
const mockInfer = vi.fn();
vi.mock("../src/inference-adapter.js", () => ({
  infer: (...args: unknown[]) => mockInfer(...args),
}));

const noop = () => {};
const noopLogger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  fatal: noop,
  child: () => noopLogger,
};
vi.mock("../src/logger.js", () => ({
  logger: noopLogger,
}));

const { mapReduceSummarize, estimateTokens } =
  await import("../src/analysis/map-reduce-summarizer.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLlmResponse(content: string, totalTokens = 100) {
  return {
    content,
    tool_calls: undefined,
    usage: {
      prompt_tokens: totalTokens - 30,
      completion_tokens: 30,
      total_tokens: totalTokens,
    },
    provider: "test",
    latency_ms: 50,
  };
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("approximates ~1 token per 4 chars", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// mapReduceSummarize
// ---------------------------------------------------------------------------

describe("mapReduceSummarize", () => {
  beforeEach(() => {
    mockInfer.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Short-circuit paths ---

  it("returns empty for empty input", async () => {
    const result = await mapReduceSummarize([], "test");
    expect(result.text).toBe("");
    expect(result.llmUsed).toBe(false);
    expect(result.llmCalls).toBe(0);
  });

  it("returns single description as-is without LLM", async () => {
    const result = await mapReduceSummarize(["Solo una descripción"], "test");
    expect(result.text).toBe("Solo una descripción");
    expect(result.llmUsed).toBe(false);
  });

  // --- Concatenation path (small + few) ---

  it("concatenates without LLM when below token and count thresholds", async () => {
    const descriptions = ["Dato uno.", "Dato dos.", "Dato tres."];
    const result = await mapReduceSummarize(descriptions, "Acme Corp", {
      skipLlmBelowTokens: 800,
      forceLlmAbove: 4,
    });
    expect(result.text).toBe("Dato uno.\nDato dos.\nDato tres.");
    expect(result.llmUsed).toBe(false);
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("uses custom separator when concatenating", async () => {
    const descriptions = ["A", "B"];
    const result = await mapReduceSummarize(descriptions, "test", {
      separator: " | ",
      skipLlmBelowTokens: 800,
      forceLlmAbove: 4,
    });
    expect(result.text).toBe("A | B");
  });

  // --- Single LLM call path ---

  it("calls LLM once when items exceed forceLlmAbove but fit in context window", async () => {
    mockInfer.mockResolvedValueOnce(
      makeLlmResponse("Resumen: cuatro fuentes combinadas."),
    );

    const descriptions = ["Info A.", "Info B.", "Info C.", "Info D."];
    const result = await mapReduceSummarize(descriptions, "Acme Corp", {
      forceLlmAbove: 4,
      skipLlmBelowTokens: 10, // force LLM by making this very low
      contextWindowTokens: 5000,
    });

    expect(result.llmUsed).toBe(true);
    expect(result.llmCalls).toBe(1);
    expect(result.text).toBe("Resumen: cuatro fuentes combinadas.");
    expect(mockInfer).toHaveBeenCalledTimes(1);

    // Verify system prompt contains subject
    const call = mockInfer.mock.calls[0][0];
    expect(call.messages[0].content).toContain("Acme Corp");
    // Verify user content has numbered items
    expect(call.messages[1].content).toContain("[1]");
    expect(call.messages[1].content).toContain("[4]");
  });

  it("calls LLM when tokens exceed skipLlmBelowTokens even with few items", async () => {
    mockInfer.mockResolvedValueOnce(makeLlmResponse("Resumen compacto."));

    const longText = "X".repeat(2000); // ~500 tokens
    const descriptions = [longText, longText]; // ~1000 tokens total
    const result = await mapReduceSummarize(descriptions, "test", {
      skipLlmBelowTokens: 400, // total exceeds this
      forceLlmAbove: 10,
      contextWindowTokens: 5000,
    });

    expect(result.llmUsed).toBe(true);
    expect(result.llmCalls).toBe(1);
  });

  // --- Map-reduce path ---

  it("chunks and reduces when total exceeds context window", async () => {
    // Each description ~750 tokens. 4 of them = ~3000 tokens.
    // With contextWindowTokens=1600, need 2 chunks of 2, then 1 final merge.
    const desc = "Y".repeat(3000); // ~750 tokens
    const descriptions = [desc, desc, desc, desc];

    mockInfer
      .mockResolvedValueOnce(makeLlmResponse("Chunk 1 summary"))
      .mockResolvedValueOnce(makeLlmResponse("Chunk 2 summary"))
      .mockResolvedValueOnce(makeLlmResponse("Final merged summary"));

    const result = await mapReduceSummarize(descriptions, "BigAccount", {
      contextWindowTokens: 1600,
      skipLlmBelowTokens: 100,
      forceLlmAbove: 2,
    });

    expect(result.llmUsed).toBe(true);
    // 2 chunk summaries + 1 final merge = 3 calls
    expect(result.llmCalls).toBe(3);
    expect(result.text).toBe("Final merged summary");
    expect(result.totalTokensUsed).toBe(300); // 3 * 100
  });

  // --- Graceful degradation ---

  it("falls back to concat when LLM fails", async () => {
    mockInfer.mockRejectedValueOnce(new Error("LLM timeout"));

    const descriptions = ["A", "B", "C", "D"];
    const result = await mapReduceSummarize(descriptions, "test", {
      skipLlmBelowTokens: 0,
      forceLlmAbove: 2,
      contextWindowTokens: 5000,
    });

    expect(result.text).toBe("A\nB\nC\nD");
    expect(result.llmUsed).toBe(false); // tracking doesn't mark on failure
  });

  it("falls back to concat when LLM returns empty", async () => {
    mockInfer.mockResolvedValueOnce(makeLlmResponse("", 50));

    const descriptions = ["X", "Y", "Z", "W"];
    const result = await mapReduceSummarize(descriptions, "test", {
      skipLlmBelowTokens: 0,
      forceLlmAbove: 2,
      contextWindowTokens: 5000,
    });

    expect(result.text).toBe("X\nY\nZ\nW");
  });

  // --- Token tracking ---

  it("accumulates token usage across multiple LLM calls", async () => {
    const desc = "Z".repeat(2000);
    const descriptions = [desc, desc, desc];

    mockInfer
      .mockResolvedValueOnce(makeLlmResponse("S1", 200))
      .mockResolvedValueOnce(makeLlmResponse("Final", 150));

    const result = await mapReduceSummarize(descriptions, "test", {
      contextWindowTokens: 1200,
      skipLlmBelowTokens: 100,
      forceLlmAbove: 2,
    });

    expect(result.totalTokensUsed).toBe(350);
    expect(result.llmCalls).toBe(2);
  });

  // --- Config: language and system prompt ---

  it("passes language to system prompt", async () => {
    mockInfer.mockResolvedValueOnce(makeLlmResponse("English summary"));

    await mapReduceSummarize(["A", "B", "C", "D"], "test", {
      language: "English",
      skipLlmBelowTokens: 0,
      forceLlmAbove: 2,
      contextWindowTokens: 5000,
    });

    const sysPrompt = mockInfer.mock.calls[0][0].messages[0].content;
    expect(sysPrompt).toContain("English");
  });

  it("supports custom system prompt with placeholders", async () => {
    mockInfer.mockResolvedValueOnce(makeLlmResponse("Custom result"));

    await mapReduceSummarize(["A", "B", "C", "D"], "MiCuenta", {
      systemPrompt: "Summarize data about {subject} in {language}.",
      language: "español",
      skipLlmBelowTokens: 0,
      forceLlmAbove: 2,
      contextWindowTokens: 5000,
    });

    const sysPrompt = mockInfer.mock.calls[0][0].messages[0].content;
    expect(sysPrompt).toBe("Summarize data about MiCuenta in español.");
  });
});

// ---------------------------------------------------------------------------
// _splitIntoChunks (tested indirectly via mapReduceSummarize)
// ---------------------------------------------------------------------------

describe("chunking behavior", () => {
  beforeEach(() => {
    mockInfer.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ensures minimum 2 items per chunk for progress guarantee", async () => {
    // One very large item (~1000 tokens) + one small = should be forced into same chunk
    const large = "A".repeat(4000); // ~1000 tokens
    const small = "B".repeat(40); // ~10 tokens
    const descriptions = [large, small, "C".repeat(40), "D".repeat(40)];

    mockInfer
      .mockResolvedValueOnce(makeLlmResponse("Chunk1"))
      .mockResolvedValueOnce(makeLlmResponse("Final"));

    const result = await mapReduceSummarize(descriptions, "test", {
      contextWindowTokens: 600,
      skipLlmBelowTokens: 0,
      forceLlmAbove: 2,
    });

    // Should not hang — must converge
    expect(result.text).toBeTruthy();
    expect(result.llmUsed).toBe(true);
  });
});
