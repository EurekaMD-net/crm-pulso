import { describe, it, expect, beforeEach } from "vitest";
import { toolMetrics } from "../src/tool-metrics.js";

beforeEach(() => {
  toolMetrics._reset();
});

describe("tool-metrics", () => {
  it("records and retrieves stats for a tool", () => {
    toolMetrics.record("consultar_pipeline", 150, true);
    toolMetrics.record("consultar_pipeline", 200, true);
    toolMetrics.record("consultar_pipeline", 500, false);

    const stats = toolMetrics.getStats("consultar_pipeline");
    expect(stats).not.toBeNull();
    expect(stats!.calls).toBe(3);
    expect(stats!.successes).toBe(2);
    expect(stats!.failures).toBe(1);
    expect(stats!.avgLatencyMs).toBe(283);
    expect(stats!.lastCalledAt).toBeDefined();
  });

  it("returns null for unknown tool", () => {
    expect(toolMetrics.getStats("nonexistent")).toBeNull();
  });

  it("computes p95 latency", () => {
    for (let i = 0; i < 100; i++) {
      toolMetrics.record("fast_tool", i < 95 ? 100 : 5000, true);
    }
    const stats = toolMetrics.getStats("fast_tool");
    expect(stats!.p95LatencyMs).toBe(5000);
  });

  it("maintains rolling window of 100 entries", () => {
    for (let i = 0; i < 150; i++) {
      toolMetrics.record("many_calls", 100, true);
    }
    const stats = toolMetrics.getStats("many_calls");
    expect(stats!.calls).toBe(100);
  });

  it("produces summary with top tools", () => {
    toolMetrics.record("slow_tool", 5000, true);
    toolMetrics.record("fast_tool", 10, true);
    toolMetrics.record("broken_tool", 100, false);
    toolMetrics.record("broken_tool", 200, false);

    const summary = toolMetrics.getSummary();
    expect(summary.totalCalls).toBe(4);
    expect(summary.toolCount).toBe(3);
    expect(summary.topByLatency[0].name).toBe("slow_tool");
    expect(summary.topByErrors[0].name).toBe("broken_tool");
    expect(summary.topByErrors[0].failures).toBe(2);
  });
});
