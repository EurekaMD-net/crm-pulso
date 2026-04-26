/**
 * Approval Workflow Tests
 *
 * Tests for the record creation approval workflow:
 * - State machine transitions (create → approve → activate)
 * - Role-based access control
 * - 24h challenge window
 * - Rejection and deletion
 * - Query filtering by estado
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "fs";
import path from "path";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createCrmSchema } from "../src/schema.js";

// Mock engine modules
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

// Dynamic imports after mock
const { _resetStatementCache } = await import("../src/hierarchy.js");
const {
  solicitar_cuenta,
  solicitar_contacto,
  aprobar_registro,
  rechazar_registro,
  consultar_pendientes,
  impugnar_registro,
} = await import("../src/tools/aprobaciones.js");
const { estadoFilter } = await import("../src/tools/helpers.js");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function seedTeam(db: InstanceType<typeof Database>) {
  db.prepare(
    `INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder)
     VALUES ('vp1', 'VP Boss', 'vp', NULL, 'vp-folder')`,
  ).run();
  db.prepare(
    `INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder)
     VALUES ('dir1', 'Director One', 'director', 'vp1', 'dir-folder')`,
  ).run();
  db.prepare(
    `INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder)
     VALUES ('ger1', 'Gerente One', 'gerente', 'dir1', 'ger-folder')`,
  ).run();
  db.prepare(
    `INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder)
     VALUES ('ae1', 'AE One', 'ae', 'ger1', 'ae-folder')`,
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

// Clean up IPC files after tests
const IPC_DIR = path.resolve("data/ipc/main/tasks");

afterEach(() => {
  // Clean up any IPC files created by tests
  if (fs.existsSync(IPC_DIR)) {
    const files = fs.readdirSync(IPC_DIR).filter((f) => f.startsWith("aprob-"));
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(IPC_DIR, file));
      } catch {
        /* ignore */
      }
    }
  }
});

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

describe("approval schema", () => {
  it("cuenta has estado, creado_por, fecha_activacion columns", () => {
    const cols = testDb
      .prepare("PRAGMA table_info(cuenta)")
      .all()
      .map((c: any) => c.name);
    expect(cols).toContain("estado");
    expect(cols).toContain("creado_por");
    expect(cols).toContain("fecha_activacion");
  });

  it("contacto has estado, creado_por, fecha_activacion columns", () => {
    const cols = testDb
      .prepare("PRAGMA table_info(contacto)")
      .all()
      .map((c: any) => c.name);
    expect(cols).toContain("estado");
    expect(cols).toContain("creado_por");
    expect(cols).toContain("fecha_activacion");
  });

  it("cuenta.estado defaults to activo", () => {
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo) VALUES ('c1', 'Test', 'directo')",
      )
      .run();
    const row = testDb
      .prepare("SELECT estado FROM cuenta WHERE id = 'c1'")
      .get() as any;
    expect(row.estado).toBe("activo");
  });

  it("contacto.estado defaults to activo", () => {
    testDb
      .prepare(
        "INSERT INTO contacto (id, nombre) VALUES ('co1', 'Test Contact')",
      )
      .run();
    const row = testDb
      .prepare("SELECT estado FROM contacto WHERE id = 'co1'")
      .get() as any;
    expect(row.estado).toBe("activo");
  });

  it("aprobacion_registro table exists", () => {
    const tables = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("aprobacion_registro");
  });

  it("aprobacion_registro enforces valid entidad_tipo", () => {
    expect(() =>
      testDb
        .prepare(
          `INSERT INTO aprobacion_registro (id, entidad_tipo, entidad_id, accion, actor_id, actor_rol, estado_nuevo)
           VALUES ('test', 'propuesta', 'x', 'creado', 'ae1', 'ae', 'pendiente_gerente')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("aprobacion_registro enforces valid accion", () => {
    expect(() =>
      testDb
        .prepare(
          `INSERT INTO aprobacion_registro (id, entidad_tipo, entidad_id, accion, actor_id, actor_rol, estado_nuevo)
           VALUES ('test', 'cuenta', 'x', 'deleted', 'ae1', 'ae', 'activo')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("indexes on cuenta(estado) and contacto(estado) exist", () => {
    const indexes = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r: any) => r.name);
    expect(indexes).toContain("idx_cuenta_estado");
    expect(indexes).toContain("idx_contacto_estado");
  });
});

