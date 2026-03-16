/**
 * Overnight Commercial Analysis Engine Tests
 *
 * Tests for the 5 analyzers, deduplication, expiration, and insight tools.
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

const { runOvernightAnalysis } = await import("../src/overnight-engine.js");
const { _resetStatementCache } = await import("../src/hierarchy.js");
const { consultar_insights, actuar_insight, consultar_insights_equipo } =
  await import("../src/tools/insight-tools.js");

function seedTeam(db: InstanceType<typeof Database>) {
  db.prepare(
    "INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('vp1', 'VP', 'vp', NULL, 'vp-f', 1)",
  ).run();
  db.prepare(
    "INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('dir1', 'Director', 'director', 'vp1', 'dir-f', 1)",
  ).run();
  db.prepare(
    "INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ger1', 'Gerente', 'gerente', 'dir1', 'ger-f', 1)",
  ).run();
  db.prepare(
    "INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ae1', 'AE One', 'ae', 'ger1', 'ae-f', 1)",
  ).run();
}

function makeCtx(
  personaId: string,
  rol: "ae" | "gerente" | "director" | "vp",
  teamIds: string[] = [],
  fullTeamIds: string[] = [],
) {
  return {
    persona_id: personaId,
    rol,
    team_ids: teamIds,
    full_team_ids: fullTeamIds,
  };
}

beforeEach(() => {
  testDb = new Database(":memory:");
  sqliteVec.load(testDb);
  testDb.pragma("foreign_keys = ON");
  createCrmSchema(testDb);
  _resetStatementCache();
  seedTeam(testDb);
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("insight_comercial schema", () => {
  it("table exists with correct columns", () => {
    const cols = testDb
      .prepare("PRAGMA table_info(insight_comercial)")
      .all()
      .map((c: any) => c.name);
    expect(cols).toContain("tipo");
    expect(cols).toContain("confianza");
    expect(cols).toContain("datos_soporte");
    expect(cols).toContain("estado");
    expect(cols).toContain("lote_nocturno");
  });

  it("rejects invalid tipo", () => {
    expect(() =>
      testDb
        .prepare(
          "INSERT INTO insight_comercial (id, tipo, titulo, descripcion, confianza) VALUES ('x', 'magic', 'T', 'D', 0.5)",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("rejects confianza out of range", () => {
    expect(() =>
      testDb
        .prepare(
          "INSERT INTO insight_comercial (id, tipo, titulo, descripcion, confianza) VALUES ('x', 'riesgo', 'T', 'D', 1.5)",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("rejects invalid estado", () => {
    expect(() =>
      testDb
        .prepare(
          "INSERT INTO insight_comercial (id, tipo, titulo, descripcion, confianza, estado) VALUES ('x', 'riesgo', 'T', 'D', 0.5, 'magic')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("has indexes", () => {
    const indexes = testDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_insight_%'",
      )
      .all()
      .map((r: any) => r.name);
    expect(indexes).toContain("idx_insight_ae");
    expect(indexes).toContain("idx_insight_estado");
    expect(indexes).toContain("idx_insight_tipo");
  });
});

// ---------------------------------------------------------------------------
// Overnight Engine
// ---------------------------------------------------------------------------

describe("runOvernightAnalysis", () => {
  it("runs without errors on empty database", () => {
    const result = runOvernightAnalysis();
    expect(result.total_generated).toBe(0);
    expect(result.lote).toBeTruthy();
  });

  it("detects gap-driven opportunities", () => {
    // Seed a cuenta with contract and billing gap
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, ae_id, estado) VALUES ('c1', 'GapCo', 'directo', 'ae1', 'activo')",
      )
      .run();
    testDb
      .prepare(
        "INSERT INTO contrato (id, cuenta_id, año, monto_comprometido, estatus) VALUES ('ct1', 'c1', 2026, 10000000, 'en_ejecucion')",
      )
      .run();

    // 4 weeks of gap (500K-100K=400K per week, 1.6M total = 16% of 10M commitment)
    for (let w = 1; w <= 4; w++) {
      testDb
        .prepare(
          "INSERT INTO descarga (id, contrato_id, cuenta_id, semana, año, planificado, facturado) VALUES (?, 'ct1', 'c1', ?, 2026, 500000, 100000)",
        )
        .run(`d${w}`, w);
    }

    const result = runOvernightAnalysis();
    expect(result.gap).toBeGreaterThanOrEqual(1);

    const insights = testDb
      .prepare("SELECT * FROM insight_comercial WHERE tipo = 'oportunidad_gap'")
      .all();
    expect(insights.length).toBeGreaterThanOrEqual(1);
  });

  it("detects cross-sell opportunities", () => {
    // Two accounts in same vertical, one has a tipo the other doesn't
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id, estado) VALUES ('c1', 'Brand A', 'directo', 'alimentos', 'ae1', 'activo')",
      )
      .run();
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id, estado) VALUES ('c2', 'Brand B', 'directo', 'alimentos', 'ae1', 'activo')",
      )
      .run();

    // Brand A has completed estacional, Brand B has completed lanzamiento
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa) VALUES ('p1', 'c1', 'ae1', 'Camp Est', 5000000, 'estacional', 'completada')",
      )
      .run();
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa) VALUES ('p2', 'c2', 'ae1', 'Lanz', 3000000, 'lanzamiento', 'completada')",
      )
      .run();
    // Add more peers to meet minimum
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id, estado) VALUES ('c3', 'Brand C', 'directo', 'alimentos', 'ae1', 'activo')",
      )
      .run();
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa) VALUES ('p3', 'c3', 'ae1', 'Camp Est 2', 4000000, 'estacional', 'completada')",
      )
      .run();

    const result = runOvernightAnalysis();
    expect(result.crosssell).toBeGreaterThanOrEqual(1);
  });

  it("detects market-driven opportunities (inactive accounts)", () => {
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, ae_id, estado) VALUES ('c1', 'SilentCo', 'directo', 'ae1', 'activo')",
      )
      .run();
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, etapa) VALUES ('p1', 'c1', 'ae1', 'Old Deal', 'completada')",
      )
      .run();
    // Old activity so getDaysSinceActivity returns ≥30
    const oldDate = new Date(Date.now() - 45 * 86400000).toISOString();
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, fecha) VALUES ('a1', 'ae1', 'c1', 'llamada', 'Old call', ?)",
      )
      .run(oldDate);

    const result = runOvernightAnalysis();
    expect(result.market).toBeGreaterThanOrEqual(1);
  });

  it("deduplicates insights within 7 days", () => {
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, ae_id, estado) VALUES ('c1', 'DedupCo', 'directo', 'ae1', 'activo')",
      )
      .run();
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, etapa) VALUES ('p1', 'c1', 'ae1', 'Old', 'completada')",
      )
      .run();

    // Run twice
    runOvernightAnalysis();
    const firstCount = (
      testDb.prepare("SELECT COUNT(*) as c FROM insight_comercial").get() as any
    ).c;
    runOvernightAnalysis();
    const secondCount = (
      testDb.prepare("SELECT COUNT(*) as c FROM insight_comercial").get() as any
    ).c;

    expect(secondCount).toBe(firstCount); // no new insights on second run
  });

  it("expires stale insights", () => {
    // Insert an insight with expired fecha_expiracion
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    testDb
      .prepare(
        "INSERT INTO insight_comercial (id, tipo, titulo, descripcion, confianza, estado, fecha_expiracion) VALUES ('exp1', 'riesgo', 'Old', 'Desc', 0.5, 'nuevo', ?)",
      )
      .run(past);

    runOvernightAnalysis();

    const row = testDb
      .prepare("SELECT estado FROM insight_comercial WHERE id = 'exp1'")
      .get() as any;
    expect(row.estado).toBe("expirado");
  });
});

// ---------------------------------------------------------------------------
// Insight Tools
// ---------------------------------------------------------------------------

describe("consultar_insights", () => {
  it("returns empty for no insights", () => {
    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(consultar_insights({}, ctx));
    expect(result.mensaje).toContain("No hay insights");
  });

  it("returns insights for AE's accounts", () => {
    testDb
      .prepare(
        "INSERT INTO insight_comercial (id, tipo, titulo, descripcion, confianza, ae_id, estado) VALUES ('i1', 'riesgo', 'Test', 'Desc', 0.8, 'ae1', 'nuevo')",
      )
      .run();

    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(consultar_insights({}, ctx));
    expect(result.total).toBe(1);
    expect(result.insights[0].titulo).toBe("Test");
  });

  it("filters by tipo", () => {
    testDb
      .prepare(
        "INSERT INTO insight_comercial (id, tipo, titulo, descripcion, confianza, ae_id, estado) VALUES ('i1', 'riesgo', 'R', 'D', 0.8, 'ae1', 'nuevo')",
      )
      .run();
    testDb
      .prepare(
        "INSERT INTO insight_comercial (id, tipo, titulo, descripcion, confianza, ae_id, estado) VALUES ('i2', 'oportunidad_gap', 'G', 'D', 0.7, 'ae1', 'nuevo')",
      )
      .run();

    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(consultar_insights({ tipo: "riesgo" }, ctx));
    expect(result.total).toBe(1);
    expect(result.insights[0].tipo).toBe("riesgo");
  });
});

describe("actuar_insight", () => {
  beforeEach(() => {
    testDb
      .prepare(
        "INSERT INTO insight_comercial (id, tipo, titulo, descripcion, confianza, ae_id, estado) VALUES ('i1', 'riesgo', 'Test', 'Desc', 0.8, 'ae1', 'nuevo')",
      )
      .run();
  });

  it("accepts an insight", () => {
    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(
      actuar_insight({ insight_id: "i1", accion: "aceptar" }, ctx),
    );
    expect(result.estado_nuevo).toBe("aceptado");

    const row = testDb
      .prepare("SELECT estado FROM insight_comercial WHERE id = 'i1'")
      .get() as any;
    expect(row.estado).toBe("aceptado");
  });

  it("dismisses with reason", () => {
    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(
      actuar_insight(
        { insight_id: "i1", accion: "descartar", razon: "Ya tengo propuesta" },
        ctx,
      ),
    );
    expect(result.estado_nuevo).toBe("descartado");

    const row = testDb
      .prepare(
        "SELECT estado, razon_descarte FROM insight_comercial WHERE id = 'i1'",
      )
      .get() as any;
    expect(row.estado).toBe("descartado");
    expect(row.razon_descarte).toBe("Ya tengo propuesta");
  });

  it("requires reason for dismiss", () => {
    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(
      actuar_insight({ insight_id: "i1", accion: "descartar" }, ctx),
    );
    expect(result.error).toContain("razon");
  });

  it("rejects invalid action", () => {
    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(
      actuar_insight({ insight_id: "i1", accion: "borrar" }, ctx),
    );
    expect(result.error).toContain("aceptar");
  });
});

describe("consultar_insights_equipo", () => {
  it("AE cannot access", () => {
    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(consultar_insights_equipo({}, ctx));
    expect(result.error).toContain("Solo gerentes");
  });

  it("gerente sees team stats", () => {
    testDb
      .prepare(
        "INSERT INTO insight_comercial (id, tipo, titulo, descripcion, confianza, ae_id, estado, fecha_generacion) VALUES ('i1', 'riesgo', 'T', 'D', 0.8, 'ae1', 'aceptado', datetime('now'))",
      )
      .run();
    testDb
      .prepare(
        "INSERT INTO insight_comercial (id, tipo, titulo, descripcion, confianza, ae_id, estado, fecha_generacion) VALUES ('i2', 'patron', 'T2', 'D2', 0.6, 'ae1', 'descartado', datetime('now'))",
      )
      .run();

    const ctx = makeCtx("ger1", "gerente", ["ae1"]);
    const result = JSON.parse(consultar_insights_equipo({}, ctx));
    expect(result.total_generados).toBe(2);
    expect(result.aceptados).toBe(1);
    expect(result.descartados).toBe(1);
    expect(result.tasa_aceptacion).toBe("50%");
  });
});

// ---------------------------------------------------------------------------
// Shared analysis modules
// ---------------------------------------------------------------------------

describe("peer comparison (via crosssell refactor)", () => {
  it("crosssell still works after refactor", async () => {
    const { recomendar_crosssell } = await import("../src/tools/crosssell.js");

    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id, estado) VALUES ('c1', 'TestA', 'directo', 'tech', 'ae1', 'activo')",
      )
      .run();
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa) VALUES ('p1', 'c1', 'ae1', 'T', 5000000, 'estacional', 'completada')",
      )
      .run();

    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(
      recomendar_crosssell({ cuenta_nombre: "TestA" }, ctx),
    );
    expect(result.cuenta).toBe("TestA");
    expect(result.historial).toBeTruthy();
  });
});
