import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { vi } from "vitest";

let testDb: InstanceType<typeof Database>;

vi.mock("../src/db.js", () => ({
  getDatabase: () => testDb,
}));

import {
  calculateCost,
  recordCost,
  getDailySpend,
  getHourlySpend,
  getMonthlySpend,
  getThreeWindowStatus,
  _resetSchema,
} from "../src/budget.js";

beforeEach(() => {
  testDb = new Database(":memory:");
  _resetSchema();
});

describe("budget", () => {
  describe("calculateCost", () => {
    it("calculates cost for qwen3.5-plus", () => {
      // 1M input tokens at $0.8 + 500K output tokens at $2.0
      const cost = calculateCost("qwen3.5-plus", 1_000_000, 500_000);
      expect(cost).toBeCloseTo(0.8 + 1.0, 4);
    });

    it("uses default pricing for unknown models", () => {
      const cost = calculateCost("unknown-model", 1_000_000, 1_000_000);
      // default: $1.0 input + $3.0 output
      expect(cost).toBeCloseTo(4.0, 4);
    });

    it("returns 0 for zero tokens", () => {
      expect(calculateCost("qwen3.5-plus", 0, 0)).toBe(0);
    });
  });

  describe("recordCost + getDailySpend", () => {
    it("records and retrieves costs", () => {
      recordCost({
        model: "qwen3.5-plus",
        promptTokens: 1000,
        completionTokens: 500,
        provider: "primary",
      });
      recordCost({
        model: "qwen3.5-plus",
        promptTokens: 2000,
        completionTokens: 1000,
        provider: "primary",
      });

      const daily = getDailySpend();
      expect(daily).toBeGreaterThan(0);
    });

    it("hourly spend is subset of daily", () => {
      recordCost({
        model: "glm-5",
        promptTokens: 5000,
        completionTokens: 2000,
      });

      const hourly = getHourlySpend();
      const daily = getDailySpend();
      expect(hourly).toBeLessThanOrEqual(daily);
    });

    it("monthly spend includes all records", () => {
      recordCost({
        model: "glm-5",
        promptTokens: 10000,
        completionTokens: 5000,
      });

      const monthly = getMonthlySpend();
      expect(monthly).toBeGreaterThan(0);
    });
  });

  describe("getThreeWindowStatus", () => {
    it("returns status for all three windows", () => {
      recordCost({
        model: "qwen3.5-plus",
        promptTokens: 1000,
        completionTokens: 500,
      });

      const status = getThreeWindowStatus();
      expect(status.hourly).toBeDefined();
      expect(status.daily).toBeDefined();
      expect(status.monthly).toBeDefined();
      expect(status.hourly.spend).toBeGreaterThan(0);
      expect(status.hourly.remaining).toBeLessThan(status.hourly.limit);
    });

    it("shows not exceeded for small spend", () => {
      recordCost({
        model: "qwen3.5-plus",
        promptTokens: 100,
        completionTokens: 50,
      });

      const status = getThreeWindowStatus();
      expect(status.hourly.exceeded).toBe(false);
      expect(status.daily.exceeded).toBe(false);
      expect(status.monthly.exceeded).toBe(false);
    });
  });
});
