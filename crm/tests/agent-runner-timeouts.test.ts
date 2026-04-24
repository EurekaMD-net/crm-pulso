import { describe, it, expect } from "vitest";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  TOOL_TIMEOUTS,
  selectToolTimeout,
} from "../container/agent-runner/index.js";

/**
 * Per-tool wallclock budget — verifies the override map that fixes
 * the prior 15s blanket cap which silently killed `jarvis_pull` calls
 * before mission-control's /api/jarvis-pull cascade could respond.
 *
 * Real production failure (2026-04-24 14:48): mc fallback succeeded at
 * 14:48:22 but agent-runner aborted at 14:48:04 — 18s before the answer
 * was ready. The new map restores headroom for LLM-cascade tools while
 * keeping the 15s safety net on everything else.
 */

describe("selectToolTimeout", () => {
  it("returns the override for jarvis_pull", () => {
    expect(selectToolTimeout("jarvis_pull")).toBe(120_000);
  });

  it("falls back to the default for any unmapped tool", () => {
    expect(selectToolTimeout("consultar_pipeline")).toBe(
      DEFAULT_TOOL_TIMEOUT_MS,
    );
    expect(selectToolTimeout("nonexistent_tool")).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    expect(selectToolTimeout("")).toBe(DEFAULT_TOOL_TIMEOUT_MS);
  });

  it("default is 15s — preserves the prior safety net for fast tools", () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(15_000);
  });

  it("jarvis_pull budget exceeds the fetch-side AbortSignal so fetch fires first", () => {
    // Layered defense: fetch=110s, runner=120s. The 10s gap is intentional —
    // it ensures fetch aborts produce a clean tool-result error rather than
    // a runner-level guillotine. Regressing this invariant breaks the
    // diagnostic clarity we just spent a session restoring.
    const FETCH_ABORT_BUDGET_MS = 110_000;
    expect(TOOL_TIMEOUTS.jarvis_pull).toBeGreaterThan(FETCH_ABORT_BUDGET_MS);
  });

  it("override map is frozen — no accidental mutation at runtime", () => {
    expect(Object.isFrozen(TOOL_TIMEOUTS)).toBe(true);
  });
});
