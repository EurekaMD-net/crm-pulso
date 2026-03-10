/**
 * Dashboard API Tests
 *
 * Tests the REST API endpoint handlers and JWT auth directly,
 * without starting an HTTP server. Uses in-memory SQLite.
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
const { createToken, verifyToken, buildContextFromToken } =
  await import("../src/dashboard/auth.js");
const {
  getPipeline,
  getCuota,
  getDescarga,
  getActividades,
  getEquipo,
  getAlertas,
  getVpGlance,
} = await import("../src/dashboard/api.js");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setupDb() {
  testDb = new Database(":memory:");
  sqliteVec.load(testDb);
  testDb.pragma("foreign_keys = ON");
  createCrmSchema(testDb);

  // Org chart
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, activo) VALUES ('vp-001', 'Elena Ruiz', 'vp', 1)`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES ('dir-001', 'Roberto Diaz', 'director', 'vp-001', 1)`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES ('mgr-001', 'Ana Garcia', 'gerente', 'dir-001', 1)`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES ('ae-001', 'Carlos Lopez', 'ae', 'mgr-001', 1)`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO persona (id, nombre, rol, reporta_a, activo) VALUES ('ae-002', 'Maria Perez', 'ae', 'mgr-001', 1)`,
    )
    .run();
}

function seedPipeline() {
  const now = new Date().toISOString();
  testDb
    .prepare(
      `INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id) VALUES ('c1', 'Acme Corp', 'directo', 'Consumo', 'ae-001')`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id) VALUES ('c2', 'Beta Inc', 'directo', 'Tech', 'ae-002')`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, tipo_oportunidad, fecha_creacion, fecha_ultima_actividad)
    VALUES ('p1', 'c1', 'ae-001', 'Acme Verano', 5000000, 'en_negociacion', 'estacional', ?, ?)`,
    )
    .run(now, now);
  testDb
    .prepare(
      `INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, tipo_oportunidad, fecha_creacion, fecha_ultima_actividad)
    VALUES ('p2', 'c2', 'ae-002', 'Beta Digital', 20000000, 'enviada', 'tentpole', ?, ?)`,
    )
    .run(now, now);
}

function seedCuotas() {
  const week = getCurrentWeek();
  const year = new Date().getFullYear();
  testDb
    .prepare(
      `INSERT INTO cuota (persona_id, año, semana, meta_total, logro, rol)
    VALUES ('ae-001', ?, ?, 5000000, 4000000, 'ae')`,
    )
    .run(year, week);
  testDb
    .prepare(
      `INSERT INTO cuota (persona_id, año, semana, meta_total, logro, rol)
    VALUES ('ae-002', ?, ?, 5000000, 2500000, 'ae')`,
    )
    .run(year, week);
}

function seedActividades() {
  testDb
    .prepare(
      `INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id) VALUES ('c1', 'Acme Corp', 'directo', 'Consumo', 'ae-001')`,
    )
    .run();
  for (let i = 0; i < 5; i++) {
    const date = new Date(Date.now() - i * 86400000).toISOString();
    testDb
      .prepare(
        `INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha)
      VALUES (?, 'ae-001', 'c1', 'llamada', 'Seguimiento ${i}', 'positivo', ?)`,
      )
      .run(`act-${i}`, date);
  }
}

function seedDescargas() {
  const week = getCurrentWeek();
  const year = new Date().getFullYear();
  testDb
    .prepare(
      `INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id) VALUES ('c1', 'Acme Corp', 'directo', 'Consumo', 'ae-001')`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO descarga (cuenta_id, semana, año, planificado, facturado, gap_acumulado)
    VALUES ('c1', ?, ?, 1000000, 800000, 200000)`,
    )
    .run(week, year);
}

function seedAlertas() {
  testDb
    .prepare(
      `UPDATE persona SET whatsapp_group_folder = 'ae-001-folder' WHERE id = 'ae-001'`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO alerta_log (alerta_tipo, entidad_id, grupo_destino, fecha_envio)
    VALUES ('cuota_baja', 'ae-001', 'ae-001-folder', datetime('now'))`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO alerta_log (alerta_tipo, entidad_id, grupo_destino, fecha_envio)
    VALUES ('estancamiento', 'p1', 'ae-001-folder', datetime('now', '-10 days'))`,
    )
    .run();
}

function getCurrentWeek(): number {
  const d = new Date();
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(
    ((d.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7,
  );
}

function makeCtx(rol: "ae" | "gerente" | "director" | "vp", personaId: string) {
  const teamMap: Record<string, string[]> = {
    "vp-001": ["dir-001", "mgr-001", "ae-001", "ae-002"],
    "dir-001": ["mgr-001", "ae-001", "ae-002"],
    "mgr-001": ["ae-001", "ae-002"],
  };
  const directTeam: Record<string, string[]> = {
    "vp-001": ["dir-001"],
    "dir-001": ["mgr-001"],
    "mgr-001": ["ae-001", "ae-002"],
  };
  return {
    persona_id: personaId,
    rol,
    team_ids: directTeam[personaId] || [],
    full_team_ids: teamMap[personaId] || [],
  };
}

beforeEach(() => {
  setupDb();
  if (typeof _resetStatementCache === "function") _resetStatementCache();
});

afterEach(() => {
  testDb.close();
});

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe("JWT auth", () => {
  it("creates and verifies a valid token", () => {
    const token = createToken("vp-001");
    expect(token).toBeTruthy();
    const payload = verifyToken(token!);
    expect(payload).not.toBeNull();
    expect(payload!.persona_id).toBe("vp-001");
    expect(payload!.rol).toBe("vp");
  });

  it("returns null for invalid token", () => {
    expect(verifyToken("invalid.token.here")).toBeNull();
  });

  it("returns null for tampered token", () => {
    const token = createToken("vp-001")!;
    const tampered = token.slice(0, -5) + "XXXXX";
    expect(verifyToken(tampered)).toBeNull();
  });

  it("returns null for unknown persona", () => {
    expect(createToken("nonexistent")).toBeNull();
  });

  it("builds ToolContext from token payload", () => {
    const token = createToken("mgr-001")!;
    const payload = verifyToken(token)!;
    const ctx = buildContextFromToken(payload);
    expect(ctx.persona_id).toBe("mgr-001");
    expect(ctx.rol).toBe("gerente");
    expect(ctx.team_ids).toContain("ae-001");
    expect(ctx.team_ids).toContain("ae-002");
  });
});

// ---------------------------------------------------------------------------
// Pipeline API tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/pipeline", () => {
  it("VP sees all proposals", () => {
    seedPipeline();
    const ctx = makeCtx("vp", "vp-001");
    const result = getPipeline({}, ctx) as any;
    expect(result.total_propuestas).toBe(2);
    expect(result.valor_total).toBe(25000000);
  });

  it("AE sees only own proposals", () => {
    seedPipeline();
    const ctx = makeCtx("ae", "ae-001");
    const result = getPipeline({}, ctx) as any;
    expect(result.total_propuestas).toBe(1);
    expect(result.propuestas[0].titulo).toBe("Acme Verano");
  });

  it("filters by etapa", () => {
    seedPipeline();
    const ctx = makeCtx("vp", "vp-001");
    const result = getPipeline({ etapa: "en_negociacion" }, ctx) as any;
    expect(result.total_propuestas).toBe(1);
    expect(result.propuestas[0].etapa).toBe("en_negociacion");
  });

  it("returns empty when no proposals", () => {
    const ctx = makeCtx("vp", "vp-001");
    const result = getPipeline({}, ctx) as any;
    expect(result.total_propuestas).toBe(0);
    expect(result.propuestas).toEqual([]);
  });

  it("gerente sees team proposals", () => {
    seedPipeline();
    const ctx = makeCtx("gerente", "mgr-001");
    const result = getPipeline({}, ctx) as any;
    expect(result.total_propuestas).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Cuota API tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/cuota", () => {
  it("VP sees all quotas", () => {
    seedCuotas();
    const ctx = makeCtx("vp", "vp-001");
    const result = getCuota({}, ctx) as any;
    expect(result.cuotas.length).toBe(2);
  });

  it("AE sees only own quota", () => {
    seedCuotas();
    const ctx = makeCtx("ae", "ae-001");
    const result = getCuota({}, ctx) as any;
    expect(result.cuotas.length).toBe(1);
    expect(result.cuotas[0].nombre).toBe("Carlos Lopez");
    expect(result.cuotas[0].porcentaje).toBe(80);
  });

  it("returns week and year", () => {
    seedCuotas();
    const ctx = makeCtx("vp", "vp-001");
    const result = getCuota({}, ctx) as any;
    expect(result.semana).toBe(getCurrentWeek());
    expect(result.año).toBe(new Date().getFullYear());
  });
});

// ---------------------------------------------------------------------------
// Descarga API tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/descarga", () => {
  it("returns descarga with totals", () => {
    seedDescargas();
    const ctx = makeCtx("vp", "vp-001");
    const result = getDescarga({}, ctx) as any;
    expect(result.total_planificado).toBe(1000000);
    expect(result.total_facturado).toBe(800000);
    expect(result.gap_total).toBe(200000);
    expect(result.cuentas.length).toBe(1);
  });

  it("AE sees only own accounts", () => {
    seedDescargas();
    const ctx = makeCtx("ae", "ae-002");
    const result = getDescarga({}, ctx) as any;
    expect(result.cuentas.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Actividades API tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/actividades", () => {
  it("returns recent activities", () => {
    seedActividades();
    const ctx = makeCtx("vp", "vp-001");
    const result = getActividades({}, ctx) as any;
    expect(result.total).toBe(5);
    expect(result.actividades[0].tipo).toBe("llamada");
  });

  it("AE sees only own activities", () => {
    seedActividades();
    const ctx = makeCtx("ae", "ae-002");
    const result = getActividades({}, ctx) as any;
    expect(result.total).toBe(0);
  });

  it("respects limite parameter", () => {
    seedActividades();
    const ctx = makeCtx("vp", "vp-001");
    const result = getActividades({ limite: "2" }, ctx) as any;
    expect(result.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Equipo API tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/equipo", () => {
  it("VP sees entire org", () => {
    const ctx = makeCtx("vp", "vp-001");
    const result = getEquipo({}, ctx) as any;
    expect(result.total).toBe(5);
  });

  it("AE sees only self", () => {
    const ctx = makeCtx("ae", "ae-001");
    const result = getEquipo({}, ctx) as any;
    expect(result.total).toBe(1);
    expect(result.personas[0].nombre).toBe("Carlos Lopez");
  });

  it("gerente sees self + direct reports", () => {
    const ctx = makeCtx("gerente", "mgr-001");
    const result = getEquipo({}, ctx) as any;
    expect(result.total).toBe(3); // mgr + 2 AEs
  });

  it("returns sorted by role hierarchy", () => {
    const ctx = makeCtx("vp", "vp-001");
    const result = getEquipo({}, ctx) as any;
    expect(result.personas[0].rol).toBe("vp");
    expect(result.personas[1].rol).toBe("director");
  });
});

// ---------------------------------------------------------------------------
// Alertas API tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/alertas", () => {
  it("returns recent alerts", () => {
    seedAlertas();
    const ctx = makeCtx("vp", "vp-001");
    const result = getAlertas({}, ctx) as any;
    // VP sees all, both alerts within default 7 days
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it("filters by dias parameter", () => {
    seedAlertas();
    const ctx = makeCtx("vp", "vp-001");
    const result = getAlertas({ dias: "1" }, ctx) as any;
    // Only the recent one (not the 10-day-old one)
    expect(result.total).toBe(1);
  });

  it("AE sees only own alerts", () => {
    seedAlertas();
    const ctx = makeCtx("ae", "ae-001");
    const result = getAlertas({}, ctx) as any;
    expect(result.total).toBeGreaterThanOrEqual(1);
    for (const a of result.alertas) {
      expect(a.tipo).toBeDefined();
      expect(a.entidad).toBeDefined();
      expect(a.fecha).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// VP Glance helpers
// ---------------------------------------------------------------------------

function seedSentiment() {
  testDb
    .prepare(
      `INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id) VALUES ('c1', 'Acme Corp', 'directo', 'Consumo', 'ae-001')`,
    )
    .run();
  testDb
    .prepare(
      `INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id) VALUES ('c2', 'Beta Inc', 'directo', 'Tech', 'ae-002')`,
    )
    .run();
  const now = new Date();
  // Current week: 3 positivo, 2 negativo, 1 urgente for ae-001
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getTime() - i * 86400000).toISOString();
    testDb
      .prepare(
        `INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, 'ae-001', 'c1', 'llamada', 'test', 'positivo', ?)`,
      )
      .run(`s-pos-${i}`, d);
  }
  for (let i = 0; i < 2; i++) {
    const d = new Date(now.getTime() - i * 86400000).toISOString();
    testDb
      .prepare(
        `INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, 'ae-001', 'c1', 'llamada', 'test', 'negativo', ?)`,
      )
      .run(`s-neg-${i}`, d);
  }
  testDb
    .prepare(
      `INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES ('s-urg-0', 'ae-002', 'c2', 'llamada', 'test', 'urgente', ?)`,
    )
    .run(now.toISOString());
  // Previous week: 5 positivo for ae-001 (no negatives)
  for (let i = 0; i < 5; i++) {
    const d = new Date(now.getTime() - (8 + i) * 86400000).toISOString();
    testDb
      .prepare(
        `INSERT INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, 'ae-001', 'c1', 'llamada', 'test', 'positivo', ?)`,
      )
      .run(`s-prev-${i}`, d);
  }
}

function seedEvents() {
  const future = new Date(Date.now() + 30 * 86400000)
    .toISOString()
    .slice(0, 10);
  testDb
    .prepare(
      `INSERT INTO crm_events (id, nombre, tipo, fecha_inicio, inventario_total, inventario_vendido, meta_ingresos, ingresos_actual)
    VALUES ('ev1', 'Liga MX Final', 'deportivo', ?, '{"spots_tv":100,"spots_radio":50}', '{"spots_tv":80,"spots_radio":20}', 5000000, 3000000)`,
    )
    .run(future);
  testDb
    .prepare(
      `INSERT INTO crm_events (id, nombre, tipo, fecha_inicio, meta_ingresos, ingresos_actual)
    VALUES ('ev2', 'Industry Expo', 'industria', ?, 1000000, 200000)`,
    )
    .run(future);
}

// ---------------------------------------------------------------------------
// VP Glance API tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/vp-glance", () => {
  // --- Access Control ---
  it("rejects non-VP users", () => {
    const ctx = makeCtx("ae", "ae-001");
    const result = getVpGlance({}, ctx) as any;
    expect(result.error).toBe("Solo disponible para VP");
  });

  it("VP gets full response with all sections", () => {
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    expect(result.timestamp).toBeDefined();
    expect(result.revenue_pulse).toBeDefined();
    expect(result.pipeline_health).toBeDefined();
    expect(result.quota_heatmap).toBeDefined();
    expect(result.sentiment_pulse).toBeDefined();
    expect(result.active_alerts).toBeDefined();
    expect(result.inventory).toBeDefined();
  });

  // --- Revenue Pulse ---
  it("aggregates cuota correctly", () => {
    seedCuotas();
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    expect(result.revenue_pulse.meta).toBe(10000000);
    expect(result.revenue_pulse.logro).toBe(6500000);
    expect(result.revenue_pulse.pct).toBe(65);
  });

  it("returns zero when no cuota data", () => {
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    expect(result.revenue_pulse.meta).toBe(0);
    expect(result.revenue_pulse.logro).toBe(0);
    expect(result.revenue_pulse.pct).toBe(0);
  });

  it("computes revenue trend", () => {
    seedCuotas();
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    expect(["mejorando", "estable", "deteriorando"]).toContain(
      result.revenue_pulse.tendencia,
    );
  });

  // --- Pipeline Health ---
  it("pipeline totals are correct", () => {
    seedPipeline();
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    expect(result.pipeline_health.total).toBe(2);
    expect(result.pipeline_health.valor).toBe(25000000);
  });

  it("counts mega deals", () => {
    seedPipeline();
    // p2 has valor_estimado=20M > 15M threshold → es_mega=1 (generated column)
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    expect(result.pipeline_health.mega).toBe(1);
  });

  it("counts stalled deals", () => {
    seedPipeline();
    testDb
      .prepare(`UPDATE propuesta SET dias_sin_actividad = 10 WHERE id = 'p1'`)
      .run();
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    expect(result.pipeline_health.stalled).toBe(1);
    expect(result.pipeline_health.stalled_valor).toBe(5000000);
  });

  it("pipeline has stage breakdown", () => {
    seedPipeline();
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    expect(result.pipeline_health.by_stage.length).toBeGreaterThan(0);
    const stages = result.pipeline_health.by_stage.map((s: any) => s.etapa);
    expect(stages).toContain("en_negociacion");
    expect(stages).toContain("enviada");
  });

  // --- Quota Heatmap ---
  it("builds hierarchy tree", () => {
    seedCuotas();
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    expect(result.quota_heatmap.length).toBeGreaterThan(0);
    const dir = result.quota_heatmap[0];
    expect(dir.nombre).toBe("Roberto Diaz");
    expect(dir.gerentes.length).toBe(1);
    expect(dir.gerentes[0].nombre).toBe("Ana Garcia");
    expect(dir.gerentes[0].aes.length).toBe(2);
  });

  it("aggregates quota upward", () => {
    seedCuotas();
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    const dir = result.quota_heatmap[0];
    // 2 AEs: 4M/5M + 2.5M/5M = 6.5M/10M = 65%
    expect(dir.pct).toBe(65);
    expect(dir.gerentes[0].pct).toBe(65);
  });

  it("graceful with no cuota data in heatmap", () => {
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    const dir = result.quota_heatmap[0];
    expect(dir.pct).toBe(0);
  });

  // --- Sentiment Pulse ---
  it("distributes sentiment counts", () => {
    seedSentiment();
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    const s = result.sentiment_pulse;
    expect(s.positivo).toBe(3);
    expect(s.negativo).toBe(2);
    expect(s.urgente).toBe(1);
    expect(s.total).toBe(6);
  });

  it("computes sentiment trend", () => {
    seedSentiment();
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    // Previous week had 0% negative, current has ~50% → deteriorating
    expect(result.sentiment_pulse.tendencia).toBe("deteriorando");
  });

  it("identifies teams above 30% negative", () => {
    seedSentiment();
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    // Both AEs report to mgr-001: 2neg+1urg / 6total = 50% → at risk
    expect(result.sentiment_pulse.equipos_riesgo.length).toBe(1);
    expect(result.sentiment_pulse.equipos_riesgo[0].gerente).toBe("Ana Garcia");
  });

  // --- Alerts ---
  it("returns recent alerts", () => {
    seedAlertas();
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    expect(result.active_alerts.length).toBeGreaterThanOrEqual(1);
    expect(result.active_alerts[0].tipo).toBeDefined();
  });

  it("empty alerts when none exist", () => {
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    expect(result.active_alerts.length).toBe(0);
  });

  // --- Inventory ---
  it("parses inventory sold_pct", () => {
    seedEvents();
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    expect(result.inventory.length).toBe(2);
    const liga = result.inventory.find(
      (e: any) => e.nombre === "Liga MX Final",
    );
    expect(liga).toBeDefined();
    // total: 100+50=150, sold: 80+20=100 → 67%
    expect(liga.sold_pct).toBe(67);
    expect(liga.meta).toBe(5000000);
    expect(liga.actual).toBe(3000000);
  });

  it("handles null inventory gracefully", () => {
    seedEvents();
    const ctx = makeCtx("vp", "vp-001");
    const result = getVpGlance({}, ctx) as any;
    const expo = result.inventory.find(
      (e: any) => e.nombre === "Industry Expo",
    );
    expect(expo).toBeDefined();
    expect(expo.sold_pct).toBe(0);
  });
});