// ---------------------------------------------------------------------------
// solicitar_cuenta
// ---------------------------------------------------------------------------

describe("solicitar_cuenta", () => {
  it("AE creates cuenta in pendiente_gerente", () => {
    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(solicitar_cuenta({ nombre: "Coca-Cola" }, ctx));
    expect(result.estado).toBe("pendiente_gerente");
    expect(result.cuenta_id).toBeTruthy();

    const row = testDb
      .prepare("SELECT * FROM cuenta WHERE id = ?")
      .get(result.cuenta_id) as any;
    expect(row.estado).toBe("pendiente_gerente");
    expect(row.creado_por).toBe("ae1");
  });

  it("Gerente creates cuenta in pendiente_director (assigns AE)", () => {
    const ctx = makeCtx("ger1", "gerente", ["ae1"]);
    const result = JSON.parse(
      solicitar_cuenta({ nombre: "Bimbo", ejecutivo_nombre: "AE One" }, ctx),
    );
    expect(result.estado).toBe("pendiente_director");

    const row = testDb
      .prepare("SELECT ae_id, gerente_id FROM cuenta WHERE id = ?")
      .get(result.cuenta_id) as any;
    expect(row.ae_id).toBe("ae1");
    expect(row.gerente_id).toBe("ger1");
  });

  it("Gerente requires ejecutivo_nombre", () => {
    const ctx = makeCtx("ger1", "gerente", ["ae1"]);
    const result = JSON.parse(solicitar_cuenta({ nombre: "Bimbo" }, ctx));
    expect(result.error).toContain("ejecutivo_nombre");
  });

  it("Director creates cuenta in pendiente_gerente (assigns Gerente)", () => {
    const ctx = makeCtx("dir1", "director", ["ger1"], ["ger1", "ae1"]);
    const result = JSON.parse(
      solicitar_cuenta(
        { nombre: "Unilever", gerente_nombre: "Gerente One" },
        ctx,
      ),
    );
    expect(result.estado).toBe("pendiente_gerente");

    const row = testDb
      .prepare("SELECT gerente_id, director_id, ae_id FROM cuenta WHERE id = ?")
      .get(result.cuenta_id) as any;
    expect(row.gerente_id).toBe("ger1");
    expect(row.director_id).toBe("dir1");
    expect(row.ae_id).toBeNull(); // AE assigned later by gerente
  });

  it("Director requires gerente_nombre", () => {
    const ctx = makeCtx("dir1", "director", ["ger1"], ["ger1", "ae1"]);
    const result = JSON.parse(solicitar_cuenta({ nombre: "X" }, ctx));
    expect(result.error).toContain("gerente_nombre");
  });

  it("VP creates cuenta in pendiente_director (assigns Director)", () => {
    const ctx = makeCtx("vp1", "vp");
    const result = JSON.parse(
      solicitar_cuenta(
        { nombre: "PepsiCo", director_nombre: "Director One" },
        ctx,
      ),
    );
    expect(result.estado).toBe("pendiente_director");

    const row = testDb
      .prepare("SELECT director_id, gerente_id, ae_id FROM cuenta WHERE id = ?")
      .get(result.cuenta_id) as any;
    expect(row.director_id).toBe("dir1");
    expect(row.gerente_id).toBeNull();
    expect(row.ae_id).toBeNull();
  });

  it("VP requires director_nombre", () => {
    const ctx = makeCtx("vp1", "vp");
    const result = JSON.parse(solicitar_cuenta({ nombre: "Y" }, ctx));
    expect(result.error).toContain("director_nombre");
  });

  it("rejects duplicate cuenta names", () => {
    const ctx = makeCtx("ae1", "ae");
    solicitar_cuenta({ nombre: "Coca-Cola" }, ctx);
    const result = JSON.parse(solicitar_cuenta({ nombre: "Coca-Cola" }, ctx));
    expect(result.error).toContain("Ya existe");
  });

  it("requires nombre", () => {
    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(solicitar_cuenta({}, ctx));
    expect(result.error).toContain("requerido");
  });

  it("logs creation in aprobacion_registro", () => {
    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(solicitar_cuenta({ nombre: "New Corp" }, ctx));
    const log = testDb
      .prepare("SELECT * FROM aprobacion_registro WHERE entidad_id = ?")
      .get(result.cuenta_id) as any;
    expect(log.accion).toBe("creado");
    expect(log.actor_id).toBe("ae1");
    expect(log.estado_nuevo).toBe("pendiente_gerente");
  });
});

