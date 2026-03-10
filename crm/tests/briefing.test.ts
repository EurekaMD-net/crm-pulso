/**
 * generar_briefing tests
 *
 * Verifies role-based briefing aggregation for AE, Gerente, Director, VP.
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

vi.mock("../src/google-auth.js", () => ({
  getGoogleAccessToken: () => Promise.resolve("fake-token"),
}));

const { generar_briefing } = await import("../src/tools/briefing.js");
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

function gerenteCtx(personaId = "ger1") {
  return {
    persona_id: personaId,
    rol: "gerente" as const,
    team_ids: ["ae1", "ae2"],
    full_team_ids: ["ae1", "ae2"],
  };
}

function directorCtx(personaId = "dir1") {
  return {
    persona_id: personaId,
    rol: "director" as const,
    team_ids: ["ger1"],
    full_team_ids: ["ger1", "ae1", "ae2"],
  };
}

function vpCtx(personaId = "vp1") {
  return {
    persona_id: personaId,
    rol: "vp" as const,
    team_ids: ["dir1"],
    full_team_ids: ["dir1", "ger1", "ae1", "ae2"],
  };
}

function todayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function daysAgo(n: number) {
  return new Date(Date.now() - n * 86400000).toISOString();
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
  const ins = testDb.prepare(
    "INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES (?, ?, ?, ?, ?)",
  );
  ins.run("vp1", "Elena", "vp", null, 1);
  ins.run("dir1", "Roberto", "director", "vp1", 1);
  ins.run("ger1", "Miguel", "gerente", "dir1", 1);
  ins.run("ae1", "Maria", "ae", "ger1", 1);
  ins.run("ae2", "Carlos", "ae", "ger1", 1);

  // Account
  testDb
    .prepare(
      "INSERT INTO cuenta (id, nombre, tipo, ae_id, gerente_id, director_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("c1", "Coca-Cola", "directo", "ae1", "ger1", "dir1");
  testDb
    .prepare(
      "INSERT INTO cuenta (id, nombre, tipo, ae_id, gerente_id, director_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("c2", "Pepsi", "directo", "ae2", "ger1", "dir1");
}

// ---------------------------------------------------------------------------
// AE Briefing
// ---------------------------------------------------------------------------

describe("AE briefing", () => {
  beforeEach(setupDb);

  it("returns carry-over items due today or overdue", () => {
    // Activity with siguiente_accion due today
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, siguiente_accion, fecha_siguiente_accion, fecha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "a1",
        "ae1",
        "c1",
        "llamada",
        "Call",
        "Follow up",
        todayISO(),
        daysAgo(2),
      );

    // Activity with siguiente_accion due tomorrow (should NOT appear)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 2);
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, siguiente_accion, fecha_siguiente_accion, fecha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "a2",
        "ae1",
        "c1",
        "llamada",
        "Call2",
        "Future action",
        tomorrow.toISOString(),
        daysAgo(1),
      );

    const result = JSON.parse(generar_briefing({}, aeCtx()));
    expect(result.carry_over.length).toBe(1);
    expect(result.carry_over[0].accion).toBe("Follow up");
    expect(result.carry_over[0].cuenta).toBe("Coca-Cola");
  });

  it("detects contacts >14 days silent", () => {
    // Activity 20 days ago (silent account)
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, fecha) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("a1", "ae1", "c1", "llamada", "Old call", daysAgo(20));

    const result = JSON.parse(generar_briefing({}, aeCtx()));
    expect(result.cuentas_sin_contacto_14d.length).toBeGreaterThanOrEqual(1);
    expect(result.cuentas_sin_contacto_14d[0].nombre).toBe("Coca-Cola");
  });

  it("computes path-to-close with quota and closeable deals", () => {
    const semana = getCurrentWeek();
    const año = new Date().getFullYear();

    testDb
      .prepare(
        "INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total, logro) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("q1", "ae1", "ae", año, semana, 1000000, 600000);

    // Closeable deal
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("p1", "c1", "ae1", "Deal A", 200000, "en_negociacion");

    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("p2", "c1", "ae1", "Deal B", 300000, "confirmada_verbal");

    const result = JSON.parse(generar_briefing({}, aeCtx()));
    expect(result.path_to_close.gap).toBe(400000);
    expect(result.path_to_close.closeable_total).toBe(500000);
    expect(result.path_to_close.closeable_deals.length).toBe(2);
    expect(result.path_to_close.cuota.porcentaje).toBeCloseTo(60, 0);
  });

  it("includes today's calendar events", () => {
    const today = new Date();
    today.setHours(10, 0, 0, 0);
    const end = new Date();
    end.setHours(11, 0, 0, 0);

    testDb
      .prepare(
        "INSERT INTO evento_calendario (id, persona_id, titulo, fecha_inicio, fecha_fin, tipo) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "ev1",
        "ae1",
        "Client meeting",
        today.toISOString(),
        end.toISOString(),
        "reunion",
      );

    const result = JSON.parse(generar_briefing({}, aeCtx()));
    expect(result.agenda_hoy.length).toBe(1);
    expect(result.agenda_hoy[0].titulo).toBe("Client meeting");
  });

  it("includes stalled proposals", () => {
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("p1", "c1", "ae1", "Stalled Deal", 500000, "en_discusion", 10);

    const result = JSON.parse(generar_briefing({}, aeCtx()));
    expect(result.propuestas_estancadas.length).toBe(1);
    expect(result.propuestas_estancadas[0].titulo).toBe("Stalled Deal");
    expect(result.propuestas_estancadas[0].dias_sin_actividad).toBe(10);
  });

  it("isolates AE scope (cannot see other AEs)", () => {
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, siguiente_accion, fecha_siguiente_accion, fecha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "a1",
        "ae2",
        "c2",
        "llamada",
        "Other AE",
        "Follow up",
        todayISO(),
        daysAgo(2),
      );

    const result = JSON.parse(generar_briefing({}, aeCtx("ae1")));
    expect(result.carry_over.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gerente Briefing
// ---------------------------------------------------------------------------

describe("Gerente briefing", () => {
  beforeEach(setupDb);

  it("aggregates team mood", () => {
    const recent = daysAgo(2);
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("a1", "ae1", "c1", "llamada", "Good call", "positivo", recent);
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("a2", "ae1", "c1", "email", "Bad email", "negativo", recent);
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("a3", "ae2", "c2", "reunion", "Meeting", "neutral", recent);

    const result = JSON.parse(generar_briefing({}, gerenteCtx()));
    expect(result.sentimiento_equipo.length).toBe(2); // ae1 and ae2
    const ae1Mood = result.sentimiento_equipo.find(
      (e: any) => e.nombre === "Maria",
    );
    expect(ae1Mood.positivo).toBe(1);
    expect(ae1Mood.negativo).toBe(1);
  });

  it("detects declining sentiment AEs", () => {
    // Previous period: ae1 had mostly positive
    for (let i = 0; i < 5; i++) {
      testDb
        .prepare(
          "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          `prev${i}`,
          "ae1",
          "c1",
          "llamada",
          "prev",
          "positivo",
          daysAgo(10),
        );
    }
    // Current period: ae1 has mostly negative
    for (let i = 0; i < 5; i++) {
      testDb
        .prepare(
          "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          `curr${i}`,
          "ae1",
          "c1",
          "llamada",
          "curr",
          "negativo",
          daysAgo(2),
        );
    }

    const result = JSON.parse(generar_briefing({}, gerenteCtx()));
    expect(result.sentimiento_declinando.length).toBeGreaterThanOrEqual(1);
    expect(result.sentimiento_declinando[0].nombre).toBe("Maria");
    expect(result.sentimiento_declinando[0].curr_neg_pct).toBeGreaterThan(
      result.sentimiento_declinando[0].prev_neg_pct,
    );
  });

  it("reports wrap-up compliance", () => {
    // ae1 had activity yesterday, ae2 did not
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(14, 0, 0, 0);

    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, fecha) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("a1", "ae1", "c1", "llamada", "Yesterday", yesterday.toISOString());

    const result = JSON.parse(generar_briefing({}, gerenteCtx()));
    expect(result.wrap_up_sin_completar).toContain("Carlos");
    expect(result.wrap_up_sin_completar).not.toContain("Maria");
  });

  it("computes path-to-close per AE", () => {
    const semana = getCurrentWeek();
    const año = new Date().getFullYear();

    testDb
      .prepare(
        "INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total, logro) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("q1", "ae1", "ae", año, semana, 1000000, 700000);

    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("p1", "c1", "ae1", "Close Deal", 400000, "en_negociacion");

    const result = JSON.parse(generar_briefing({}, gerenteCtx()));
    expect(result.path_to_close_por_ae.length).toBeGreaterThanOrEqual(1);
    const ae1Path = result.path_to_close_por_ae.find(
      (e: any) => e.nombre === "Maria",
    );
    expect(ae1Path).toBeDefined();
    expect(ae1Path.gap).toBe(300000);
    expect(ae1Path.closeable).toBe(400000);
  });

  it("scopes to gerente team only", () => {
    // ae from another gerente
    testDb
      .prepare(
        "INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES (?, ?, ?, ?, ?)",
      )
      .run("ger2", "Ana", "gerente", "dir1", 1);
    testDb
      .prepare(
        "INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES (?, ?, ?, ?, ?)",
      )
      .run("ae3", "Luis", "ae", "ger2", 1);
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, ae_id, gerente_id, director_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("c3", "Nike", "directo", "ae3", "ger2", "dir1");
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("a1", "ae3", "c3", "llamada", "Other team", "negativo", daysAgo(2));

    const result = JSON.parse(generar_briefing({}, gerenteCtx()));
    // Should not include ae3's data in team mood
    const names = result.sentimiento_equipo.map((e: any) => e.nombre);
    expect(names).not.toContain("Luis");
  });
});

// ---------------------------------------------------------------------------
// Director Briefing
// ---------------------------------------------------------------------------

describe("Director briefing", () => {
  beforeEach(setupDb);

  it("shows cross-team sentiment grouped by gerente", () => {
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("a1", "ae1", "c1", "llamada", "Call", "positivo", daysAgo(2));
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("a2", "ae2", "c2", "email", "Email", "negativo", daysAgo(2));

    const result = JSON.parse(generar_briefing({}, directorCtx()));
    expect(result.sentimiento_cross_equipo.length).toBeGreaterThanOrEqual(1);
    const mgrTeam = result.sentimiento_cross_equipo.find(
      (e: any) => e.gerente === "Miguel",
    );
    expect(mgrTeam).toBeDefined();
    expect(mgrTeam.total).toBe(2);
  });

  it("reports coaching frequency for gerentes", () => {
    // Gerente logging own activity
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, fecha) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("a1", "ger1", "c1", "reunion", "Coaching session", daysAgo(2));

    const result = JSON.parse(generar_briefing({}, directorCtx()));
    expect(result.coaching_gerentes.length).toBeGreaterThanOrEqual(1);
    const miguel = result.coaching_gerentes.find(
      (e: any) => e.nombre === "Miguel",
    );
    expect(miguel).toBeDefined();
    expect(miguel.actividades_7d).toBe(1);
  });

  it("tracks mega-deal trajectory", () => {
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("p1", "c1", "ae1", "Mega Campaign", 20000000, "en_negociacion", 3);

    const result = JSON.parse(generar_briefing({}, directorCtx()));
    expect(result.mega_deals.length).toBe(1);
    expect(result.mega_deals[0].titulo).toBe("Mega Campaign");
    expect(result.mega_deals[0].valor).toBe(20000000);
  });

  it("scopes to director's teams only", () => {
    // Another director's team
    testDb
      .prepare(
        "INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES (?, ?, ?, ?, ?)",
      )
      .run("dir2", "Sofia", "director", "vp1", 1);
    testDb
      .prepare(
        "INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES (?, ?, ?, ?, ?)",
      )
      .run("ger2", "Pedro", "gerente", "dir2", 1);
    testDb
      .prepare(
        "INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES (?, ?, ?, ?, ?)",
      )
      .run("ae3", "Luis", "ae", "ger2", 1);
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, ae_id, gerente_id, director_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("c3", "Nike", "directo", "ae3", "ger2", "dir2");
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "a1",
        "ae3",
        "c3",
        "llamada",
        "Other director",
        "negativo",
        daysAgo(2),
      );

    const result = JSON.parse(generar_briefing({}, directorCtx()));
    // Cross-team should not contain Pedro's team
    const gerentes = result.sentimiento_cross_equipo.map((e: any) => e.gerente);
    expect(gerentes).not.toContain("Pedro");
  });
});

// ---------------------------------------------------------------------------
// VP Briefing
// ---------------------------------------------------------------------------

describe("VP briefing", () => {
  beforeEach(setupDb);

  it("shows org-wide mood pulse", () => {
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("a1", "ae1", "c1", "llamada", "Good", "positivo", daysAgo(2));
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("a2", "ae2", "c2", "email", "Bad", "negativo", daysAgo(2));
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("a3", "ae1", "c1", "reunion", "Urgent", "urgente", daysAgo(1));

    const result = JSON.parse(generar_briefing({}, vpCtx()));
    expect(result.pulso_organizacional.total).toBe(3);
    expect(result.pulso_organizacional.positivo).toBe(1);
    expect(result.pulso_organizacional.negativo).toBe(1);
    expect(result.pulso_organizacional.urgente).toBe(1);
    expect(result.pulso_organizacional.negativo_urgente_pct).toBe(67);
  });

  it("flags teams with >30% negative", () => {
    // Team with high negative
    for (let i = 0; i < 4; i++) {
      testDb
        .prepare(
          "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(`neg${i}`, "ae1", "c1", "llamada", "Neg", "negativo", daysAgo(2));
    }
    testDb
      .prepare(
        "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("pos1", "ae1", "c1", "llamada", "Pos", "positivo", daysAgo(2));

    const result = JSON.parse(generar_briefing({}, vpCtx()));
    expect(result.equipos_alto_negativo.length).toBeGreaterThanOrEqual(1);
    expect(result.equipos_alto_negativo[0].gerente).toBe("Miguel");
    expect(result.equipos_alto_negativo[0].negativo_pct).toBeGreaterThan(30);
  });

  it("calculates revenue at risk from declining sentiment", () => {
    // Previous period: ae1 mostly positive
    for (let i = 0; i < 5; i++) {
      testDb
        .prepare(
          "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          `prev${i}`,
          "ae1",
          "c1",
          "llamada",
          "prev",
          "positivo",
          daysAgo(10),
        );
    }
    // Current period: ae1 mostly negative
    for (let i = 0; i < 5; i++) {
      testDb
        .prepare(
          "INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          `curr${i}`,
          "ae1",
          "c1",
          "llamada",
          "curr",
          "negativo",
          daysAgo(2),
        );
    }

    // Active pipeline for ae1
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("p1", "c1", "ae1", "At Risk Deal", 5000000, "en_negociacion");

    const result = JSON.parse(generar_briefing({}, vpCtx()));
    expect(result.revenue_at_risk.total).toBe(5000000);
    expect(
      result.revenue_at_risk.aes_con_sentimiento_declinando,
    ).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Helper import (after mocks)
// ---------------------------------------------------------------------------

function getCurrentWeek(): number {
  const d = new Date();
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(
    ((d.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7,
  );
}
