import { describe, it, expect } from "vitest";
import {
  createDoomLoopState,
  updateDoomLoop,
  detectContentChanting,
  detectFingerprint,
  detectCycle,
  detectTextStalled,
  jaccardSimilarity,
  fnv1a,
  canonicalize,
  fingerprintCalls,
} from "../src/doom-loop.js";

describe("doom-loop detection", () => {
  describe("fnv1a", () => {
    it("produces consistent hashes", () => {
      expect(fnv1a("hello")).toBe(fnv1a("hello"));
    });

    it("produces different hashes for different strings", () => {
      expect(fnv1a("hello")).not.toBe(fnv1a("world"));
    });
  });

  describe("canonicalize", () => {
    it("sorts object keys", () => {
      expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });

    it("handles nested objects", () => {
      const result = canonicalize({ z: { b: 1, a: 2 }, a: 3 });
      expect(result).toBe('{"a":3,"z":{"a":2,"b":1}}');
    });

    it("handles arrays", () => {
      expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    });

    it("handles null/undefined", () => {
      expect(canonicalize(null)).toBe("null");
      expect(canonicalize(undefined)).toBe("null");
    });
  });

  describe("fingerprintCalls", () => {
    it("produces same fingerprint for same calls regardless of order", () => {
      const calls1 = [
        { function: { name: "a", arguments: '{"x":1}' } },
        { function: { name: "b", arguments: '{"y":2}' } },
      ];
      const calls2 = [
        { function: { name: "b", arguments: '{"y":2}' } },
        { function: { name: "a", arguments: '{"x":1}' } },
      ];
      expect(fingerprintCalls(calls1)).toBe(fingerprintCalls(calls2));
    });

    it("produces different fingerprint for different args", () => {
      const calls1 = [{ function: { name: "a", arguments: '{"x":1}' } }];
      const calls2 = [{ function: { name: "a", arguments: '{"x":2}' } }];
      expect(fingerprintCalls(calls1)).not.toBe(fingerprintCalls(calls2));
    });
  });

  describe("Layer 0: content chanting", () => {
    it("returns null for short text", () => {
      const state = createDoomLoopState();
      expect(detectContentChanting(state, "short", 200, 3)).toBeNull();
    });

    it("detects repeated chunks", () => {
      const state = createDoomLoopState();
      const chunk = "A".repeat(200);
      // Feed same chunk multiple times
      detectContentChanting(state, chunk, 200, 3);
      detectContentChanting(state, chunk, 200, 3);
      const signal = detectContentChanting(state, chunk, 200, 3);
      expect(signal).not.toBeNull();
      expect(signal!.layer).toBe(0);
      expect(signal!.severity).toBe("high");
    });

    it("does not fire for varied content", () => {
      const state = createDoomLoopState();
      for (let i = 0; i < 5; i++) {
        const text = `Unique content chunk number ${i} `.repeat(20);
        const signal = detectContentChanting(state, text, 200, 3);
        expect(signal).toBeNull();
      }
    });
  });

  describe("Layer 1: fingerprint", () => {
    it("detects identical call+result pairs", () => {
      const state = createDoomLoopState();
      const calls = [{ function: { name: "foo", arguments: '{"a":1}' } }];
      const results = [{ content: "same result" }];

      detectFingerprint(state, calls, results, 3);
      detectFingerprint(state, calls, results, 3);
      const { signal } = detectFingerprint(state, calls, results, 3);
      expect(signal).not.toBeNull();
      expect(signal!.layer).toBe(1);
    });

    it("does not fire for different results", () => {
      const state = createDoomLoopState();
      const calls = [{ function: { name: "foo", arguments: '{"a":1}' } }];

      for (let i = 0; i < 5; i++) {
        const { signal } = detectFingerprint(
          state,
          calls,
          [{ content: `result ${i}` }],
          3,
        );
        expect(signal).toBeNull();
      }
    });
  });

  describe("Layer 2: cycle detection", () => {
    it("detects period-2 cycles (A-B-A-B)", () => {
      const state = createDoomLoopState();
      detectCycle(state, "A");
      detectCycle(state, "B");
      detectCycle(state, "A");
      const signal = detectCycle(state, "B");
      expect(signal).not.toBeNull();
      expect(signal!.layer).toBe(2);
      expect(signal!.description).toContain("period-2");
    });

    it("detects period-3 cycles", () => {
      const state = createDoomLoopState();
      detectCycle(state, "A");
      detectCycle(state, "B");
      detectCycle(state, "C");
      detectCycle(state, "A");
      detectCycle(state, "B");
      const signal = detectCycle(state, "C");
      expect(signal).not.toBeNull();
      expect(signal!.description).toContain("period-3");
    });

    it("does not fire for non-repeating sequences", () => {
      const state = createDoomLoopState();
      for (let i = 0; i < 10; i++) {
        const signal = detectCycle(state, String(i));
        expect(signal).toBeNull();
      }
    });
  });

  describe("Layer 3: Jaccard similarity", () => {
    it("computes Jaccard correctly for identical strings", () => {
      expect(jaccardSimilarity("hello world", "hello world")).toBe(1);
    });

    it("computes Jaccard correctly for different strings", () => {
      const sim = jaccardSimilarity("abcdefgh", "xyzwvuts");
      expect(sim).toBeLessThan(0.2);
    });

    it("detects stalled text responses", () => {
      const state = createDoomLoopState();
      const text =
        "The pipeline shows 5 active proposals totaling $500K in estimated value.";
      // Need window=3 identical texts
      detectTextStalled(state, text, 3, 0.85);
      detectTextStalled(state, text, 3, 0.85);
      const signal = detectTextStalled(state, text, 3, 0.85);
      expect(signal).not.toBeNull();
      expect(signal!.layer).toBe(3);
    });

    it("does not fire for varied responses", () => {
      const state = createDoomLoopState();
      const texts = [
        "First response about sales pipeline and quota tracking for Q2.",
        "Second response covering client meetings and follow-up actions.",
        "Third response with cross-sell recommendations for key accounts.",
      ];
      for (const text of texts) {
        const signal = detectTextStalled(state, text, 3, 0.85);
        expect(signal).toBeNull();
      }
    });

    it("skips very short texts", () => {
      const state = createDoomLoopState();
      for (let i = 0; i < 5; i++) {
        expect(detectTextStalled(state, "ok", 3, 0.85)).toBeNull();
      }
    });
  });

  describe("updateDoomLoop (integration)", () => {
    it("returns null for normal round", () => {
      const state = createDoomLoopState();
      const signal = updateDoomLoop(state, {
        toolCalls: [
          {
            function: {
              name: "consultar_pipeline",
              arguments: '{"ae_id":"1"}',
            },
          },
        ],
        toolResults: [{ content: '{"propuestas":[]}' }],
        llmText: "No hay propuestas activas en tu pipeline.",
      });
      expect(signal).toBeNull();
    });

    it("detects doom loop after repeated identical rounds", () => {
      const state = createDoomLoopState();
      const round = {
        toolCalls: [
          {
            function: {
              name: "consultar_pipeline",
              arguments: '{"ae_id":"1"}',
            },
          },
        ],
        toolResults: [{ content: '{"propuestas":[]}' }],
        llmText: "",
      };

      let signal = null;
      for (let i = 0; i < 5; i++) {
        signal = updateDoomLoop(state, round);
        if (signal) break;
      }
      expect(signal).not.toBeNull();
    });
  });
});
