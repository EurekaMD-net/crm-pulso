import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const { bootstrapCrm, validateEnv } = await import("../src/bootstrap.js");

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

/**
 * validateEnv() production-mode checks — A5 (JWT length floor) + B4 (SSRF
 * allowlist for INFERENCE_PRIMARY_URL). These tests force NODE_ENV=production
 * AND clear VITEST to exercise the full guard path that real prod would hit.
 */
describe("validateEnv (production guards)", () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    VITEST: process.env.VITEST,
    DASHBOARD_JWT_SECRET: process.env.DASHBOARD_JWT_SECRET,
    INFERENCE_PRIMARY_URL: process.env.INFERENCE_PRIMARY_URL,
    INFERENCE_PRIMARY_MODEL: process.env.INFERENCE_PRIMARY_MODEL,
  };

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;
    process.env.DASHBOARD_JWT_SECRET = "x".repeat(64); // valid by default
    process.env.INFERENCE_PRIMARY_URL =
      "https://dashscope.aliyuncs.com/compatible-mode/v1";
    process.env.INFERENCE_PRIMARY_MODEL = "test-model";
  });

  afterEach(() => {
    // Restore exact original env state — undefined keys must be deleted.
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // A5 — JWT secret length floor
  it("A5: rejects missing JWT secret in production", () => {
    delete process.env.DASHBOARD_JWT_SECRET;
    expect(() => validateEnv()).toThrow(/required env vars missing/);
  });

  it("A5: rejects short JWT secret in production (e.g. 'changeme')", () => {
    process.env.DASHBOARD_JWT_SECRET = "changeme";
    expect(() => validateEnv()).toThrow(/≥ 32 chars/);
  });

  it("A5: accepts 32-char JWT secret", () => {
    process.env.DASHBOARD_JWT_SECRET = "x".repeat(32);
    expect(() => validateEnv()).not.toThrow();
  });

  it("A5: accepts 64-char hex secret (openssl rand -hex 32)", () => {
    process.env.DASHBOARD_JWT_SECRET = "a".repeat(64);
    expect(() => validateEnv()).not.toThrow();
  });

  // B4 — SSRF allowlist
  it("B4: rejects http:// in production", () => {
    process.env.INFERENCE_PRIMARY_URL = "http://dashscope.aliyuncs.com/v1";
    expect(() => validateEnv()).toThrow(/must use https/);
  });

  it("B4: rejects cloud metadata IP (169.254.169.254)", () => {
    process.env.INFERENCE_PRIMARY_URL =
      "https://169.254.169.254/latest/meta-data/";
    expect(() => validateEnv()).toThrow(/private\/loopback/);
  });

  it("B4: rejects localhost", () => {
    process.env.INFERENCE_PRIMARY_URL = "https://localhost:5433/";
    expect(() => validateEnv()).toThrow(/private\/loopback/);
  });

  it("B4: rejects 127.0.0.1 loopback", () => {
    process.env.INFERENCE_PRIMARY_URL = "https://127.0.0.1:8100/";
    expect(() => validateEnv()).toThrow(/private\/loopback/);
  });

  it("B4: rejects RFC1918 private ranges", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "192.168.1.1"]) {
      process.env.INFERENCE_PRIMARY_URL = `https://${ip}/v1`;
      expect(() => validateEnv()).toThrow(/private\/loopback/);
    }
  });

  it("B4: rejects unknown public hostname not in allowlist", () => {
    process.env.INFERENCE_PRIMARY_URL = "https://attacker.example.com/v1";
    expect(() => validateEnv()).toThrow(/not in allowlist/);
  });

  it("B4: rejects malformed URL", () => {
    process.env.INFERENCE_PRIMARY_URL = "not a url at all";
    expect(() => validateEnv()).toThrow(/not a valid URL/);
  });

  it("B4: accepts allowlisted dashscope.aliyuncs.com", () => {
    process.env.INFERENCE_PRIMARY_URL =
      "https://dashscope.aliyuncs.com/compatible-mode/v1";
    expect(() => validateEnv()).not.toThrow();
  });

  it("B4: accepts allowlisted coding-intl.dashscope.aliyuncs.com", () => {
    process.env.INFERENCE_PRIMARY_URL =
      "https://coding-intl.dashscope.aliyuncs.com/v1";
    expect(() => validateEnv()).not.toThrow();
  });

  it("B4: accepts allowlisted api.minimax.chat", () => {
    process.env.INFERENCE_PRIMARY_URL = "https://api.minimax.chat/v1";
    expect(() => validateEnv()).not.toThrow();
  });

  it("B4: skipped in non-production (allows http://localhost for dev)", () => {
    process.env.NODE_ENV = "development";
    process.env.INFERENCE_PRIMARY_URL = "http://localhost:9999/test";
    expect(() => validateEnv()).not.toThrow();
  });

  it("B4: skipped under vitest (allows test-stubbed URLs)", () => {
    process.env.VITEST = "true";
    process.env.INFERENCE_PRIMARY_URL = "http://localhost:9999/test";
    expect(() => validateEnv()).not.toThrow();
  });

  // B4 — bypass-pinning sweep. These all resolve through WHATWG URL parsing
  // to a form that one of our checks catches today. The point of pinning
  // them is so a future "let's loosen the allowlist a bit" change can't
  // silently regress any of them.
  it("B4: rejects integer-encoded loopback (https://2130706433/)", () => {
    process.env.INFERENCE_PRIMARY_URL = "https://2130706433/v1";
    expect(() => validateEnv()).toThrow(/private\/loopback/);
  });

  it("B4: rejects hex-encoded loopback (https://0x7f000001/)", () => {
    process.env.INFERENCE_PRIMARY_URL = "https://0x7f000001/v1";
    expect(() => validateEnv()).toThrow(/private\/loopback/);
  });

  it("B4: rejects shorthand zero-host (https://0/)", () => {
    process.env.INFERENCE_PRIMARY_URL = "https://0/v1";
    expect(() => validateEnv()).toThrow(/private\/loopback/);
  });

  it("B4: rejects IPv6 loopback ([::1])", () => {
    process.env.INFERENCE_PRIMARY_URL = "https://[::1]/v1";
    expect(() => validateEnv()).toThrow(/private\/loopback/);
  });

  it("B4: rejects IPv4-mapped IPv6 ([::ffff:127.0.0.1])", () => {
    process.env.INFERENCE_PRIMARY_URL = "https://[::ffff:127.0.0.1]/v1";
    expect(() => validateEnv()).toThrow(/private\/loopback/);
  });

  it("B4: rejects IPv6 link-local ([fe80::1])", () => {
    process.env.INFERENCE_PRIMARY_URL = "https://[fe80::1]/v1";
    expect(() => validateEnv()).toThrow(/private\/loopback/);
  });

  it("B4: rejects IPv6 unique-local ([fc00::1])", () => {
    process.env.INFERENCE_PRIMARY_URL = "https://[fc00::1]/v1";
    expect(() => validateEnv()).toThrow(/private\/loopback/);
  });

  it("B4: rejects trailing-dot allowlisted hostname", () => {
    // FQDN-with-dot resolves to the same host but URL.hostname keeps the
    // dot, so allowlist Set membership fails. We rely on this — pinning it
    // so an exact-match → suffix-match refactor doesn't loosen behavior.
    process.env.INFERENCE_PRIMARY_URL = "https://dashscope.aliyuncs.com./v1";
    expect(() => validateEnv()).toThrow(/not in allowlist/);
  });

  it("B4: case-insensitive allowlist match (DASHSCOPE → dashscope)", () => {
    // Pin the lowercase normalization. WHATWG URL also lowercases, but our
    // explicit `host.toLowerCase()` is the load-bearing line.
    process.env.INFERENCE_PRIMARY_URL = "https://DASHSCOPE.ALIYUNCS.COM/v1";
    expect(() => validateEnv()).not.toThrow();
  });

  it("B4: ignores @-confusion userinfo (allowlist still wins)", () => {
    // `https://attacker.com@dashscope.aliyuncs.com/v1` parses with
    // hostname=dashscope.aliyuncs.com (attacker.com is userinfo). This
    // request really does hit dashscope, so accepting it is correct —
    // pinning so refactors don't accidentally start parsing userinfo.
    process.env.INFERENCE_PRIMARY_URL =
      "https://attacker.com@dashscope.aliyuncs.com/v1";
    expect(() => validateEnv()).not.toThrow();
  });

  it("B4: rejects IDN homoglyph (aliyüncs ≠ aliyuncs)", () => {
    // WHATWG URL converts to punycode (xn--…), allowlist doesn't match.
    process.env.INFERENCE_PRIMARY_URL = "https://dashscope.aliyüncs.com/v1";
    expect(() => validateEnv()).toThrow(/not in allowlist/);
  });
});
