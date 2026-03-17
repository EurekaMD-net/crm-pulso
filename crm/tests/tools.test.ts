/**
 * CRM Tool Tests
 *
 * Tests tool registry, registration tools, query tools, email, calendar.
 * Uses in-memory SQLite with mocked getDatabase().
 *
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

const { getToolsForRole, executeTool, buildToolContext } =
  await import("../src/tools/index.js");

const { _resetStatementCache } = await import("../src/hierarchy.js");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setupDb() {
  testDb = new Database(":memory:");
  sqliteVec.load(testDb);
  testDb.pragma("foreign_keys = ON");
  createCrmSchema(testDb);
  _resetStatementCache();

  // Org chart
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('vp1', 'Roberto', 'vp', null, 'vp1', 1)`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ger1', 'Miguel', 'gerente', 'vp1', 'ger1', 1)`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ae1', 'Maria', 'ae', 'ger1', 'ae1', 1)`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ae2', 'Carlos', 'ae', 'ger1', 'ae2', 1)`,
    )
    .run();

  // Accounts
  testDb
    .prepare(
      `INSERT INTO cuenta (id, nombre, tipo, ae_id) VALUES ('c1', 'Coca-Cola', 'directo', 'ae1')`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO cuenta (id, nombre, tipo, ae_id) VALUES ('c2', 'Bimbo', 'directo', 'ae2')`,
    )
    .run();

  // Contacts
  testDb
    .prepare(
      `INSERT INTO contacto (id, nombre, cuenta_id, rol, email) VALUES ('con1', 'Dir Marketing', 'c1', 'decisor', 'mktg@cocacola.com')`,
    )
    .run();

  // Propuestas
  testDb
    .prepare(
      `INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES ('p1', 'c1', 'ae1', 'Campana Verano', 5000000, 'enviada', 10)`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES ('p2', 'c2', 'ae2', 'Campana Navidad', 8000000, 'en_negociacion', 3)`,
    )
    .run();

  // Inventario
  testDb
    .prepare(
      `INSERT INTO inventario (id, medio, propiedad, formato, precio_referencia, precio_piso) VALUES ('inv1', 'tv_abierta', 'Canal Uno', 'spot_30s', 85000, 60000)`,
    )
    .run();

  // Cuota
  const week = Math.ceil(
    ((Date.now() - new Date(2026, 0, 1).getTime()) / 86400000 + 1) / 7,
  );
  testDb
    .prepare(
      `INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total, logro) VALUES ('q1', 'ae1', 'ae', 2026, ?, 1000000, 750000)`,
    )
    .run(week);
}

beforeEach(setupDb);

// ---------------------------------------------------------------------------
// Tool Registry
// ---------------------------------------------------------------------------

describe("getToolsForRole", () => {
  it("returns tools for all roles", () => {
    const aeTools = getToolsForRole("ae");
    const gerTools = getToolsForRole("gerente");
    expect(aeTools.length).toBeGreaterThan(0);
    expect(gerTools.length).toBeGreaterThan(0);
  });

  it("AE has registrar_actividad", () => {
    const tools = getToolsForRole("ae");
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("registrar_actividad");
    expect(names).toContain("crear_propuesta");
    expect(names).toContain("enviar_email_seguimiento");
  });

  it("gerente has consultar tools and briefing email", () => {
    const tools = getToolsForRole("gerente");
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("consultar_pipeline");
    expect(names).toContain("enviar_email_briefing");
    expect(names).not.toContain("registrar_actividad");
  });

  it("VP has consultar + email + relationship tools", () => {
    const tools = getToolsForRole("vp");
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("consultar_pipeline");
    expect(names).toContain("enviar_email_briefing");
    expect(names).not.toContain("registrar_actividad");
  });
});

describe("buildToolContext", () => {
  it("builds context for AE", () => {
    const ctx = buildToolContext("ae1");
    expect(ctx).not.toBeNull();
    expect(ctx!.rol).toBe("ae");
    expect(ctx!.team_ids).toEqual([]);
  });

  it("builds context for gerente with team", () => {
    const ctx = buildToolContext("ger1");
    expect(ctx).not.toBeNull();
    expect(ctx!.rol).toBe("gerente");
    expect(ctx!.team_ids.sort()).toEqual(["ae1", "ae2"]);
  });

  it("returns null for unknown persona", () => {
    expect(buildToolContext("ghost")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Registration Tools
// ---------------------------------------------------------------------------

describe("registrar_actividad", () => {
  it("registers an activity for a known account", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool(
        "registrar_actividad",
        {
          cuenta_nombre: "Coca-Cola",
          tipo: "llamada",
          resumen: "Llame al cliente sobre la campana",
          sentimiento: "positivo",
        },
        ctx,
      ),
    );

    expect(result.ok).toBe(true);
    expect(result.id).toBeTruthy();

    const row = testDb
      .prepare("SELECT * FROM actividad WHERE id = ?")
      .get(result.id) as any;
    expect(row.ae_id).toBe("ae1");
    expect(row.resumen).toContain("campana");
  });

  it("returns error for unknown account", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool(
        "registrar_actividad",
        {
          cuenta_nombre: "NoExiste",
          tipo: "llamada",
          resumen: "Test",
        },
        ctx,
      ),
    );

    expect(result.error).toContain("No encontr");
  });

  it("updates propuesta timestamp when linked", async () => {
    const ctx = buildToolContext("ae1")!;
    await executeTool(
      "registrar_actividad",
      {
        cuenta_nombre: "Coca",
        tipo: "reunion",
        resumen: "Revision propuesta",
        propuesta_titulo: "Verano",
      },
      ctx,
    );

    const prop = testDb
      .prepare("SELECT dias_sin_actividad FROM propuesta WHERE id = ?")
      .get("p1") as any;
    expect(prop.dias_sin_actividad).toBe(0);
  });
});

describe("crear_propuesta", () => {
  it("creates a new propuesta", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool(
        "crear_propuesta",
        {
          cuenta_nombre: "Coca-Cola",
          titulo: "Campana Navidad 2026",
          valor_estimado: 12000000,
          tipo_oportunidad: "tentpole",
        },
        ctx,
      ),
    );

    expect(result.ok).toBe(true);
    const row = testDb
      .prepare("SELECT * FROM propuesta WHERE titulo = 'Campana Navidad 2026'")
      .get() as any;
    expect(row).toBeDefined();
    expect(row.etapa).toBe("en_preparacion");
    expect(row.valor_estimado).toBe(12000000);
  });
});

describe("actualizar_propuesta", () => {
  it("updates stage with access", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool(
        "actualizar_propuesta",
        {
          propuesta_titulo: "Verano",
          etapa: "en_discusion",
        },
        ctx,
      ),
    );

    expect(result.ok).toBe(true);
    const row = testDb
      .prepare("SELECT etapa FROM propuesta WHERE id = ?")
      .get("p1") as any;
    expect(row.etapa).toBe("en_discusion");
  });

  it("blocks cross-AE update", async () => {
    const ctx = buildToolContext("ae2")!;
    const result = JSON.parse(
      await executeTool(
        "actualizar_propuesta",
        {
          propuesta_titulo: "Verano",
          etapa: "completada",
        },
        ctx,
      ),
    );

    expect(result.error).toContain("No tienes acceso");
  });

  it("allows gerente to update team propuesta", async () => {
    const ctx = buildToolContext("ger1")!;
    const result = JSON.parse(
      await executeTool(
        "actualizar_propuesta",
        {
          propuesta_titulo: "Verano",
          etapa: "en_negociacion",
        },
        ctx,
      ),
    );

    expect(result.ok).toBe(true);
  });

  it("requires razon for perdida", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool(
        "actualizar_propuesta",
        {
          propuesta_titulo: "Verano",
          etapa: "perdida",
        },
        ctx,
      ),
    );

    expect(result.error).toContain("razon_perdida");
  });
});

describe("cerrar_propuesta", () => {
  it("closes a propuesta as completada", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool(
        "cerrar_propuesta",
        {
          propuesta_titulo: "Verano",
          resultado: "completada",
        },
        ctx,
      ),
    );

    expect(result.ok).toBe(true);
    const row = testDb
      .prepare("SELECT etapa FROM propuesta WHERE id = ?")
      .get("p1") as any;
    expect(row.etapa).toBe("completada");
  });
});

// ---------------------------------------------------------------------------
// Query Tools
// ---------------------------------------------------------------------------

describe("consultar_pipeline", () => {
  it("returns propuestas scoped to AE", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(await executeTool("consultar_pipeline", {}, ctx));

    expect(result.propuestas.length).toBe(1);
    expect(result.propuestas[0].titulo).toBe("Campana Verano");
  });

  it("returns all propuestas for VP", async () => {
    const ctx = buildToolContext("vp1")!;
    const result = JSON.parse(await executeTool("consultar_pipeline", {}, ctx));

    expect(result.propuestas.length).toBe(2);
  });

  it("filters by etapa", async () => {
    const ctx = buildToolContext("vp1")!;
    const result = JSON.parse(
      await executeTool("consultar_pipeline", { etapa: "enviada" }, ctx),
    );

    expect(result.propuestas.length).toBe(1);
    expect(result.propuestas[0].etapa).toBe("enviada");
  });

  it("filters stalled propuestas", async () => {
    const ctx = buildToolContext("vp1")!;
    const result = JSON.parse(
      await executeTool("consultar_pipeline", { solo_estancadas: true }, ctx),
    );

    expect(result.propuestas.every((p: any) => p.dias_sin_actividad >= 7)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// data_freshness metadata
// ---------------------------------------------------------------------------

describe("data_freshness", () => {
  it("consultar_pipeline includes data_freshness", async () => {
    const ctx = buildToolContext("vp1")!;
    const result = JSON.parse(await executeTool("consultar_pipeline", {}, ctx));
    expect(result.data_freshness).toBeDefined();
    expect(result.data_freshness).toHaveProperty("latest");
    expect(result.data_freshness).toHaveProperty("days_old");
    expect(result.data_freshness).toHaveProperty("stale");
  });

  it("consultar_pipeline marks old fecha_ultima_actividad as stale", async () => {
    // Update propuesta to have an old fecha_ultima_actividad
    testDb
      .prepare(
        `UPDATE propuesta SET fecha_ultima_actividad = '2026-01-01T00:00:00Z' WHERE id = 'p1'`,
      )
      .run();
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(await executeTool("consultar_pipeline", {}, ctx));
    expect(result.data_freshness.stale).toBe(true);
    expect(result.data_freshness.days_old).toBeGreaterThan(3);
  });

  it("consultar_cuota includes data_freshness for current week", async () => {
    // Seed cuota for the exact current week as computed by getCurrentWeek()
    const { getCurrentWeek } = await import("../src/tools/helpers.js");
    const cw = getCurrentWeek();
    testDb
      .prepare(
        `INSERT OR REPLACE INTO cuota (id, persona_id, rol, año, semana, meta_total, logro) VALUES ('q-cw', 'ae1', 'ae', 2026, ?, 1000000, 750000)`,
      )
      .run(cw);
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(await executeTool("consultar_cuota", {}, ctx));
    expect(result.data_freshness).toBeDefined();
    expect(result.data_freshness.stale).toBe(false);
  });

  it("consultar_cuota marks old week as stale when data exists", async () => {
    // Insert data for week 1 so the tool returns data (not "no hay datos")
    testDb
      .prepare(
        `INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total, logro) VALUES ('q-old', 'ae1', 'ae', 2026, 1, 500000, 200000)`,
      )
      .run();
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool("consultar_cuota", { semana: 1 }, ctx),
    );
    expect(result.data_freshness).toBeDefined();
    expect(result.data_freshness.stale).toBe(true);
  });
});

describe("dataFreshness helper", () => {
  it("returns stale for empty rows", async () => {
    const { dataFreshness } = await import("../src/tools/helpers.js");
    const result = dataFreshness([], "fecha");
    expect(result.latest).toBeNull();
    expect(result.days_old).toBe(-1);
    expect(result.stale).toBe(true);
  });

  it("returns not stale for today", async () => {
    const { dataFreshness } = await import("../src/tools/helpers.js");
    const result = dataFreshness(
      [{ fecha: new Date().toISOString() }],
      "fecha",
    );
    expect(result.days_old).toBe(0);
    expect(result.stale).toBe(false);
  });

  it("returns stale for old data", async () => {
    const { dataFreshness } = await import("../src/tools/helpers.js");
    const oldDate = new Date(Date.now() - 10 * 86400000).toISOString();
    const result = dataFreshness([{ fecha: oldDate }], "fecha");
    expect(result.days_old).toBe(10);
    expect(result.stale).toBe(true);
  });

  it("picks the latest date from multiple rows", async () => {
    const { dataFreshness } = await import("../src/tools/helpers.js");
    const today = new Date().toISOString();
    const old = new Date(Date.now() - 5 * 86400000).toISOString();
    const result = dataFreshness([{ fecha: old }, { fecha: today }], "fecha");
    expect(result.latest).toBe(today);
    expect(result.days_old).toBe(0);
    expect(result.stale).toBe(false);
  });
});

describe("consultar_cuenta", () => {
  it("returns full account detail", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool(
        "consultar_cuenta",
        { cuenta_nombre: "Coca-Cola" },
        ctx,
      ),
    );

    expect(result.cuenta.nombre).toBe("Coca-Cola");
    expect(result.contactos.length).toBe(1);
    expect(result.propuestas_activas.length).toBe(1);
  });

  it("returns error for unknown account", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool("consultar_cuenta", { cuenta_nombre: "NoExiste" }, ctx),
    );

    expect(result.error).toContain("No encontr");
  });
});

describe("consultar_inventario", () => {
  it("returns all inventory", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool("consultar_inventario", {}, ctx),
    );

    expect(result.productos.length).toBe(1);
    expect(result.productos[0].precio_referencia).toBe(85000);
  });

  it("filters by medio", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool("consultar_inventario", { medio: "radio" }, ctx),
    );

    expect(result.mensaje).toContain("No hay");
  });
});

// ---------------------------------------------------------------------------
// Email Tools
// ---------------------------------------------------------------------------

describe("enviar_email_seguimiento", () => {
  it("creates a draft email", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool(
        "enviar_email_seguimiento",
        {
          contacto_id: "con1",
          asunto: "Seguimiento propuesta",
          cuerpo: "Estimado, le envio seguimiento...",
        },
        ctx,
      ),
    );

    expect(result.ok).toBe(true);
    expect(result.email_id).toBeTruthy();
    expect(result.preview.para).toContain("mktg@cocacola.com");

    const email = testDb
      .prepare("SELECT * FROM email_log WHERE id = ?")
      .get(result.email_id) as any;
    expect(email.enviado).toBe(0);
    expect(email.tipo).toBe("seguimiento");
  });

  it("returns error for unknown contact", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool(
        "enviar_email_seguimiento",
        {
          contacto_id: "ghost",
          asunto: "Test",
          cuerpo: "Test",
        },
        ctx,
      ),
    );

    expect(result.error).toContain("No encontr");
  });
});

describe("confirmar_envio_email", () => {
  it("marks email as sent (MVP mode: saves as draft)", async () => {
    const ctx = buildToolContext("ae1")!;

    // Create draft first
    const draft = JSON.parse(
      await executeTool(
        "enviar_email_seguimiento",
        {
          contacto_id: "con1",
          asunto: "Test",
          cuerpo: "Test body",
        },
        ctx,
      ),
    );

    // Confirm it
    const result = JSON.parse(
      await executeTool(
        "confirmar_envio_email",
        {
          email_id: draft.email_id,
        },
        ctx,
      ),
    );

    expect(result.ok).toBe(true);
    expect(result.mensaje).toContain("borrador"); // MVP mode
  });
});

// ---------------------------------------------------------------------------
// Calendar Tools
// ---------------------------------------------------------------------------

describe("crear_evento_calendario", () => {
  it("creates a local calendar event", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool(
        "crear_evento_calendario",
        {
          titulo: "Seguimiento P&G",
          fecha_inicio: "2026-03-10T10:00:00Z",
          tipo: "seguimiento",
          duracion_minutos: 30,
        },
        ctx,
      ),
    );

    expect(result.ok).toBe(true);
    expect(result.id).toBeTruthy();

    const event = testDb
      .prepare("SELECT * FROM evento_calendario WHERE id = ?")
      .get(result.id) as any;
    expect(event.titulo).toBe("Seguimiento P&G");
    expect(event.creado_por).toBe("agente");
  });
});

describe("consultar_agenda", () => {
  it("returns events for today", async () => {
    const ctx = buildToolContext("ae1")!;

    // Insert an event for today
    const todayStr = new Date().toISOString();
    testDb
      .prepare(
        `INSERT INTO evento_calendario (id, persona_id, titulo, fecha_inicio, fecha_fin, tipo) VALUES ('ev-today', 'ae1', 'Reunion Test', ?, ?, 'reunion')`,
      )
      .run(todayStr, todayStr);

    const result = JSON.parse(
      await executeTool("consultar_agenda", { rango: "hoy" }, ctx),
    );
    expect(result.eventos.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Event Tools
// ---------------------------------------------------------------------------

describe("consultar_eventos", () => {
  it("returns upcoming events", async () => {
    const futureDate = new Date(Date.now() + 20 * 86400000)
      .toISOString()
      .slice(0, 10);
    const invTotal = JSON.stringify({ tv_abierta: 100, ctv: 50 });
    const invVendido = JSON.stringify({ tv_abierta: 30, ctv: 10 });
    testDb
      .prepare(
        `INSERT INTO crm_events (id, nombre, tipo, fecha_inicio, inventario_total, inventario_vendido, prioridad) VALUES ('ev1', 'Copa del Mundo', 'deportivo', ?, ?, ?, 'alta')`,
      )
      .run(futureDate, invTotal, invVendido);

    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(await executeTool("consultar_eventos", {}, ctx));
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.eventos[0].nombre).toBe("Copa del Mundo");
    expect(result.eventos[0].disponibilidad).toBeDefined();
  });

  it("filters by tipo", async () => {
    const futureDate = new Date(Date.now() + 20 * 86400000)
      .toISOString()
      .slice(0, 10);
    testDb
      .prepare(
        `INSERT INTO crm_events (id, nombre, tipo, fecha_inicio) VALUES ('ev1', 'Copa', 'deportivo', ?)`,
      )
      .run(futureDate);
    testDb
      .prepare(
        `INSERT INTO crm_events (id, nombre, tipo, fecha_inicio) VALUES ('ev2', 'Buen Fin', 'estacional', ?)`,
      )
      .run(futureDate);

    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool("consultar_eventos", { tipo: "deportivo" }, ctx),
    );
    expect(result.total).toBe(1);
    expect(result.eventos[0].nombre).toBe("Copa");
  });
});

describe("consultar_inventario_evento", () => {
  it("returns detailed inventory", async () => {
    const invTotal = JSON.stringify({ tv_abierta: 100, ctv: 50, radio: 200 });
    const invVendido = JSON.stringify({ tv_abierta: 60, ctv: 20, radio: 100 });
    testDb
      .prepare(
        `INSERT INTO crm_events (id, nombre, tipo, fecha_inicio, inventario_total, inventario_vendido) VALUES ('ev1', 'Copa del Mundo', 'deportivo', '2026-06-11', ?, ?)`,
      )
      .run(invTotal, invVendido);

    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool(
        "consultar_inventario_evento",
        { evento_nombre: "Copa" },
        ctx,
      ),
    );
    expect(result.evento.nombre).toBe("Copa del Mundo");
    expect(result.inventario.length).toBe(3);
    expect(result.inventario[0].medio).toBe("tv_abierta");
    expect(result.inventario[0].disponible_pct).toBe(40);
  });

  it("returns error for unknown event", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool(
        "consultar_inventario_evento",
        { evento_nombre: "NoExiste" },
        ctx,
      ),
    );
    expect(result.error).toContain("No encontre");
  });
});

// ---------------------------------------------------------------------------
// Async executeTool
// ---------------------------------------------------------------------------

describe("executeTool", () => {
  it("returns error for unknown tool", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(await executeTool("no_existe", {}, ctx));
    expect(result.error).toContain("desconocida");
  });

  it("returns a Promise", () => {
    const ctx = buildToolContext("ae1")!;
    const result = executeTool("consultar_pipeline", {}, ctx);
    expect(result).toBeInstanceOf(Promise);
  });

  it("handles async tool handlers (email confirm)", async () => {
    const ctx = buildToolContext("ae1")!;
    const draft = JSON.parse(
      await executeTool(
        "enviar_email_seguimiento",
        {
          contacto_id: "con1",
          asunto: "Async test",
          cuerpo: "Testing async",
        },
        ctx,
      ),
    );

    const result = await executeTool(
      "confirmar_envio_email",
      {
        email_id: draft.email_id,
      },
      ctx,
    );
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
  });

  it("handles async calendar creation", async () => {
    const ctx = buildToolContext("ae1")!;
    const result = await executeTool(
      "crear_evento_calendario",
      {
        titulo: "Async Event",
        fecha_inicio: "2026-04-01T14:00:00Z",
      },
      ctx,
    );
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gmail & Drive Tools -- Graceful Degradation
// ---------------------------------------------------------------------------

describe("Gmail tools graceful degradation", () => {
  it("buscar_emails returns error without Google configured", async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool("buscar_emails", { query: "test" }, ctx),
    );
    expect(result.error).toContain("Correo no configurado");
  });

  it("leer_email returns error without Google configured", async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool("leer_email", { email_id: "abc123" }, ctx),
    );
    expect(result.error).toContain("Correo no configurado");
  });

  it("crear_borrador_email returns error without Google configured", async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool(
        "crear_borrador_email",
        {
          destinatario: "test@example.com",
          asunto: "Test",
          cuerpo: "Test body",
        },
        ctx,
      ),
    );
    expect(result.error).toContain("Correo no configurado");
  });
});

describe("Drive tools graceful degradation", () => {
  it("listar_archivos_drive returns error without Google configured", async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool("listar_archivos_drive", {}, ctx),
    );
    expect(result.error).toContain("Archivos no configurados");
  });

  it("leer_archivo_drive returns error without Google configured", async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const ctx = buildToolContext("ae1")!;
    const result = JSON.parse(
      await executeTool("leer_archivo_drive", { archivo_id: "abc123" }, ctx),
    );
    expect(result.error).toContain("Archivos no configurados");
  });
});
