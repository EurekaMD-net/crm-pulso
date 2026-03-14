/**
 * Memory Tool Handler Tests
 *
 * Tests guardar_observacion, buscar_memoria, reflexionar_memoria.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

// Mock logger — use vi.hoisted() to avoid hoisting issues
const { noopLogger } = vi.hoisted(() => {
  const noop = () => {};
  const noopLogger: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => noopLogger,
  };
  return { noopLogger };
});
vi.mock("../src/logger.js", () => ({ logger: noopLogger }));

// In-memory DB
let testDb: InstanceType<typeof Database>;
vi.mock("../src/db.js", () => ({
  getDatabase: () => testDb,
}));

// Force SQLite backend (no Hindsight)
vi.stubEnv("HINDSIGHT_ENABLED", "false");

import {
  guardar_observacion,
  buscar_memoria,
  reflexionar_memoria,
} from "../src/tools/memoria.js";
import { resetMemoryService } from "../src/memory/index.js";
import type { ToolContext } from "../src/tools/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(
  rol: "ae" | "gerente" | "director" | "vp",
  id = "p1",
): ToolContext {
  return {
    persona_id: id,
    rol,
    team_ids: ["p2", "p3"],
    full_team_ids: ["p2", "p3", "p4"],
  };
}

function setupDb() {
  testDb = new Database(":memory:");
  testDb.exec(`
    CREATE TABLE persona (id TEXT PRIMARY KEY, nombre TEXT, rol TEXT);
    INSERT INTO persona VALUES ('p1', 'Test', 'ae');

    CREATE TABLE crm_memories (
      id TEXT PRIMARY KEY,
      persona_id TEXT REFERENCES persona(id),
      banco TEXT NOT NULL CHECK(banco IN ('crm-sales','crm-accounts','crm-team')),
      contenido TEXT NOT NULL,
      etiquetas TEXT,
      fecha_creacion TEXT DEFAULT (datetime('now'))
    );
  `);
  resetMemoryService();
}

// ---------------------------------------------------------------------------
// guardar_observacion
// ---------------------------------------------------------------------------

describe("guardar_observacion", () => {
  beforeEach(() => setupDb());
  afterEach(() => testDb?.close());

  it("stores an observation in the default bank (ventas)", async () => {
    const result = JSON.parse(
      await guardar_observacion(
        { contenido: "Client prefers morning meetings" },
        makeCtx("ae"),
      ),
    );
    expect(result.mensaje).toContain("ventas");

    const row = testDb.prepare("SELECT * FROM crm_memories").get() as Record<
      string,
      unknown
    >;
    expect(row.contenido).toBe("Client prefers morning meetings");
    expect(row.banco).toBe("crm-sales");
    expect(row.persona_id).toBe("p1");
  });

  it("stores in specified bank", async () => {
    const result = JSON.parse(
      await guardar_observacion(
        { contenido: "Team works well on Tuesdays", banco: "equipo" },
        makeCtx("gerente"),
      ),
    );
    expect(result.mensaje).toContain("equipo");

    const row = testDb
      .prepare("SELECT banco FROM crm_memories")
      .get() as Record<string, unknown>;
    expect(row.banco).toBe("crm-team");
  });

  it("stores tags", async () => {
    await guardar_observacion(
      {
        contenido: "Test",
        etiquetas: ["price", "objection"],
      },
      makeCtx("ae"),
    );

    const row = testDb
      .prepare("SELECT etiquetas FROM crm_memories")
      .get() as Record<string, unknown>;
    expect(JSON.parse(row.etiquetas as string)).toEqual(["price", "objection"]);
  });

  it("returns error when contenido is missing", async () => {
    const result = JSON.parse(await guardar_observacion({}, makeCtx("ae")));
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// buscar_memoria
// ---------------------------------------------------------------------------

describe("buscar_memoria", () => {
  beforeEach(() => setupDb());
  afterEach(() => testDb?.close());

  it("returns matching memories", async () => {
    await guardar_observacion(
      { contenido: "Client X prefers budget proposals" },
      makeCtx("ae"),
    );

    const result = JSON.parse(
      await buscar_memoria({ consulta: "budget" }, makeCtx("ae")),
    );
    expect(result.resultados).toHaveLength(1);
    expect(result.resultados[0].contenido).toContain("budget");
  });

  it("returns empty for no match", async () => {
    const result = JSON.parse(
      await buscar_memoria({ consulta: "nonexistent" }, makeCtx("ae")),
    );
    expect(result.resultados).toHaveLength(0);
  });

  it("AE cannot search non-ventas banks", async () => {
    const result = JSON.parse(
      await buscar_memoria(
        { consulta: "test", banco: "equipo" },
        makeCtx("ae"),
      ),
    );
    expect(result.error).toBeDefined();
    expect(result.error).toContain("ventas");
  });

  it("gerente can search any bank", async () => {
    await guardar_observacion(
      { contenido: "Team insight", banco: "equipo" },
      makeCtx("gerente"),
    );

    const result = JSON.parse(
      await buscar_memoria(
        { consulta: "insight", banco: "equipo" },
        makeCtx("gerente"),
      ),
    );
    expect(result.resultados).toHaveLength(1);
  });

  it("returns error when consulta is missing", async () => {
    const result = JSON.parse(await buscar_memoria({}, makeCtx("ae")));
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// reflexionar_memoria
// ---------------------------------------------------------------------------

describe("reflexionar_memoria", () => {
  beforeEach(() => setupDb());
  afterEach(() => testDb?.close());

  it("returns empty message with SQLite backend (no synthesis)", async () => {
    const result = JSON.parse(
      await reflexionar_memoria(
        { tema: "pricing strategies" },
        makeCtx("gerente"),
      ),
    );
    // SQLite backend returns empty string → tool returns "no hay suficientes"
    expect(result.mensaje).toContain("No hay suficientes");
  });

  it("returns error when tema is missing", async () => {
    const result = JSON.parse(
      await reflexionar_memoria({}, makeCtx("gerente")),
    );
    expect(result.error).toBeDefined();
  });
});
