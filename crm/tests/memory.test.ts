/**
 * Memory Service Tests
 *
 * Tests SQLite backend, Hindsight backend (mocked), and factory logic.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

// Mock logger
const noop = () => {};
const noopLogger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  child: () => noopLogger,
};
vi.mock("../src/logger.js", () => ({ logger: noopLogger }));

// Use in-memory DB for testing
let testDb: InstanceType<typeof Database>;

vi.mock("../src/db.js", () => ({
  getDatabase: () => testDb,
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setupTestDb() {
  testDb = new Database(":memory:");
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS persona (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      rol TEXT NOT NULL
    );
    INSERT INTO persona VALUES ('ae1', 'Test AE', 'ae');

    CREATE TABLE IF NOT EXISTS crm_memories (
      id TEXT PRIMARY KEY,
      persona_id TEXT REFERENCES persona(id),
      banco TEXT NOT NULL CHECK(banco IN ('crm-sales','crm-accounts','crm-team')),
      contenido TEXT NOT NULL,
      etiquetas TEXT,
      fecha_creacion TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_crm_memories_persona ON crm_memories(persona_id);
    CREATE INDEX IF NOT EXISTS idx_crm_memories_banco ON crm_memories(banco);
  `);
}

// ---------------------------------------------------------------------------
// SqliteMemoryBackend
// ---------------------------------------------------------------------------

describe("SqliteMemoryBackend", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => testDb?.close());

  it("retains and recalls a memory", async () => {
    const { SqliteMemoryBackend } =
      await import("../src/memory/sqlite-backend.js");
    const backend = new SqliteMemoryBackend();

    await backend.retain("Client X prefers morning calls", {
      bank: "crm-sales",
      personaId: "ae1",
      tags: ["preference"],
    });

    const results = await backend.recall("morning", {
      bank: "crm-sales",
      maxResults: 5,
    });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Client X prefers morning calls");
  });

  it("filters by bank", async () => {
    const { SqliteMemoryBackend } =
      await import("../src/memory/sqlite-backend.js");
    const backend = new SqliteMemoryBackend();

    await backend.retain("Sales pattern", {
      bank: "crm-sales",
      personaId: "ae1",
    });
    await backend.retain("Team pattern", {
      bank: "crm-team",
      personaId: "ae1",
    });

    const salesResults = await backend.recall("pattern", {
      bank: "crm-sales",
    });
    expect(salesResults).toHaveLength(1);
    expect(salesResults[0].content).toBe("Sales pattern");

    const teamResults = await backend.recall("pattern", {
      bank: "crm-team",
    });
    expect(teamResults).toHaveLength(1);
    expect(teamResults[0].content).toBe("Team pattern");
  });

  it("returns empty for no match", async () => {
    const { SqliteMemoryBackend } =
      await import("../src/memory/sqlite-backend.js");
    const backend = new SqliteMemoryBackend();

    const results = await backend.recall("nonexistent", {
      bank: "crm-sales",
    });
    expect(results).toHaveLength(0);
  });

  it("reflect returns empty string (no synthesis)", async () => {
    const { SqliteMemoryBackend } =
      await import("../src/memory/sqlite-backend.js");
    const backend = new SqliteMemoryBackend();

    const reflection = await backend.reflect("anything", {
      bank: "crm-sales",
    });
    expect(reflection).toBe("");
  });

  it("isHealthy returns true when DB is accessible", async () => {
    const { SqliteMemoryBackend } =
      await import("../src/memory/sqlite-backend.js");
    const backend = new SqliteMemoryBackend();

    expect(await backend.isHealthy()).toBe(true);
  });

  it("stores tags as JSON", async () => {
    const { SqliteMemoryBackend } =
      await import("../src/memory/sqlite-backend.js");
    const backend = new SqliteMemoryBackend();

    await backend.retain("Tagged memory", {
      bank: "crm-sales",
      personaId: "ae1",
      tags: ["objection", "pricing"],
    });

    const row = testDb
      .prepare("SELECT etiquetas FROM crm_memories LIMIT 1")
      .get() as { etiquetas: string };
    expect(JSON.parse(row.etiquetas)).toEqual(["objection", "pricing"]);
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe("Memory factory", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => {
    testDb?.close();
    vi.unstubAllEnvs();
  });

  it("returns SQLite backend when HINDSIGHT_ENABLED is not set", async () => {
    const { initMemoryService, resetMemoryService } =
      await import("../src/memory/index.js");
    resetMemoryService();

    const service = await initMemoryService();
    expect(service.backend).toBe("sqlite");
    resetMemoryService();
  });

  it("getMemoryService returns SQLite by default", async () => {
    const { getMemoryService, resetMemoryService } =
      await import("../src/memory/index.js");
    resetMemoryService();

    const service = getMemoryService();
    expect(service.backend).toBe("sqlite");
    resetMemoryService();
  });
});

// ---------------------------------------------------------------------------
// HindsightBackend (mocked)
// ---------------------------------------------------------------------------

describe("HindsightMemoryBackend", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retains an observation via Hindsight API", async () => {
    const { HindsightMemoryBackend } =
      await import("../src/memory/hindsight-backend.js");

    const requests: { url: string; body: unknown }[] = [];
    globalThis.fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        requests.push({
          url: urlStr,
          body: init?.body ? JSON.parse(init.body as string) : null,
        });
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      },
    ) as typeof globalThis.fetch;

    const backend = new HindsightMemoryBackend("http://test:8888");
    await backend.retain("Test observation", {
      bank: "crm-sales",
      personaId: "ae1",
      tags: ["test"],
    });

    // First call: upsertBank (lazy init), second call: retain
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const retainReq = requests.find((r) => r.url.includes("/retain"));
    expect(retainReq).toBeDefined();
    expect(retainReq!.body).toMatchObject({
      observation: "Test observation",
      tags: ["test"],
    });
  });

  it("returns empty array when circuit is open", async () => {
    const { HindsightMemoryBackend } =
      await import("../src/memory/hindsight-backend.js");

    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      throw new Error("Connection refused");
    }) as typeof globalThis.fetch;

    const backend = new HindsightMemoryBackend("http://test:8888");

    // Trip the circuit (3 retain failures)
    for (let i = 0; i < 3; i++) {
      await backend.retain("fail", { bank: "crm-sales", personaId: "ae1" });
    }

    // Reset count — next recall should NOT hit API
    callCount = 0;
    const results = await backend.recall("test", { bank: "crm-sales" });
    expect(results).toEqual([]);
    expect(callCount).toBe(0);
  });

  it("isHealthy returns true for healthy response", async () => {
    const { HindsightMemoryBackend } =
      await import("../src/memory/hindsight-backend.js");

    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ status: "healthy" }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;

    const backend = new HindsightMemoryBackend("http://test:8888");
    expect(await backend.isHealthy()).toBe(true);
  });

  it("isHealthy returns false on error", async () => {
    const { HindsightMemoryBackend } =
      await import("../src/memory/hindsight-backend.js");

    globalThis.fetch = vi.fn(async () => {
      throw new Error("Connection refused");
    }) as typeof globalThis.fetch;

    const backend = new HindsightMemoryBackend("http://test:8888");
    expect(await backend.isHealthy()).toBe(false);
  });
});
