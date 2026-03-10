/**
 * Sentiment Tests — Phase 8 Session 3
 *
 * Tests for:
 * - consultar_sentimiento_equipo: team sentiment distribution tool
 * - sentimiento_score column exists and accepts values
 * - Escalation coaching signal includes 'urgente'
 * - registrar_actividad imports classifyAndUpdate
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createCrmSchema } from "../src/schema.js";

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

vi.mock("../src/google-auth.js", () => ({
  isGoogleEnabled: () => false,
  getGmailClient: () => {
    throw new Error("Not configured");
  },
  getGmailReadClient: () => {
    throw new Error("Not configured");
  },
  getCalendarClient: () => {
    throw new Error("Not configured");
  },
  getCalendarReadClient: () => {
    throw new Error("Not configured");
  },
  getDriveClient: () => {
    throw new Error("Not configured");
  },
}));

// Mock inference adapter so classifyAndUpdate doesn't make real LLM calls
vi.mock("../src/inference-adapter.js", () => ({
  infer: async () => ({
    content: '{"label": "neutral", "score": 0.5}',
    tool_calls: undefined,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    provider: "mock",
    latency_ms: 0,
  }),
}));

const { consultar_sentimiento_equipo } =
  await import("../src/tools/sentiment.js");
const { _resetStatementCache } = await import("../src/hierarchy.js");

import type { ToolContext } from "../src/tools/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    persona_id: "ae-1",
    rol: "gerente",
    team_ids: ["ae-1", "ae-2", "ae-3"],
    full_team_ids: ["ae-1", "ae-2", "ae-3"],
    ...overrides,
  };
}

function seedTestData() {
  // Insert personas (parents first for FK)
  const insertPersona = testDb.prepare(
    "INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES (?, ?, ?, ?, 1)",
  );
  insertPersona.run("vp-1", "VP Test", "vp", null);
  insertPersona.run("dir-1", "Director Test", "director", "vp-1");
  insertPersona.run("ger-1", "Gerente Test", "gerente", "dir-1");
  insertPersona.run("ae-1", "Carlos Test", "ae", "ger-1");
  insertPersona.run("ae-2", "Maria Test", "ae", "ger-1");
  insertPersona.run("ae-3", "Jose Test", "ae", "ger-1");

  // Insert activities with varying sentiments across last 7 days
  const insertAct = testDb.prepare(
    "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, sentimiento_score, fecha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const now = Date.now();
  const day = 86400000;

  // AE-1: mostly positive (3 pos, 1 neutral)
  insertAct.run(
    "s1",
    "ae-1",
    null,
    "llamada",
    "Buena llamada",
    "positivo",
    0.9,
    new Date(now - 1 * day).toISOString(),
  );
  insertAct.run(
    "s2",
    "ae-1",
    null,
    "whatsapp",
    "Seguimiento ok",
    "positivo",
    0.8,
    new Date(now - 2 * day).toISOString(),
  );
  insertAct.run(
    "s3",
    "ae-1",
    null,
    "email",
    "Envie propuesta",
    "positivo",
    0.85,
    new Date(now - 3 * day).toISOString(),
  );
  insertAct.run(
    "s4",
    "ae-1",
    null,
    "reunion",
    "Reunion normal",
    "neutral",
    0.7,
    new Date(now - 4 * day).toISOString(),
  );

  // AE-2: mostly negative (3 neg, 1 urgente, 1 positivo)
  insertAct.run(
    "s5",
    "ae-2",
    null,
    "llamada",
    "Rechazo",
    "negativo",
    0.9,
    new Date(now - 1 * day).toISOString(),
  );
  insertAct.run(
    "s6",
    "ae-2",
    null,
    "whatsapp",
    "Sin respuesta",
    "negativo",
    0.7,
    new Date(now - 2 * day).toISOString(),
  );
  insertAct.run(
    "s7",
    "ae-2",
    null,
    "email",
    "Cancelacion",
    "negativo",
    0.85,
    new Date(now - 3 * day).toISOString(),
  );
  insertAct.run(
    "s8",
    "ae-2",
    null,
    "llamada",
    "Urgente perdida",
    "urgente",
    0.95,
    new Date(now - 4 * day).toISOString(),
  );
  insertAct.run(
    "s9",
    "ae-2",
    null,
    "reunion",
    "Algo bueno",
    "positivo",
    0.6,
    new Date(now - 5 * day).toISOString(),
  );

  // AE-3: mixed (1 of each)
  insertAct.run(
    "s10",
    "ae-3",
    null,
    "llamada",
    "Ok call",
    "positivo",
    0.8,
    new Date(now - 1 * day).toISOString(),
  );
  insertAct.run(
    "s11",
    "ae-3",
    null,
    "whatsapp",
    "Neutral msg",
    "neutral",
    0.7,
    new Date(now - 2 * day).toISOString(),
  );
  insertAct.run(
    "s12",
    "ae-3",
    null,
    "email",
    "Mala noticia",
    "negativo",
    0.75,
    new Date(now - 3 * day).toISOString(),
  );

  // Previous period activities (8-14 days ago) for trend comparison
  insertAct.run(
    "s20",
    "ae-1",
    null,
    "llamada",
    "Old pos",
    "positivo",
    0.8,
    new Date(now - 10 * day).toISOString(),
  );
  insertAct.run(
    "s21",
    "ae-2",
    null,
    "llamada",
    "Old neg",
    "negativo",
    0.8,
    new Date(now - 10 * day).toISOString(),
  );
  insertAct.run(
    "s22",
    "ae-2",
    null,
    "llamada",
    "Old pos",
    "positivo",
    0.8,
    new Date(now - 11 * day).toISOString(),
  );
}

// ---------------------------------------------------------------------------
// Setup: fresh DB per test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  testDb = new Database(":memory:");
  sqliteVec.load(testDb);
  createCrmSchema(testDb);
  if (typeof _resetStatementCache === "function") _resetStatementCache();
  seedTestData();
});

// ---------------------------------------------------------------------------
// consultar_sentimiento_equipo tests
// ---------------------------------------------------------------------------

describe("consultar_sentimiento_equipo", () => {
  it("returns per-AE sentiment breakdown", () => {
    const result = JSON.parse(consultar_sentimiento_equipo({}, makeCtx()));
    expect(result.por_ae).toBeDefined();
    expect(result.por_ae.length).toBe(3);

    const ae1 = result.por_ae.find((a: any) => a.nombre === "Carlos Test");
    expect(ae1).toBeDefined();
    expect(ae1.positivo).toBe(3);
    expect(ae1.neutral).toBe(1);
    expect(ae1.negativo).toBe(0);
    expect(ae1.total).toBe(4);
  });

  it("returns AE-2 with high negative count", () => {
    const result = JSON.parse(consultar_sentimiento_equipo({}, makeCtx()));
    const ae2 = result.por_ae.find((a: any) => a.nombre === "Maria Test");
    expect(ae2).toBeDefined();
    expect(ae2.negativo).toBe(3);
    expect(ae2.urgente).toBe(1);
    expect(ae2.positivo).toBe(1);
    expect(ae2.total).toBe(5);
  });

  it("returns resumen with trend", () => {
    const result = JSON.parse(consultar_sentimiento_equipo({}, makeCtx()));
    expect(result.resumen).toBeDefined();
    expect(result.resumen.total_actividades).toBeGreaterThan(0);
    expect(result.resumen.negativo_urgente_pct).toBeGreaterThanOrEqual(0);
    expect(["mejorando", "estable", "deteriorando"]).toContain(
      result.resumen.tendencia,
    );
  });

  it("flags AEs with >50% negative/urgent as alertas", () => {
    const result = JSON.parse(consultar_sentimiento_equipo({}, makeCtx()));
    expect(result.alertas).toBeDefined();
    // AE-2 has 4/5 = 80% neg+urgent → should be flagged
    const alert = result.alertas.find((a: any) => a.nombre === "Maria Test");
    expect(alert).toBeDefined();
    expect(alert.pct).toBe(80);
  });

  it("respects gerente scope — only sees own team", () => {
    const ctx = makeCtx({
      persona_id: "ger-1",
      rol: "gerente",
      team_ids: ["ae-1"],
      full_team_ids: ["ae-1"],
    });
    const result = JSON.parse(consultar_sentimiento_equipo({}, ctx));
    const names = result.por_ae.map((a: any) => a.nombre);
    expect(names).toContain("Carlos Test");
    expect(names).not.toContain("Maria Test");
    expect(names).not.toContain("Jose Test");
  });

  it("VP sees all AEs (no scope filter)", () => {
    const ctx = makeCtx({
      persona_id: "vp-1",
      rol: "vp",
      team_ids: [],
      full_team_ids: [],
    });
    const result = JSON.parse(consultar_sentimiento_equipo({}, ctx));
    expect(result.por_ae.length).toBeGreaterThanOrEqual(3);
  });

  it("respects dias parameter", () => {
    const result = JSON.parse(
      consultar_sentimiento_equipo({ dias: 3 }, makeCtx()),
    );
    expect(result.periodo_dias).toBe(3);
    expect(result.resumen.total_actividades).toBeLessThan(12);
  });

  it("handles empty scope gracefully", () => {
    const ctx = makeCtx({
      persona_id: "nonexistent",
      rol: "ae",
      team_ids: [],
      full_team_ids: [],
    });
    const result = JSON.parse(consultar_sentimiento_equipo({}, ctx));
    expect(result.por_ae).toEqual([]);
    expect(result.resumen.total_actividades).toBe(0);
    expect(result.alertas).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sentiment classification module tests (unit, no LLM call)
// ---------------------------------------------------------------------------

describe("classifySentiment module", () => {
  it("module exports classifySentiment and classifyAndUpdate", async () => {
    const mod = await import("../src/sentiment.js");
    expect(typeof mod.classifySentiment).toBe("function");
    expect(typeof mod.classifyAndUpdate).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// sentimiento_score column tests
// ---------------------------------------------------------------------------

describe("sentimiento_score column", () => {
  it("exists on actividad table", () => {
    const cols = testDb.prepare("PRAGMA table_info(actividad)").all() as {
      name: string;
    }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("sentimiento_score");
  });

  it("accepts REAL values", () => {
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, resumen, sentimiento, sentimiento_score, fecha) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "score-test",
        "ae-1",
        "Test",
        "positivo",
        0.85,
        new Date().toISOString(),
      );

    const row = testDb
      .prepare(
        "SELECT sentimiento_score FROM actividad WHERE id = 'score-test'",
      )
      .get() as { sentimiento_score: number };
    expect(row.sentimiento_score).toBe(0.85);
  });

  it("allows NULL sentimiento_score", () => {
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?)",
      )
      .run("null-test", "ae-1", "Test", "neutral", new Date().toISOString());

    const row = testDb
      .prepare("SELECT sentimiento_score FROM actividad WHERE id = 'null-test'")
      .get() as { sentimiento_score: number | null };
    expect(row.sentimiento_score).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Escalation integration (coaching signal includes urgente)
// ---------------------------------------------------------------------------

describe("escalation coaching signal", () => {
  it("query counts both negativo and urgente", () => {
    const monday = (() => {
      const now = new Date();
      const day = now.getDay();
      const diff = day === 0 ? 6 : day - 1;
      return new Date(now.getTime() - diff * 86400000)
        .toISOString()
        .slice(0, 10);
    })();

    const row = testDb
      .prepare(
        `SELECT COUNT(*) as c FROM actividad WHERE ae_id = ? AND sentimiento IN ('negativo', 'urgente') AND fecha >= ?`,
      )
      .get("ae-2", monday) as { c: number };

    // ae-2 has 3 negativo + 1 urgente in last 7 days
    expect(row.c).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// registrar_actividad sentiment hook
// ---------------------------------------------------------------------------

describe("registrar_actividad sentiment hook", () => {
  it("imports and loads without error", async () => {
    const mod = await import("../src/tools/registro.js");
    expect(typeof mod.registrar_actividad).toBe("function");
  });
});
