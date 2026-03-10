/**
 * consultar_resumen_dia tests
 *
 * Verifies the EOD wrap-up tool aggregates today's activities,
 * proposal movements, pending actions, stalled proposals, and quota.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const { consultar_resumen_dia } = await import("../src/tools/reflexion.js");
const { _resetStatementCache } = await import("../src/hierarchy.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function aeCtx(personaId = "ae1") {
  return {
    persona_id: personaId,
    rol: "ae" as const,
    team_ids: [],
    full_team_ids: [],
  };
}

function todayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function nowISO() {
  return new Date().toISOString();
}

function setupDb() {
  testDb = new Database(":memory:");
  sqliteVec.load(testDb);
  testDb.pragma("foreign_keys = ON");
  createCrmSchema(testDb);
  _resetStatementCache();

  // Org chart
  testDb
    .prepare(
      "INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES (?, ?, ?, ?, ?)",
    )
    .run("ger1", "Miguel", "gerente", null, 1);
  testDb
    .prepare(
      "INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES (?, ?, ?, ?, ?)",
    )
    .run("ae1", "Maria", "ae", "ger1", 1);
  testDb
    .prepare(
      "INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES (?, ?, ?, ?, ?)",
    )
    .run("ae2", "Carlos", "ae", "ger1", 1);

  // Accounts
  testDb
    .prepare(
      "INSERT INTO cuenta (id, nombre, tipo, ae_id, gerente_id) VALUES (?, ?, ?, ?, ?)",
    )
    .run("c1", "Coca-Cola", "directo", "ae1", "ger1");
  testDb
    .prepare(
      "INSERT INTO cuenta (id, nombre, tipo, ae_id, gerente_id) VALUES (?, ?, ?, ?, ?)",
    )
    .run("c2", "Pepsi", "directo", "ae1", "ger1");
  testDb
    .prepare(
      "INSERT INTO cuenta (id, nombre, tipo, ae_id, gerente_id) VALUES (?, ?, ?, ?, ?)",
    )
    .run("c3", "Bimbo", "directo", "ae2", "ger1");
}

beforeEach(setupDb);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("consultar_resumen_dia", () => {
  it("returns empty day when no activities", () => {
    const result = JSON.parse(consultar_resumen_dia({}, aeCtx()));

    expect(result.actividades_hoy.total).toBe(0);
    expect(result.actividades_hoy.detalle).toEqual([]);
    expect(result.propuestas_movidas).toEqual([]);
    expect(result.cuota_semana).toBeNull();
  });

  it("returns today's activities for the AE", () => {
    // Insert activity for ae1 today
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "act1",
        "ae1",
        "c1",
        "llamada",
        "Seguimiento propuesta",
        "positivo",
        nowISO(),
      );

    // Insert activity for ae2 today (should NOT appear)
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "act2",
        "ae2",
        "c3",
        "email",
        "Envio cotizacion",
        "neutral",
        nowISO(),
      );

    const result = JSON.parse(consultar_resumen_dia({}, aeCtx()));

    expect(result.actividades_hoy.total).toBe(1);
    expect(result.actividades_hoy.detalle[0].resumen).toBe(
      "Seguimiento propuesta",
    );
    expect(result.actividades_hoy.detalle[0].cuenta).toBe("Coca-Cola");
  });

  it("excludes yesterday's activities", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "act-old",
        "ae1",
        "c1",
        "llamada",
        "Old call",
        "neutral",
        yesterday.toISOString(),
      );

    const result = JSON.parse(consultar_resumen_dia({}, aeCtx()));
    expect(result.actividades_hoy.total).toBe(0);
  });

  it("includes proposals moved today", () => {
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, fecha_ultima_actividad) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "p1",
        "c1",
        "ae1",
        "Campaña Verano",
        5000000,
        "en_negociacion",
        nowISO(),
      );

    // Old proposal — should not appear
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, fecha_ultima_actividad) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "p2",
        "c2",
        "ae1",
        "Campaña Invierno",
        3000000,
        "en_preparacion",
        lastWeek.toISOString(),
      );

    const result = JSON.parse(consultar_resumen_dia({}, aeCtx()));
    expect(result.propuestas_movidas.length).toBe(1);
    expect(result.propuestas_movidas[0].titulo).toBe("Campaña Verano");
    expect(result.propuestas_movidas[0].valor).toBe(5000000);
  });

  it("includes pending actions due today or overdue", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, siguiente_accion, fecha_siguiente_accion, fecha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "act-pending",
        "ae1",
        "c1",
        "llamada",
        "Call with client",
        "neutral",
        "Enviar cotización revisada",
        yesterday.toISOString(),
        yesterday.toISOString(),
      );

    const result = JSON.parse(consultar_resumen_dia({}, aeCtx()));
    expect(result.acciones_pendientes.length).toBe(1);
    expect(result.acciones_pendientes[0].accion).toBe(
      "Enviar cotización revisada",
    );
  });

  it("includes stalled proposals (>7 days)", () => {
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "p-stalled",
        "c1",
        "ae1",
        "Deal Estancado",
        2000000,
        "en_discusion",
        14,
      );

    const result = JSON.parse(consultar_resumen_dia({}, aeCtx()));
    expect(result.propuestas_estancadas.length).toBe(1);
    expect(result.propuestas_estancadas[0].titulo).toBe("Deal Estancado");
    expect(result.propuestas_estancadas[0].dias_sin_actividad).toBe(14);
  });

  it("includes quota snapshot for current week", () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const week = Math.ceil(
      ((now.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7,
    );

    testDb
      .prepare(
        "INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total, logro) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("q1", "ae1", "ae", now.getFullYear(), week, 500000, 350000);

    const result = JSON.parse(consultar_resumen_dia({}, aeCtx()));
    expect(result.cuota_semana).not.toBeNull();
    expect(result.cuota_semana.meta).toBe(500000);
    expect(result.cuota_semana.logro).toBe(350000);
    expect(result.cuota_semana.porcentaje).toBe(70);
  });

  it("returns sentiment breakdown for the day", () => {
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("s1", "ae1", "c1", "llamada", "Good call", "positivo", nowISO());
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("s2", "ae1", "c2", "email", "Neutral email", "neutral", nowISO());
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("s3", "ae1", "c1", "reunion", "Great meeting", "positivo", nowISO());

    const result = JSON.parse(consultar_resumen_dia({}, aeCtx()));
    expect(result.actividades_hoy.sentimiento).toEqual({
      positivo: 2,
      neutral: 1,
    });
  });

  it("scopes data to the requesting AE only", () => {
    // ae2's data
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "other1",
        "ae2",
        "c3",
        "llamada",
        "Carlos call",
        "positivo",
        nowISO(),
      );
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("other-p", "c3", "ae2", "Carlos Deal", 1000000, "en_discusion", 10);

    const result = JSON.parse(consultar_resumen_dia({}, aeCtx("ae1")));
    expect(result.actividades_hoy.total).toBe(0);
    expect(result.propuestas_estancadas.length).toBe(0);
  });

  it("excludes closed proposals from stalled and moved lists", () => {
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad, fecha_ultima_actividad) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "p-closed",
        "c1",
        "ae1",
        "Old Deal",
        1000000,
        "completada",
        20,
        nowISO(),
      );

    const result = JSON.parse(consultar_resumen_dia({}, aeCtx()));
    expect(result.propuestas_estancadas.length).toBe(0);
    expect(result.propuestas_movidas.length).toBe(0);
  });

  it("returns date field matching today", () => {
    const result = JSON.parse(consultar_resumen_dia({}, aeCtx()));
    const today = new Date().toISOString().split("T")[0];
    expect(result.fecha).toBe(today);
  });
});