// ---------------------------------------------------------------------------
// solicitar_contacto
// ---------------------------------------------------------------------------

describe("solicitar_contacto", () => {
  it("AE creates contacto in pendiente_gerente", () => {
    // Create an active cuenta first
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, ae_id, estado) VALUES ('c1', 'Acme', 'directo', 'ae1', 'activo')",
      )
      .run();
    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(
      solicitar_contacto({ nombre: "Juan Perez", cuenta_nombre: "Acme" }, ctx),
    );
    expect(result.estado).toBe("pendiente_gerente");
  });

  it("rejects non-existent cuenta", () => {
    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(
      solicitar_contacto({ nombre: "Juan", cuenta_nombre: "Nonexistent" }, ctx),
    );
    expect(result.error).toContain("No encontre");
  });

  it("rejects duplicate contacto on same cuenta", () => {
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, estado) VALUES ('c1', 'Acme', 'directo', 'activo')",
      )
      .run();
    const ctx = makeCtx("ae1", "ae");
    solicitar_contacto({ nombre: "Juan Perez", cuenta_nombre: "Acme" }, ctx);
    const result = JSON.parse(
      solicitar_contacto({ nombre: "Juan Perez", cuenta_nombre: "Acme" }, ctx),
    );
    expect(result.error).toContain("Ya existe");
  });
});

// ---------------------------------------------------------------------------
// aprobar_registro
// ---------------------------------------------------------------------------

