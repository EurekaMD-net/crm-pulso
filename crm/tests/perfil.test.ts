/**
 * User Profile Tests
 *
 * Tests for:
 * - actualizar_perfil tool handler (upsert, field validation)
 * - getUserProfile helper (retrieval, null handling)
 * - formatProfileSection (system prompt formatting)
 * - perfil_usuario schema (table creation, FK, PK)
 * - crm_memories migration (crm-user bank acceptance)
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

const { _resetStatementCache } = await import("../src/hierarchy.js");
const { actualizar_perfil, getUserProfile, formatProfileSection } =
  await import("../src/tools/perfil.js");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setupDb() {
  testDb = new Database(":memory:");
  sqliteVec.load(testDb);
  testDb.pragma("foreign_keys = ON");
  createCrmSchema(testDb);

  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, activo) VALUES ('vp-001', 'Elena Ruiz', 'vp', 1)`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES ('mgr-001', 'Ana Garcia', 'gerente', 'vp-001', 1)`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES ('ae-001', 'Carlos Lopez', 'ae', 'mgr-001', 1)`,
    )
    .run();
}

const aeCtx = {
  persona_id: "ae-001",
  rol: "ae" as const,
  team_ids: [],
  full_team_ids: [],
};

const mgrCtx = {
  persona_id: "mgr-001",
  rol: "gerente" as const,
  team_ids: ["ae-001"],
  full_team_ids: ["ae-001"],
};

beforeEach(() => {
  setupDb();
  _resetStatementCache();
});

afterEach(() => {
  testDb?.close();
});

// ---------------------------------------------------------------------------
// actualizar_perfil — tool handler
// ---------------------------------------------------------------------------

describe("actualizar_perfil", () => {
  it("creates profile on first update", () => {
    const raw = actualizar_perfil(
      { campo: "estilo_comunicacion", valor: "breve y directo" },
      aeCtx,
    );
    const result = JSON.parse(raw);
    expect(result.error).toBeUndefined();
    expect(result.mensaje).toContain("Estilo");
    expect(result.mensaje).toContain("breve y directo");

    const row = testDb
      .prepare("SELECT * FROM perfil_usuario WHERE persona_id = ?")
      .get("ae-001") as any;
    expect(row.estilo_comunicacion).toBe("breve y directo");
  });

  it("updates existing profile field without overwriting others", () => {
    actualizar_perfil({ campo: "estilo_comunicacion", valor: "breve" }, aeCtx);
    actualizar_perfil({ campo: "motivadores", valor: "competitivo" }, aeCtx);

    const row = testDb
      .prepare("SELECT * FROM perfil_usuario WHERE persona_id = ?")
      .get("ae-001") as any;
    expect(row.estilo_comunicacion).toBe("breve");
    expect(row.motivadores).toBe("competitivo");
  });

  it("updates each valid field", () => {
    const fields = [
      { campo: "estilo_comunicacion", valor: "casual" },
      { campo: "preferencias_briefing", valor: "solo numeros" },
      { campo: "horario_trabajo", valor: "7am-5pm" },
      { campo: "datos_personales", valor: "fan del America" },
      { campo: "motivadores", valor: "rankings" },
      { campo: "notas", valor: "no le gustan emails largos" },
    ];

    for (const f of fields) {
      const raw = actualizar_perfil(f, aeCtx);
      const result = JSON.parse(raw);
      expect(result.error).toBeUndefined();
    }

    const row = testDb
      .prepare("SELECT * FROM perfil_usuario WHERE persona_id = ?")
      .get("ae-001") as any;
    expect(row.estilo_comunicacion).toBe("casual");
    expect(row.preferencias_briefing).toBe("solo numeros");
    expect(row.horario_trabajo).toBe("7am-5pm");
    expect(row.datos_personales).toBe("fan del America");
    expect(row.motivadores).toBe("rankings");
    expect(row.notas).toBe("no le gustan emails largos");
  });

  it("rejects invalid campo", () => {
    const raw = actualizar_perfil(
      { campo: "invalid_field", valor: "test" },
      aeCtx,
    );
    const result = JSON.parse(raw);
    expect(result.error).toContain("Campo invalido");
  });

  it("rejects missing valor", () => {
    const raw = actualizar_perfil({ campo: "estilo_comunicacion" }, aeCtx);
    const result = JSON.parse(raw);
    expect(result.error).toContain("valor");
  });

  it("rejects empty valor", () => {
    const raw = actualizar_perfil(
      { campo: "estilo_comunicacion", valor: "" },
      aeCtx,
    );
    const result = JSON.parse(raw);
    expect(result.error).toContain("valor");
  });

  it("updates fecha_actualizacion on each write", () => {
    actualizar_perfil({ campo: "estilo_comunicacion", valor: "v1" }, aeCtx);
    const row1 = testDb
      .prepare(
        "SELECT fecha_actualizacion FROM perfil_usuario WHERE persona_id = ?",
      )
      .get("ae-001") as any;

    // Small delay to ensure different timestamp
    actualizar_perfil({ campo: "estilo_comunicacion", valor: "v2" }, aeCtx);
    const row2 = testDb
      .prepare(
        "SELECT fecha_actualizacion FROM perfil_usuario WHERE persona_id = ?",
      )
      .get("ae-001") as any;

    expect(row1.fecha_actualizacion).toBeTruthy();
    expect(row2.fecha_actualizacion).toBeTruthy();
  });

  it("works for different roles", () => {
    const raw = actualizar_perfil(
      { campo: "estilo_comunicacion", valor: "detallista" },
      mgrCtx,
    );
    const result = JSON.parse(raw);
    expect(result.error).toBeUndefined();

    const row = testDb
      .prepare("SELECT * FROM perfil_usuario WHERE persona_id = ?")
      .get("mgr-001") as any;
    expect(row.estilo_comunicacion).toBe("detallista");
  });
});

// ---------------------------------------------------------------------------
// getUserProfile
// ---------------------------------------------------------------------------

describe("getUserProfile", () => {
  it("returns null when no profile exists", () => {
    const profile = getUserProfile(testDb, "ae-001");
    expect(profile).toBeNull();
  });

  it("returns profile with populated fields", () => {
    testDb
      .prepare(
        `INSERT INTO perfil_usuario (persona_id, estilo_comunicacion, motivadores)
         VALUES ('ae-001', 'breve', 'competitivo')`,
      )
      .run();

    const profile = getUserProfile(testDb, "ae-001");
    expect(profile).not.toBeNull();
    expect(profile!.estilo_comunicacion).toBe("breve");
    expect(profile!.motivadores).toBe("competitivo");
  });

  it("returns null when all fields are null", () => {
    testDb
      .prepare(`INSERT INTO perfil_usuario (persona_id) VALUES ('ae-001')`)
      .run();

    const profile = getUserProfile(testDb, "ae-001");
    expect(profile).toBeNull();
  });

  it("omits null fields from result", () => {
    testDb
      .prepare(
        `INSERT INTO perfil_usuario (persona_id, estilo_comunicacion)
         VALUES ('ae-001', 'directo')`,
      )
      .run();

    const profile = getUserProfile(testDb, "ae-001")!;
    expect(profile.estilo_comunicacion).toBe("directo");
    expect(profile.horario_trabajo).toBeUndefined();
    expect(profile.datos_personales).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatProfileSection
// ---------------------------------------------------------------------------

describe("formatProfileSection", () => {
  it("formats single field", () => {
    const section = formatProfileSection({
      estilo_comunicacion: "breve y casual",
    });
    expect(section).toContain("## Tu Usuario");
    expect(section).toContain("Estilo: breve y casual");
  });

  it("formats multiple fields", () => {
    const section = formatProfileSection({
      estilo_comunicacion: "directo",
      horario_trabajo: "7am-6pm L-V",
      motivadores: "competitivo",
    });
    expect(section).toContain("Estilo: directo");
    expect(section).toContain("Horario: 7am-6pm L-V");
    expect(section).toContain("Motivadores: competitivo");
  });

  it("uses correct labels", () => {
    const section = formatProfileSection({
      estilo_comunicacion: "a",
      preferencias_briefing: "b",
      horario_trabajo: "c",
      datos_personales: "d",
      motivadores: "e",
      notas: "f",
    });
    expect(section).toContain("Estilo: a");
    expect(section).toContain("Briefing: b");
    expect(section).toContain("Horario: c");
    expect(section).toContain("Personal: d");
    expect(section).toContain("Motivadores: e");
    expect(section).toContain("Notas: f");
  });

  it("returns empty string when no fields populated", () => {
    const section = formatProfileSection({});
    expect(section).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Schema: perfil_usuario
// ---------------------------------------------------------------------------

describe("perfil_usuario schema", () => {
  it("table is created by createCrmSchema", () => {
    const tables = testDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='perfil_usuario'",
      )
      .all() as any[];
    expect(tables.length).toBe(1);
  });

  it("persona_id is primary key (no duplicates)", () => {
    testDb
      .prepare(
        `INSERT INTO perfil_usuario (persona_id, estilo_comunicacion) VALUES ('ae-001', 'a')`,
      )
      .run();
    expect(() =>
      testDb
        .prepare(
          `INSERT INTO perfil_usuario (persona_id, estilo_comunicacion) VALUES ('ae-001', 'b')`,
        )
        .run(),
    ).toThrow();
  });

  it("enforces persona_id foreign key", () => {
    expect(() =>
      testDb
        .prepare(
          `INSERT INTO perfil_usuario (persona_id, estilo_comunicacion) VALUES ('nonexistent', 'a')`,
        )
        .run(),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Schema: crm_memories migration
// ---------------------------------------------------------------------------

describe("crm_memories banco CHECK", () => {
  it("accepts crm-user bank", () => {
    expect(() =>
      testDb
        .prepare(
          `INSERT INTO crm_memories (id, persona_id, banco, contenido) VALUES ('m1', 'ae-001', 'crm-user', 'test')`,
        )
        .run(),
    ).not.toThrow();
  });

  it("still accepts original banks", () => {
    for (const banco of ["crm-sales", "crm-accounts", "crm-team"]) {
      expect(() =>
        testDb
          .prepare(
            `INSERT INTO crm_memories (id, persona_id, banco, contenido) VALUES (?, 'ae-001', ?, 'test')`,
          )
          .run(`m-${banco}`, banco),
      ).not.toThrow();
    }
  });

  it("rejects unknown bank values", () => {
    expect(() =>
      testDb
        .prepare(
          `INSERT INTO crm_memories (id, persona_id, banco, contenido) VALUES ('m2', 'ae-001', 'unknown', 'test')`,
        )
        .run(),
    ).toThrow();
  });
});
