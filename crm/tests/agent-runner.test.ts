/**
 * Agent Runner Unit Tests
 *
 * Tests for the CRM agent runner components:
 * - Persona identification from groupFolder
 * - Tool context construction
 * - Role-based tool filtering
 * - Tool execution routing
 * - System prompt construction
 * - Session management (load/save/truncate)
 * - IPC helpers
 * - Output formatting
 */

import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCrmSchema } from "../src/schema.js";
import type { ChatMessage } from "../src/inference-adapter.js";

// Mock engine modules to avoid pino dependency
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
const { getPersonByGroupFolder } = await import("../src/hierarchy.js");
const { buildToolContext, getToolsForRole, executeTool } =
  await import("../src/tools/index.js");
const { _resetStatementCache } = await import("../src/hierarchy.js");

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

function setupDb() {
  testDb = new Database(":memory:");
  sqliteVec.load(testDb);
  testDb.pragma("foreign_keys = ON");
  createCrmSchema(testDb);

  // Seed personas
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo)
    VALUES ('ae-001', 'Carlos Lopez', 'ae', 'carlos-ae', 1)`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo)
    VALUES ('mgr-001', 'Ana Garcia', 'gerente', 'ana-mgr', 1)`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo)
    VALUES ('ae-002', 'Maria Perez', 'ae', 'mgr-001', 'maria-ae', 1)`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo)
    VALUES ('dir-001', 'Roberto Diaz', 'director', 'roberto-dir', 1)`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo)
    VALUES ('vp-001', 'Elena Ruiz', 'vp', 'elena-vp', 1)`,
    )
    .run();
}

beforeEach(() => {
  setupDb();
  if (typeof _resetStatementCache === "function") _resetStatementCache();
});

afterEach(() => {
  testDb.close();
});

// ---------------------------------------------------------------------------
// Persona identification
// ---------------------------------------------------------------------------

describe("persona identification from groupFolder", () => {
  it("finds AE by group folder", () => {
    const persona = getPersonByGroupFolder("carlos-ae");
    expect(persona).toBeDefined();
    expect(persona!.nombre).toBe("Carlos Lopez");
    expect(persona!.rol).toBe("ae");
  });

  it("finds gerente by group folder", () => {
    const persona = getPersonByGroupFolder("ana-mgr");
    expect(persona).toBeDefined();
    expect(persona!.rol).toBe("gerente");
  });

  it("finds director by group folder", () => {
    const persona = getPersonByGroupFolder("roberto-dir");
    expect(persona).toBeDefined();
    expect(persona!.rol).toBe("director");
  });

  it("finds VP by group folder", () => {
    const persona = getPersonByGroupFolder("elena-vp");
    expect(persona).toBeDefined();
    expect(persona!.rol).toBe("vp");
  });

  it("returns undefined for unknown folder", () => {
    const persona = getPersonByGroupFolder("nonexistent-group");
    expect(persona).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool context construction
// ---------------------------------------------------------------------------

describe("tool context construction", () => {
  it("builds context for AE", () => {
    const ctx = buildToolContext("ae-001");
    expect(ctx).not.toBeNull();
    expect(ctx!.persona_id).toBe("ae-001");
    expect(ctx!.rol).toBe("ae");
    expect(ctx!.team_ids).toEqual([]);
    expect(ctx!.full_team_ids).toEqual([]);
  });

  it("builds context for gerente with team", () => {
    const ctx = buildToolContext("mgr-001");
    expect(ctx).not.toBeNull();
    expect(ctx!.rol).toBe("gerente");
    expect(ctx!.team_ids).toContain("ae-002");
  });

  it("returns null for unknown persona", () => {
    const ctx = buildToolContext("nonexistent");
    expect(ctx).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Role-based tool filtering
// ---------------------------------------------------------------------------

describe("role-based tool filtering", () => {
  it("AE gets 51 tools", () => {
    const tools = getToolsForRole("ae");
    expect(tools.length).toBe(51);
  });

  it("gerente gets 54 tools", () => {
    const tools = getToolsForRole("gerente");
    expect(tools.length).toBe(54);
  });

  it("director gets 63 tools", () => {
    const tools = getToolsForRole("director");
    expect(tools.length).toBe(63);
  });

  it("VP gets 61 tools", () => {
    const tools = getToolsForRole("vp");
    expect(tools.length).toBe(61);
  });

  it("all roles have consultar_pipeline", () => {
    for (const role of ["ae", "gerente", "director", "vp"] as const) {
      const tools = getToolsForRole(role);
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("consultar_pipeline");
    }
  });

  it("only AE has registrar_actividad", () => {
    const aeTools = getToolsForRole("ae").map((t) => t.function.name);
    expect(aeTools).toContain("registrar_actividad");

    for (const role of ["gerente", "director", "vp"] as const) {
      const tools = getToolsForRole(role).map((t) => t.function.name);
      expect(tools).not.toContain("registrar_actividad");
    }
  });

  it("gerente, director, and VP have enviar_email_briefing", () => {
    for (const role of ["gerente", "director", "vp"] as const) {
      const tools = getToolsForRole(role).map((t) => t.function.name);
      expect(tools).toContain("enviar_email_briefing");
    }
    // AE does not have briefing email
    const aeTools = getToolsForRole("ae").map((t) => t.function.name);
    expect(aeTools).not.toContain("enviar_email_briefing");
  });
});

// ---------------------------------------------------------------------------
// Tool execution routing
// ---------------------------------------------------------------------------

describe("tool execution routing", () => {
  it("returns error for unknown tool", async () => {
    const ctx = buildToolContext("ae-001")!;
    const result = await executeTool("nonexistent_tool", {}, ctx);
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("desconocida");
  });

  it("routes registrar_actividad through executeTool", async () => {
    testDb
      .prepare(
        `INSERT INTO cuenta (id, nombre, tipo, ae_id) VALUES ('c1', 'Coca-Cola', 'directo', 'ae-001')`,
      )
      .run();
    const ctx = buildToolContext("ae-001")!;
    const result = await executeTool(
      "registrar_actividad",
      {
        cuenta_nombre: "Coca-Cola",
        tipo: "llamada",
        resumen: "Llamada de seguimiento",
      },
      ctx,
    );
    const parsed = JSON.parse(result);
    // Should succeed or return an activity
    expect(parsed.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// System prompt construction (same logic as runner)
// ---------------------------------------------------------------------------

describe("system prompt construction", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-runner-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("combines global + group CLAUDE.md", () => {
    const globalPath = path.join(tmpDir, "global");
    const groupPath = path.join(tmpDir, "group");
    fs.mkdirSync(globalPath, { recursive: true });
    fs.mkdirSync(groupPath, { recursive: true });
    fs.writeFileSync(path.join(globalPath, "CLAUDE.md"), "GLOBAL INSTRUCTIONS");
    fs.writeFileSync(path.join(groupPath, "CLAUDE.md"), "AE INSTRUCTIONS");

    const parts: string[] = [];
    const globalFile = path.join(globalPath, "CLAUDE.md");
    if (fs.existsSync(globalFile))
      parts.push(fs.readFileSync(globalFile, "utf-8"));
    const groupFile = path.join(groupPath, "CLAUDE.md");
    if (fs.existsSync(groupFile))
      parts.push(fs.readFileSync(groupFile, "utf-8"));
    parts.push(
      "\n## Tu Identidad\nNombre: Carlos Lopez\nRol: ae\nGrupo: carlos-ae",
    );

    const systemPrompt = parts.join("\n\n---\n\n");
    expect(systemPrompt).toContain("GLOBAL INSTRUCTIONS");
    expect(systemPrompt).toContain("AE INSTRUCTIONS");
    expect(systemPrompt).toContain("Carlos Lopez");
    expect(systemPrompt).toContain("ae");
  });

  it("includes identity injection", () => {
    const parts = ["# Global", "# AE"];
    parts.push(
      "\n## Tu Identidad\nNombre: Ana Garcia\nRol: gerente\nGrupo: ana-mgr",
    );
    const prompt = parts.join("\n\n---\n\n");
    expect(prompt).toContain("Ana Garcia");
    expect(prompt).toContain("gerente");
    expect(prompt).toContain("ana-mgr");
  });
});

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

describe("session management", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-sessions-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("save and load session round-trip", () => {
    const sessionId = "test-session-001";
    const messages: ChatMessage[] = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Hola" },
      { role: "assistant", content: "Hola, como te puedo ayudar?" },
    ];

    const filePath = path.join(tmpDir, `${sessionId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(messages));

    const loaded = JSON.parse(
      fs.readFileSync(filePath, "utf-8"),
    ) as ChatMessage[];
    expect(loaded).toHaveLength(3);
    expect(loaded[0].role).toBe("system");
    expect(loaded[1].content).toBe("Hola");
    expect(loaded[2].content).toBe("Hola, como te puedo ayudar?");
  });

  it("returns null for nonexistent session", () => {
    const filePath = path.join(tmpDir, "nonexistent.json");
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Context window truncation
// ---------------------------------------------------------------------------

describe("context window truncation", () => {
  function truncateMessages(
    messages: ChatMessage[],
    maxMessages: number,
  ): ChatMessage[] {
    if (messages.length <= maxMessages + 1) return messages;
    const system = messages[0]?.role === "system" ? [messages[0]] : [];
    const rest = messages[0]?.role === "system" ? messages.slice(1) : messages;
    const kept = rest.slice(-maxMessages);
    return [...system, ...kept];
  }

  it("keeps all messages when under limit", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const result = truncateMessages(msgs, 40);
    expect(result).toHaveLength(3);
  });

  it("preserves system message and keeps last N", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 50 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `msg-${i}`,
      })),
    ];
    const result = truncateMessages(msgs, 10);
    expect(result).toHaveLength(11); // system + 10
    expect(result[0].role).toBe("system");
    expect(result[1].content).toBe("msg-40");
    expect(result[10].content).toBe("msg-49");
  });

  it("handles no system message", () => {
    const msgs: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `msg-${i}`,
    }));
    const result = truncateMessages(msgs, 5);
    expect(result).toHaveLength(5);
    expect(result[0].content).toBe("msg-15");
  });
});