describe("aprobar_registro", () => {
  it("gerente approves pendiente_gerente → pendiente_director", () => {
    const aeCtx = makeCtx("ae1", "ae");
    const created = JSON.parse(solicitar_cuenta({ nombre: "TestCo" }, aeCtx));

    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    const result = JSON.parse(
      aprobar_registro(
        { entidad_tipo: "cuenta", entidad_id: created.cuenta_id },
        gerCtx,
      ),
    );
    expect(result.estado_nuevo).toBe("pendiente_director");
  });

  it("director approves pendiente_director → activo_en_revision", () => {
    const aeCtx = makeCtx("ae1", "ae");
    const created = JSON.parse(solicitar_cuenta({ nombre: "TestCo" }, aeCtx));

    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    aprobar_registro(
      { entidad_tipo: "cuenta", entidad_id: created.cuenta_id },
      gerCtx,
    );

    const dirCtx = makeCtx("dir1", "director", ["ger1"], ["ger1", "ae1"]);
    const result = JSON.parse(
      aprobar_registro(
        { entidad_tipo: "cuenta", entidad_id: created.cuenta_id },
        dirCtx,
      ),
    );
    expect(result.estado_nuevo).toBe("activo_en_revision");

    const row = testDb
      .prepare("SELECT fecha_activacion FROM cuenta WHERE id = ?")
      .get(created.cuenta_id) as any;
    expect(row.fecha_activacion).toBeTruthy();
  });

  it("gerente assigns AE when approving director-created cuenta", () => {
    const dirCtx = makeCtx("dir1", "director", ["ger1"], ["ger1", "ae1"]);
    const created = JSON.parse(
      solicitar_cuenta(
        { nombre: "DirCo", gerente_nombre: "Gerente One" },
        dirCtx,
      ),
    );
    expect(created.estado).toBe("pendiente_gerente");

    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    const result = JSON.parse(
      aprobar_registro(
        {
          entidad_tipo: "cuenta",
          entidad_id: created.cuenta_id,
          ejecutivo_nombre: "AE One",
        },
        gerCtx,
      ),
    );
    expect(result.estado_nuevo).toBe("activo_en_revision"); // skips pendiente_director

    const row = testDb
      .prepare("SELECT ae_id FROM cuenta WHERE id = ?")
      .get(created.cuenta_id) as any;
    expect(row.ae_id).toBe("ae1");
  });

  it("gerente must provide ejecutivo_nombre for director-created cuenta", () => {
    const dirCtx = makeCtx("dir1", "director", ["ger1"], ["ger1", "ae1"]);
    const created = JSON.parse(
      solicitar_cuenta(
        { nombre: "DirCo2", gerente_nombre: "Gerente One" },
        dirCtx,
      ),
    );

    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    const result = JSON.parse(
      aprobar_registro(
        { entidad_tipo: "cuenta", entidad_id: created.cuenta_id },
        gerCtx,
      ),
    );
    expect(result.error).toContain("ejecutivo_nombre");
  });

  it("director assigns gerente when approving VP-created cuenta", () => {
    const vpCtx = makeCtx("vp1", "vp");
    const created = JSON.parse(
      solicitar_cuenta(
        { nombre: "VpCo", director_nombre: "Director One" },
        vpCtx,
      ),
    );
    expect(created.estado).toBe("pendiente_director");

    const dirCtx = makeCtx("dir1", "director", ["ger1"], ["ger1", "ae1"]);
    const result = JSON.parse(
      aprobar_registro(
        {
          entidad_tipo: "cuenta",
          entidad_id: created.cuenta_id,
          gerente_nombre: "Gerente One",
        },
        dirCtx,
      ),
    );
    expect(result.estado_nuevo).toBe("pendiente_gerente"); // cascades down

    const row = testDb
      .prepare("SELECT gerente_id FROM cuenta WHERE id = ?")
      .get(created.cuenta_id) as any;
    expect(row.gerente_id).toBe("ger1");
  });

  it("AE cannot approve", () => {
    const aeCtx = makeCtx("ae1", "ae");
    const created = JSON.parse(solicitar_cuenta({ nombre: "TestCo" }, aeCtx));

    const result = JSON.parse(
      aprobar_registro(
        { entidad_tipo: "cuenta", entidad_id: created.cuenta_id },
        aeCtx,
      ),
    );
    expect(result.error).toContain("No puedes aprobar");
  });

  it("gerente cannot approve pendiente_director", () => {
    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    const created = JSON.parse(
      solicitar_cuenta(
        { nombre: "TestCo", ejecutivo_nombre: "AE One" },
        gerCtx,
      ),
    );
    // Already at pendiente_director

    const result = JSON.parse(
      aprobar_registro(
        { entidad_tipo: "cuenta", entidad_id: created.cuenta_id },
        gerCtx,
      ),
    );
    expect(result.error).toContain("No puedes aprobar");
  });

  it("rejects non-existent entidad", () => {
    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    const result = JSON.parse(
      aprobar_registro(
        { entidad_tipo: "cuenta", entidad_id: "nonexistent" },
        gerCtx,
      ),
    );
    expect(result.error).toContain("No encontre");
  });

  it("rejects bogus entidad_tipo without touching SQL (B1 allowlist)", () => {
    // Defense against SQL injection via table-name interpolation. SQLite
    // can't bind table names — only an explicit allowlist is safe. The
    // injection candidates here would be DDL or expression payloads if the
    // value reached the prepared statement.
    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);

    for (const bogus of [
      "cuenta; DROP TABLE persona",
      "persona",
      "sqlite_master",
      "(SELECT 1)",
      "",
      null,
      undefined,
      123,
      { table: "cuenta" },
    ]) {
      const result = JSON.parse(
        aprobar_registro(
          { entidad_tipo: bogus as any, entidad_id: "anything" },
          gerCtx,
        ),
      );
      expect(result.error).toBeDefined();
      // Either the missing-args check or the allowlist check fires; both are
      // acceptable rejections — neither path constructs SQL with the input.
      expect(typeof result.error).toBe("string");
    }

    // Persona table must still exist (no DROP executed).
    const persona = testDb
      .prepare("SELECT name FROM sqlite_master WHERE name = 'persona'")
      .get();
    expect(persona).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// rechazar_registro
// ---------------------------------------------------------------------------

describe("rechazar_registro", () => {
  it("gerente rejects pendiente_gerente → deletes", () => {
    const aeCtx = makeCtx("ae1", "ae");
    const created = JSON.parse(solicitar_cuenta({ nombre: "BadCo" }, aeCtx));

    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    const result = JSON.parse(
      rechazar_registro(
        {
          entidad_tipo: "cuenta",
          entidad_id: created.cuenta_id,
          motivo: "Duplicado",
        },
        gerCtx,
      ),
    );
    expect(result.mensaje).toContain("rechazada y eliminada");

    const row = testDb
      .prepare("SELECT * FROM cuenta WHERE id = ?")
      .get(created.cuenta_id);
    expect(row).toBeUndefined();
  });

  it("cannot reject already active records", () => {
    // Insert a directly active cuenta
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, estado) VALUES ('active1', 'GoodCo', 'directo', 'activo')",
      )
      .run();

    const vpCtx = makeCtx("vp1", "vp");
    const result = JSON.parse(
      rechazar_registro(
        { entidad_tipo: "cuenta", entidad_id: "active1" },
        vpCtx,
      ),
    );
    expect(result.error).toContain("Solo se pueden rechazar");
  });

  it("logs rejection in aprobacion_registro", () => {
    const aeCtx = makeCtx("ae1", "ae");
    const created = JSON.parse(solicitar_cuenta({ nombre: "RejectCo" }, aeCtx));

    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    rechazar_registro(
      {
        entidad_tipo: "cuenta",
        entidad_id: created.cuenta_id,
        motivo: "Duplicate",
      },
      gerCtx,
    );

    const logs = testDb
      .prepare(
        "SELECT * FROM aprobacion_registro WHERE entidad_id = ? ORDER BY fecha",
      )
      .all(created.cuenta_id) as any[];
    expect(logs.length).toBe(2); // creado + rechazado
    expect(logs[1].accion).toBe("rechazado");
    expect(logs[1].motivo).toBe("Duplicate");
  });
});

// ---------------------------------------------------------------------------
// consultar_pendientes
// ---------------------------------------------------------------------------

describe("consultar_pendientes", () => {
  it("gerente sees pendiente_gerente from team", () => {
    const aeCtx = makeCtx("ae1", "ae");
    solicitar_cuenta({ nombre: "PendingCo" }, aeCtx);

    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    const result = JSON.parse(consultar_pendientes({}, gerCtx));
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.pendientes_cuentas[0].estado).toBe("pendiente_gerente");
  });

  it("director sees pendiente_director", () => {
    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    solicitar_cuenta(
      { nombre: "DirPending", ejecutivo_nombre: "AE One" },
      gerCtx,
    );

    const dirCtx = makeCtx("dir1", "director", ["ger1"], ["ger1", "ae1"]);
    const result = JSON.parse(consultar_pendientes({}, dirCtx));
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.pendientes_cuentas[0].estado).toBe("pendiente_director");
  });

  it("AE cannot consultar_pendientes", () => {
    const aeCtx = makeCtx("ae1", "ae");
    const result = JSON.parse(consultar_pendientes({}, aeCtx));
    expect(result.error).toContain("Solo gerentes");
  });

  it("VP sees all pending states", () => {
    const aeCtx = makeCtx("ae1", "ae");
    solicitar_cuenta({ nombre: "AePending" }, aeCtx);

    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    solicitar_cuenta(
      { nombre: "GerPending", ejecutivo_nombre: "AE One" },
      gerCtx,
    );

    const vpCtx = makeCtx("vp1", "vp");
    const result = JSON.parse(consultar_pendientes({}, vpCtx));
    expect(result.total).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// impugnar_registro
// ---------------------------------------------------------------------------

describe("impugnar_registro", () => {
  it("challenges activo_en_revision → disputado", () => {
    // Create a cuenta that reaches activo_en_revision via AE full chain
    const aeCtx = makeCtx("ae1", "ae");
    const created = JSON.parse(
      solicitar_cuenta({ nombre: "ChallengeCo" }, aeCtx),
    );

    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    aprobar_registro(
      { entidad_tipo: "cuenta", entidad_id: created.cuenta_id },
      gerCtx,
    );

    const dirCtx = makeCtx("dir1", "director", ["ger1"], ["ger1", "ae1"]);
    aprobar_registro(
      { entidad_tipo: "cuenta", entidad_id: created.cuenta_id },
      dirCtx,
    );

    // Now challenge it
    const result = JSON.parse(
      impugnar_registro(
        {
          entidad_tipo: "cuenta",
          entidad_id: created.cuenta_id,
          motivo: "Duplicado de otra cuenta",
        },
        aeCtx,
      ),
    );
    expect(result.estado_nuevo).toBe("disputado");

    const row = testDb
      .prepare("SELECT estado FROM cuenta WHERE id = ?")
      .get(created.cuenta_id) as any;
    expect(row.estado).toBe("disputado");
  });

  it("cannot challenge non activo_en_revision records", () => {
    const aeCtx = makeCtx("ae1", "ae");
    const created = JSON.parse(
      solicitar_cuenta({ nombre: "PendingCo" }, aeCtx),
    );
    // AE creates in pendiente_gerente

    const result = JSON.parse(
      impugnar_registro(
        {
          entidad_tipo: "cuenta",
          entidad_id: created.cuenta_id,
          motivo: "test",
        },
        aeCtx,
      ),
    );
    expect(result.error).toContain("Solo se pueden impugnar");
  });

  it("requires motivo", () => {
    const aeCtx = makeCtx("ae1", "ae");
    const result = JSON.parse(
      impugnar_registro({ entidad_tipo: "cuenta", entidad_id: "x" }, aeCtx),
    );
    expect(result.error).toContain("motivo");
  });

  it("rejects challenge after 24h window", () => {
    // Insert a cuenta directly in activo_en_revision with old fecha_activacion
    const pastDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, estado, creado_por, fecha_activacion) VALUES ('old1', 'OldCo', 'directo', 'activo_en_revision', 'ae1', ?)",
      )
      .run(pastDate);

    const aeCtx = makeCtx("ae1", "ae");
    const result = JSON.parse(
      impugnar_registro(
        {
          entidad_tipo: "cuenta",
          entidad_id: "old1",
          motivo: "Too late",
        },
        aeCtx,
      ),
    );
    expect(result.error).toContain("24h ha expirado");
  });
});

// ---------------------------------------------------------------------------
// Full approval chain: AE → Gerente → Director → activo_en_revision → activo
// ---------------------------------------------------------------------------

describe("full approval chain", () => {
  it("AE → Gerente → Director → activo_en_revision", () => {
    const aeCtx = makeCtx("ae1", "ae");
    const created = JSON.parse(
      solicitar_cuenta({ nombre: "FullChainCo" }, aeCtx),
    );
    expect(created.estado).toBe("pendiente_gerente");

    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    const approved1 = JSON.parse(
      aprobar_registro(
        { entidad_tipo: "cuenta", entidad_id: created.cuenta_id },
        gerCtx,
      ),
    );
    expect(approved1.estado_nuevo).toBe("pendiente_director");

    const dirCtx = makeCtx("dir1", "director", ["ger1"], ["ger1", "ae1"]);
    const approved2 = JSON.parse(
      aprobar_registro(
        { entidad_tipo: "cuenta", entidad_id: created.cuenta_id },
        dirCtx,
      ),
    );
    expect(approved2.estado_nuevo).toBe("activo_en_revision");

    const row = testDb
      .prepare("SELECT estado, fecha_activacion FROM cuenta WHERE id = ?")
      .get(created.cuenta_id) as any;
    expect(row.estado).toBe("activo_en_revision");
    expect(row.fecha_activacion).toBeTruthy();
  });

  it("VP full chain: VP → Dir assigns Ger → Ger assigns AE → activo_en_revision", () => {
    const vpCtx = makeCtx("vp1", "vp");
    const created = JSON.parse(
      solicitar_cuenta(
        { nombre: "VpFullCo", director_nombre: "Director One" },
        vpCtx,
      ),
    );
    expect(created.estado).toBe("pendiente_director");

    // Director approves + assigns gerente
    const dirCtx = makeCtx("dir1", "director", ["ger1"], ["ger1", "ae1"]);
    const step1 = JSON.parse(
      aprobar_registro(
        {
          entidad_tipo: "cuenta",
          entidad_id: created.cuenta_id,
          gerente_nombre: "Gerente One",
        },
        dirCtx,
      ),
    );
    expect(step1.estado_nuevo).toBe("pendiente_gerente");

    // Gerente approves + assigns AE
    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    const step2 = JSON.parse(
      aprobar_registro(
        {
          entidad_tipo: "cuenta",
          entidad_id: created.cuenta_id,
          ejecutivo_nombre: "AE One",
        },
        gerCtx,
      ),
    );
    expect(step2.estado_nuevo).toBe("activo_en_revision");

    const row = testDb
      .prepare(
        "SELECT ae_id, gerente_id, director_id, estado FROM cuenta WHERE id = ?",
      )
      .get(created.cuenta_id) as any;
    expect(row.ae_id).toBe("ae1");
    expect(row.gerente_id).toBe("ger1");
    expect(row.director_id).toBe("dir1");
    expect(row.estado).toBe("activo_en_revision");
  });

  it("dispute resolution: challenge → director resolves → activo", () => {
    // Get a cuenta to activo_en_revision via AE chain
    const aeCtx = makeCtx("ae1", "ae");
    const created = JSON.parse(
      solicitar_cuenta({ nombre: "DisputeCo" }, aeCtx),
    );

    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    aprobar_registro(
      { entidad_tipo: "cuenta", entidad_id: created.cuenta_id },
      gerCtx,
    );

    const dirCtx = makeCtx("dir1", "director", ["ger1"], ["ger1", "ae1"]);
    aprobar_registro(
      { entidad_tipo: "cuenta", entidad_id: created.cuenta_id },
      dirCtx,
    );

    // Challenge
    impugnar_registro(
      {
        entidad_tipo: "cuenta",
        entidad_id: created.cuenta_id,
        motivo: "Duplicado",
      },
      aeCtx,
    );

    // Director resolves by approving
    const resolved = JSON.parse(
      aprobar_registro(
        { entidad_tipo: "cuenta", entidad_id: created.cuenta_id },
        dirCtx,
      ),
    );
    expect(resolved.estado_nuevo).toBe("activo");
  });

  it("dispute resolution: challenge → director rejects → deleted", () => {
    const aeCtx = makeCtx("ae1", "ae");
    const created = JSON.parse(
      solicitar_cuenta({ nombre: "RejectDisputeCo" }, aeCtx),
    );

    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    aprobar_registro(
      { entidad_tipo: "cuenta", entidad_id: created.cuenta_id },
      gerCtx,
    );

    const dirCtx = makeCtx("dir1", "director", ["ger1"], ["ger1", "ae1"]);
    aprobar_registro(
      { entidad_tipo: "cuenta", entidad_id: created.cuenta_id },
      dirCtx,
    );

    impugnar_registro(
      {
        entidad_tipo: "cuenta",
        entidad_id: created.cuenta_id,
        motivo: "Is a duplicate",
      },
      aeCtx,
    );

    const rejected = JSON.parse(
      rechazar_registro(
        {
          entidad_tipo: "cuenta",
          entidad_id: created.cuenta_id,
          motivo: "Confirmed duplicate",
        },
        dirCtx,
      ),
    );
    expect(rejected.mensaje).toContain("eliminada");

    const row = testDb
      .prepare("SELECT * FROM cuenta WHERE id = ?")
      .get(created.cuenta_id);
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// estadoFilter
// ---------------------------------------------------------------------------

describe("estadoFilter", () => {
  it("returns SQL fragment with params", () => {
    const ctx = makeCtx("ae1", "ae");
    const filter = estadoFilter(ctx, "c");
    expect(filter.where).toContain("c.estado");
    expect(filter.where).toContain("c.creado_por");
    expect(filter.params).toEqual(["ae1"]);
  });

  it("hides pending records from other users", () => {
    // AE1 creates a pending cuenta
    const aeCtx = makeCtx("ae1", "ae");
    solicitar_cuenta({ nombre: "HiddenCo" }, aeCtx);

    // AE2 should not see it
    testDb
      .prepare(
        "INSERT INTO persona (id, nombre, rol, reporta_a) VALUES ('ae2', 'AE Two', 'ae', 'ger1')",
      )
      .run();

    const ae2Filter = estadoFilter(makeCtx("ae2", "ae"), "c");
    const rows = testDb
      .prepare(
        `SELECT c.nombre FROM cuenta c WHERE c.nombre LIKE '%HiddenCo%' ${ae2Filter.where}`,
      )
      .all(...ae2Filter.params) as any[];
    expect(rows.length).toBe(0);
  });

  it("shows pending records to their creator", () => {
    const aeCtx = makeCtx("ae1", "ae");
    solicitar_cuenta({ nombre: "MyPendingCo" }, aeCtx);

    const aeFilter = estadoFilter(aeCtx, "c");
    const rows = testDb
      .prepare(
        `SELECT c.nombre FROM cuenta c WHERE c.nombre LIKE '%MyPendingCo%' ${aeFilter.where}`,
      )
      .all(...aeFilter.params) as any[];
    expect(rows.length).toBe(1);
  });

  it("shows activo records to everyone", () => {
    // Insert a directly active cuenta
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, estado) VALUES ('act1', 'ActiveCo', 'directo', 'activo')",
      )
      .run();

    const aeFilter = estadoFilter(makeCtx("ae1", "ae"), "c");
    const rows = testDb
      .prepare(
        `SELECT c.nombre FROM cuenta c WHERE c.nombre LIKE '%ActiveCo%' ${aeFilter.where}`,
      )
      .all(...aeFilter.params) as any[];
    expect(rows.length).toBe(1);
  });

  it("shows activo_en_revision to everyone", () => {
    // Insert a cuenta in activo_en_revision
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, estado) VALUES ('rev1', 'ReviewCo', 'directo', 'activo_en_revision')",
      )
      .run();

    const aeFilter = estadoFilter(makeCtx("ae1", "ae"), "c");
    const rows = testDb
      .prepare(
        `SELECT c.nombre FROM cuenta c WHERE c.nombre LIKE '%ReviewCo%' ${aeFilter.where}`,
      )
      .all(...aeFilter.params) as any[];
    expect(rows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Contacto approval (basic)
// ---------------------------------------------------------------------------

describe("contacto approval", () => {
  beforeEach(() => {
    testDb
      .prepare(
        "INSERT INTO cuenta (id, nombre, tipo, ae_id, estado) VALUES ('c1', 'TestCuenta', 'directo', 'ae1', 'activo')",
      )
      .run();
  });

  it("AE creates contacto in pendiente_gerente", () => {
    const aeCtx = makeCtx("ae1", "ae");
    const result = JSON.parse(
      solicitar_contacto(
        { nombre: "Maria Garcia", cuenta_nombre: "TestCuenta", rol: "decisor" },
        aeCtx,
      ),
    );
    expect(result.estado).toBe("pendiente_gerente");
  });

  it("full chain works for contacto", () => {
    const aeCtx = makeCtx("ae1", "ae");
    const created = JSON.parse(
      solicitar_contacto(
        { nombre: "Maria Garcia", cuenta_nombre: "TestCuenta" },
        aeCtx,
      ),
    );

    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    aprobar_registro(
      { entidad_tipo: "contacto", entidad_id: created.contacto_id },
      gerCtx,
    );

    const dirCtx = makeCtx("dir1", "director", ["ger1"], ["ger1", "ae1"]);
    const approved = JSON.parse(
      aprobar_registro(
        { entidad_tipo: "contacto", entidad_id: created.contacto_id },
        dirCtx,
      ),
    );
    expect(approved.estado_nuevo).toBe("activo_en_revision");
  });

  it("rechazar_registro works for contacto", () => {
    const aeCtx = makeCtx("ae1", "ae");
    const created = JSON.parse(
      solicitar_contacto(
        { nombre: "Bad Contact", cuenta_nombre: "TestCuenta" },
        aeCtx,
      ),
    );

    const gerCtx = makeCtx("ger1", "gerente", ["ae1"]);
    rechazar_registro(
      {
        entidad_tipo: "contacto",
        entidad_id: created.contacto_id,
        motivo: "Wrong person",
      },
      gerCtx,
    );

    const row = testDb
      .prepare("SELECT * FROM contacto WHERE id = ?")
      .get(created.contacto_id);
    expect(row).toBeUndefined();
  });
});
