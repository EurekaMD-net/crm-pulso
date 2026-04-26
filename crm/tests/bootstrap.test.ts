import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CRM_TABLES } from "../src/schema.js";

let testDb: InstanceType<typeof Database>;

vi.mock("../src/db.js", () => ({
  getDatabase: () => testDb,
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

const { bootstrapCrm } = await import("../src/bootstrap.js");

describe("bootstrapCrm", () => {
  beforeEach(() => {
    testDb = new Database(":memory:");
    sqliteVec.load(testDb);
    // bootstrapCrm now validateEnv()s required vars before touching the DB.
    // Tests don't load .env, so stub the values here. NODE_ENV is undefined
    // in test mode, so DASHBOARD_JWT_SECRET stays optional.
    process.env.INFERENCE_PRIMARY_URL ??= "http://localhost:9999/test";
    process.env.INFERENCE_PRIMARY_MODEL ??= "test-model";
  });

  it("succeeds on in-memory DB", () => {
    expect(() => bootstrapCrm()).not.toThrow();
  });

  it("is idempotent (calling twice does not error)", () => {
    bootstrapCrm();
    expect(() => bootstrapCrm()).not.toThrow();
  });

  it("creates all 16 CRM tables", () => {
    bootstrapCrm();

    const tables = testDb
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all()
      .map((r: any) => r.name);

    for (const t of CRM_TABLES) {
      expect(tables).toContain(t);
    }
  });

  it("attempts to set WAL journal mode", () => {
    bootstrapCrm();
    const mode = testDb.pragma("journal_mode", { simple: true });
    // In-memory DBs stay 'memory'; on-disk would be 'wal'
    expect(["wal", "memory"]).toContain(mode);
  });
});
