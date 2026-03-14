/**
 * Circuit Breaker Tests
 *
 * Unit tests for CircuitBreaker class + integration tests for
 * inference-adapter and embedding module breaker behavior.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";

// Mock logger to prevent console noise
vi.mock("../src/logger.js", () => {
  const noop = () => {};
  const child = () => ({
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child,
  });
  return {
    logger: { info: noop, warn: noop, error: noop, debug: noop, child },
  };
});

// ---------------------------------------------------------------------------
// Unit tests: CircuitBreaker class
// ---------------------------------------------------------------------------

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      name: "test",
      failureThreshold: 3,
      cooldownMs: 60000,
    });
  });

  it("starts closed", () => {
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.getState().failures).toBe(0);
    expect(breaker.getState().open).toBe(false);
  });

  it("stays closed after fewer than threshold failures", () => {
    breaker.recordFailure(new Error("err1"));
    breaker.recordFailure(new Error("err2"));
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.getState().failures).toBe(2);
  });

  it("opens after threshold failures", () => {
    breaker.recordFailure(new Error("err1"));
    breaker.recordFailure(new Error("err2"));
    breaker.recordFailure(new Error("err3"));
    expect(breaker.getState().open).toBe(true);
    expect(breaker.isOpen()).toBe(true);
  });

  it("half-opens after cooldown", () => {
    vi.useFakeTimers();
    try {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.isOpen()).toBe(true);

      vi.advanceTimersByTime(60001);
      // isOpen() should return false (half-open) and reset failures
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.getState().failures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes on success after half-open", () => {
    vi.useFakeTimers();
    try {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      vi.advanceTimersByTime(60001);
      breaker.isOpen(); // triggers half-open
      breaker.recordSuccess();

      expect(breaker.isOpen()).toBe(false);
      expect(breaker.getState().failures).toBe(0);
      expect(breaker.getState().open).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("success resets failure count (not cumulative across resets)", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    // Only 2 failures since last success — should NOT open
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.getState().failures).toBe(2);
  });

  it("respects custom threshold and cooldown", () => {
    const custom = new CircuitBreaker({
      name: "custom",
      failureThreshold: 5,
      cooldownMs: 10000,
    });
    for (let i = 0; i < 4; i++) custom.recordFailure();
    expect(custom.isOpen()).toBe(false);
    custom.recordFailure();
    expect(custom.getState().open).toBe(true);

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(10001);
      expect(custom.isOpen()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset() clears state", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);

    breaker.reset();
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.getState().failures).toBe(0);
    expect(breaker.getState().open).toBe(false);
  });

  it("records failure with various error types", () => {
    breaker.recordFailure(new Error("network error"));
    expect(breaker.getState().failures).toBe(1);

    breaker.recordFailure("string error");
    expect(breaker.getState().failures).toBe(2);

    breaker.recordFailure(); // undefined
    expect(breaker.getState().failures).toBe(3);
    expect(breaker.getState().open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: inference adapter circuit breaker
// ---------------------------------------------------------------------------

describe("inference adapter circuit breaker", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.stubEnv("INFERENCE_PRIMARY_URL", "http://primary.test/v1");
    vi.stubEnv("INFERENCE_PRIMARY_KEY", "pk");
    vi.stubEnv("INFERENCE_PRIMARY_MODEL", "test-model");
    vi.stubEnv("INFERENCE_FALLBACK_URL", "http://fallback.test/v1");
    vi.stubEnv("INFERENCE_FALLBACK_KEY", "fk");
    vi.stubEnv("INFERENCE_FALLBACK_MODEL", "fallback-model");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("skips open provider and uses fallback", async () => {
    const { infer, _resetProviderBreakers } =
      await import("../src/inference-adapter.js");
    _resetProviderBreakers();

    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      urls.push(urlStr);
      if (urlStr.includes("primary")) {
        // Use non-retryable error (no HTTP status) to avoid retry backoff delays
        throw new Error("ECONNREFUSED: connection refused");
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    // 3 calls to trip the primary breaker (each exhausts retries internally)
    for (let i = 0; i < 3; i++) {
      const result = await infer({
        messages: [{ role: "user", content: "test" }],
      });
      expect(result.content).toBe("ok");
    }

    // Clear URL tracking
    urls.length = 0;

    // 4th call should skip primary entirely
    const result = await infer({
      messages: [{ role: "user", content: "test" }],
    });
    expect(result.content).toBe("ok");

    // Verify primary was NOT called
    const primaryCalls = urls.filter((u) => u.includes("primary"));
    expect(primaryCalls).toHaveLength(0);

    // Verify fallback was called
    const fallbackCalls = urls.filter((u) => u.includes("fallback"));
    expect(fallbackCalls.length).toBeGreaterThan(0);

    _resetProviderBreakers();
  });
});

// ---------------------------------------------------------------------------
// Integration: embedding circuit breaker
// ---------------------------------------------------------------------------

describe("embedding circuit breaker", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.stubEnv("INFERENCE_PRIMARY_URL", "http://embed.test/v1");
    vi.stubEnv("INFERENCE_PRIMARY_KEY", "ek");
    vi.stubEnv("EMBEDDING_MODEL", "test-embed");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("skips to local fallback when circuit is open", async () => {
    const { embedBatch, _resetEmbeddingBreaker, EMBEDDING_DIMS } =
      await import("../src/embedding.js");
    _resetEmbeddingBreaker();

    let fetchCallCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCallCount++;
      throw new Error("Embedding API 503: unavailable");
    }) as typeof globalThis.fetch;

    // 3 calls to trip the breaker
    for (let i = 0; i < 3; i++) {
      const result = await embedBatch(["test text"]);
      expect(result[0]).toBeInstanceOf(Float32Array);
      expect(result[0].length).toBe(EMBEDDING_DIMS);
    }
    expect(fetchCallCount).toBe(3);

    // Reset count — next call should NOT hit fetch
    fetchCallCount = 0;
    const result = await embedBatch(["another text"]);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(fetchCallCount).toBe(0);

    _resetEmbeddingBreaker();
  });

  it("fast-forwards remaining batches when breaker opens mid-batch", async () => {
    const { embedBatch, _resetEmbeddingBreaker, EMBEDDING_DIMS } =
      await import("../src/embedding.js");
    _resetEmbeddingBreaker();

    let fetchCallCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCallCount++;
      throw new Error("Embedding API 500: error");
    }) as typeof globalThis.fetch;

    // 40 texts = 4 batches of 10. Breaker opens after 3rd batch failure.
    const texts = Array.from({ length: 40 }, (_, i) => `text ${i}`);
    const results = await embedBatch(texts);

    // All 40 results should be present (local fallback)
    expect(results.length).toBe(40);
    for (const r of results) {
      expect(r).toBeInstanceOf(Float32Array);
      expect(r.length).toBe(EMBEDDING_DIMS);
    }

    // Only 3 fetch calls (4th batch was fast-forwarded)
    expect(fetchCallCount).toBe(3);

    _resetEmbeddingBreaker();
  });
});
