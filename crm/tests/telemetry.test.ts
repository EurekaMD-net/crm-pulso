/**
 * Tool usage telemetry tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const runFn = vi.fn();
const allFn = vi.fn().mockReturnValue([]);
const mockDb = {
  exec: vi.fn(),
  prepare: vi.fn().mockReturnValue({ run: runFn, all: allFn }),
};

vi.mock("../../engine/src/db.js", () => ({
  getDatabase: () => mockDb,
}));

import {
  recordToolUsage,
  queryToolUsage,
  resetTelemetryTable,
} from "../src/tools/telemetry.js";

describe("telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTelemetryTable();
    runFn.mockClear();
    allFn.mockClear().mockReturnValue([]);
    mockDb.exec.mockClear();
    mockDb.prepare.mockClear().mockReturnValue({ run: runFn, all: allFn });
  });

  describe("recordToolUsage", () => {
    it("should create table on first call and insert row", () => {
      recordToolUsage("consultar_pipeline", "1", "ae", 150, true);

      // Table creation (3 exec calls: CREATE TABLE + 2 indexes)
      expect(mockDb.exec).toHaveBeenCalledTimes(3);
      expect(mockDb.exec.mock.calls[0][0]).toContain("crm_tool_usage");

      // INSERT
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO crm_tool_usage"),
      );
      expect(runFn).toHaveBeenCalledWith(
        "consultar_pipeline",
        "1",
        "ae",
        150,
        1,
      );
    });

    it("should not recreate table on subsequent calls", () => {
      recordToolUsage("consultar_pipeline", "1", "ae", 150, true);
      const execCountAfterFirst = mockDb.exec.mock.calls.length;
      recordToolUsage("consultar_pipeline", "1", "ae", 200, true);

      // No additional exec calls
      expect(mockDb.exec).toHaveBeenCalledTimes(execCountAfterFirst);
    });

    it("should store success=0 for failed calls", () => {
      recordToolUsage("crear_propuesta", "2", "gerente", 500, false);

      expect(runFn).toHaveBeenCalledWith(
        "crear_propuesta",
        "2",
        "gerente",
        500,
        0,
      );
    });

    it("should not throw on database errors", () => {
      mockDb.prepare.mockImplementation(() => {
        throw new Error("DB locked");
      });

      expect(() => {
        recordToolUsage("consultar_pipeline", "1", "ae", 150, true);
      }).not.toThrow();
    });
  });

  describe("queryToolUsage", () => {
    it("should return empty array on no data", () => {
      const result = queryToolUsage(14);
      expect(result).toEqual([]);
    });

    it("should query with correct days parameter", () => {
      const queryAllFn = vi.fn().mockReturnValue([
        {
          tool: "consultar_pipeline",
          count: 10,
          avgMs: 150,
          successRate: 90,
        },
      ]);
      mockDb.prepare.mockReturnValue({ run: runFn, all: queryAllFn });

      const result = queryToolUsage(7);

      expect(queryAllFn).toHaveBeenCalledWith(7);
      expect(result).toHaveLength(1);
      expect(result[0].tool).toBe("consultar_pipeline");
    });
  });
});