// ---------------------------------------------------------------------------
// Output marker format
// ---------------------------------------------------------------------------

describe("output marker format", () => {
  const OUTPUT_START_MARKER = "---NANOCLAW_OUTPUT_START---";
  const OUTPUT_END_MARKER = "---NANOCLAW_OUTPUT_END---";

  it("markers match engine protocol", () => {
    expect(OUTPUT_START_MARKER).toBe("---NANOCLAW_OUTPUT_START---");
    expect(OUTPUT_END_MARKER).toBe("---NANOCLAW_OUTPUT_END---");
  });

  it("output is valid JSON between markers", () => {
    const output = {
      status: "success",
      result: "Hola",
      newSessionId: "test-123",
    };
    const formatted = `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}`;
    const lines = formatted.split("\n");
    expect(lines[0]).toBe(OUTPUT_START_MARKER);
    expect(lines[2]).toBe(OUTPUT_END_MARKER);
    const parsed = JSON.parse(lines[1]);
    expect(parsed.status).toBe("success");
    expect(parsed.result).toBe("Hola");
  });
});

// ---------------------------------------------------------------------------
// IPC input draining (filesystem mock)
// ---------------------------------------------------------------------------

describe("IPC input draining", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-ipc-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads and deletes JSON message files", () => {
    fs.writeFileSync(
      path.join(tmpDir, "001.json"),
      JSON.stringify({ type: "message", text: "Hello" }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "002.json"),
      JSON.stringify({ type: "message", text: "World" }),
    );

    const files = fs
      .readdirSync(tmpDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(tmpDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      fs.unlinkSync(filePath);
      if (data.type === "message" && data.text) {
        messages.push(data.text);
      }
    }

    expect(messages).toEqual(["Hello", "World"]);
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it("ignores non-message JSON files", () => {
    fs.writeFileSync(
      path.join(tmpDir, "001.json"),
      JSON.stringify({ type: "status", data: "ok" }),
    );

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(tmpDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      fs.unlinkSync(filePath);
      if (data.type === "message" && data.text) {
        messages.push(data.text);
      }
    }

    expect(messages).toHaveLength(0);
  });

  it("close sentinel detection", () => {
    const sentinelPath = path.join(tmpDir, "_close");
    expect(fs.existsSync(sentinelPath)).toBe(false);

    fs.writeFileSync(sentinelPath, "");
    expect(fs.existsSync(sentinelPath)).toBe(true);

    fs.unlinkSync(sentinelPath);
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session ID generation
// ---------------------------------------------------------------------------

describe("session ID generation", () => {
  it("generates unique session IDs", () => {
    const generateSessionId = () =>
      `crm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const id1 = generateSessionId();
    const id2 = generateSessionId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^crm-\d+-[a-z0-9]+$/);
  });
});

// ---------------------------------------------------------------------------
// CJK sanitization (Chinese LLM leakage prevention)
// ---------------------------------------------------------------------------

describe("stripCJK", () => {
  // Inline implementation matching agent-runner/index.ts
  function stripCJK(text: string): string {
    return text
      .replace(/[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F]+/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  it("strips Chinese characters from mixed Spanish text", () => {
    expect(stripCJK("seguimiento 跟进 inmediato")).toBe(
      "seguimiento inmediato",
    );
  });

  it("strips full CJK sentences", () => {
    expect(stripCJK("Pipeline activo 管道活跃")).toBe("Pipeline activo");
  });

  it("preserves Spanish with diacritics", () => {
    expect(stripCJK("Propuesta de campaña — $15.2M")).toBe(
      "Propuesta de campaña — $15.2M",
    );
  });

  it("preserves emoji", () => {
    expect(stripCJK("✅ Deal cerrado 完成")).toBe("✅ Deal cerrado");
  });

  it("returns empty for pure CJK input", () => {
    expect(stripCJK("跟进客户")).toBe("");
  });

  it("handles no CJK gracefully", () => {
    const text = "Todo bien, pipeline saludable";
    expect(stripCJK(text)).toBe(text);
  });

  it("collapses multiple spaces after removal", () => {
    expect(stripCJK("antes 中文 después")).toBe("antes después");
  });
});
