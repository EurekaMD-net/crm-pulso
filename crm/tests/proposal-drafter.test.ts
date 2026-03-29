/**
 * Proposal Draft Engine Tests
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createCrmSchema } from "../src/schema.js";

let testDb: InstanceType<typeof Database>;
vi.mock("../src/db.js", () => ({ getDatabase: () => testDb }));
const noop = () => {};
const noopLogger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  fatal: noop,
  child: () => noopLogger,
};
vi.mock("../src/logger.js", () => ({ logger: noopLogger }));
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

const { draftProposalFromInsight } = await import("../src/proposal-drafter.js");
const { _resetStatementCache } = await import("../src/hierarchy.js");
const { actuar_insight, revisar_borrador, modificar_borrador } =
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

function seedInsight(
  db: InstanceType<typeof Database>,
  overrides: Record<string, any> = {},
) {
  const d = {
    id: "ins-test-1",
    tipo: "oportunidad_crosssell",
    cuenta_id: "c1",
    ae_id: "ae1",
    titulo: "Cross-sell estacional",
    descripcion: "Peers compran estacional, esta cuenta no.",
    accion_recomendada: "Proponer estacional",
    datos_soporte: JSON.stringify({
      tipo: "estacional",
      peer_count: 3,
      peer_avg_val: 5000000,
    }),
    confianza: 0.75,
    sample_size: 3,
    valor_potencial: 5000000,
    estado: "nuevo",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO insight_comercial (id, tipo, cuenta_id, ae_id, titulo, descripcion, accion_recomendada, datos_soporte, confianza, sample_size, valor_potencial, estado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    d.id,
    d.tipo,
    d.cuenta_id,
    d.ae_id,
    d.titulo,
    d.descripcion,
    d.accion_recomendada,
    d.datos_soporte,
    d.confianza,
    d.sample_size,
    d.valor_potencial,
    d.estado,
  );
}

beforeEach(() => {
  testDb = new Database(":memory:");
  sqliteVec.load(testDb);
  testDb.pragma("foreign_keys = ON");
  createCrmSchema(testDb);
  _resetStatementCache();
  seedTeam(testDb);
  testDb
    .prepare(
      "INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id, estado) VALUES ('c1', 'TestCo', 'directo', 'alimentos', 'ae1', 'activo')",
    )
    .run();
});

describe("borrador_agente etapa", () => {
  it("accepts borrador_agente as valid etapa", () => {
    testDb
      .prepare(
        "INSERT INTO propuesta (id, titulo, etapa) VALUES ('p1', 'Test', 'borrador_agente')",
      )
      .run();
    const row = testDb
      .prepare("SELECT etapa FROM propuesta WHERE id = 'p1'")
      .get() as any;
    expect(row.etapa).toBe("borrador_agente");
  });

  it("propuesta has agent columns", () => {
    const cols = testDb
      .prepare("PRAGMA table_info(propuesta)")
      .all()
      .map((c: any) => c.name);
    expect(cols).toContain("agente_razonamiento");
    expect(cols).toContain("confianza");
    expect(cols).toContain("insight_origen_id");
  });
});

describe("draftProposalFromInsight", () => {
  it("creates borrador_agente from insight", () => {
    seedInsight(testDb);
    const result = draftProposalFromInsight("ins-test-1");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.propuesta_id).toBeTruthy();
    expect(result.confianza).toBe(0.75);
    const prop = testDb
      .prepare("SELECT etapa, insight_origen_id FROM propuesta WHERE id = ?")
      .get(result.propuesta_id) as any;
    expect(prop.etapa).toBe("borrador_agente");
    expect(prop.insight_origen_id).toBe("ins-test-1");
  });

  it("uses valor_potencial", () => {
    seedInsight(testDb, { valor_potencial: 8000000 });
    const result = draftProposalFromInsight("ins-test-1");
    if ("error" in result) return;
    expect(result.valor_estimado).toBe(8000000);
  });

  it("falls back to historical avg", () => {
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, etapa) VALUES ('h1', 'c1', 'ae1', 'Old', 6000000, 'estacional', 'completada')",
      )
      .run();
    seedInsight(testDb, { valor_potencial: null });
    const result = draftProposalFromInsight("ins-test-1");
    if ("error" in result) return;
    expect(result.valor_estimado).toBe(6000000);
  });

  it("marks insight as convertido", () => {
    seedInsight(testDb);
    const result = draftProposalFromInsight("ins-test-1");
    if ("error" in result) return;
    const ins = testDb
      .prepare(
        "SELECT estado, propuesta_generada_id FROM insight_comercial WHERE id = 'ins-test-1'",
      )
      .get() as any;
    expect(ins.estado).toBe("convertido");
    expect(ins.propuesta_generada_id).toBe(result.propuesta_id);
  });

  it("errors for non-existent insight", () => {
    expect("error" in draftProposalFromInsight("nope")).toBe(true);
  });
});

describe("actuar_insight convertir", () => {
  it("creates draft via convertir", () => {
    seedInsight(testDb);
    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(
      actuar_insight({ insight_id: "ins-test-1", accion: "convertir" }, ctx),
    );
    expect(result.estado_nuevo).toBe("convertido");
    expect(result.propuesta_id).toBeTruthy();
  });
});

describe("revisar_borrador", () => {
  it("shows draft details", () => {
    seedInsight(testDb);
    const draft = draftProposalFromInsight("ins-test-1");
    if ("error" in draft) return;
    const ctx = makeCtx("ae1", "ae");
    const result = JSON.parse(
      revisar_borrador({ propuesta_id: draft.propuesta_id }, ctx),
    );
    expect(result.razonamiento).toBeTruthy();
    expect(result.etapa).toBe("borrador_agente");
  });

  it("rejects non-borrador", () => {
    testDb
      .prepare(
        "INSERT INTO propuesta (id, titulo, ae_id, etapa) VALUES ('p1', 'N', 'ae1', 'en_preparacion')",
      )
      .run();
    const result = JSON.parse(
      revisar_borrador({ propuesta_id: "p1" }, makeCtx("ae1", "ae")),
    );
    expect(result.error).toBeTruthy();
  });
});

describe("modificar_borrador", () => {
  it("modifies value", () => {
    seedInsight(testDb);
    const draft = draftProposalFromInsight("ins-test-1");
    if ("error" in draft) return;
    modificar_borrador(
      { propuesta_id: draft.propuesta_id, valor_estimado: 3000000 },
      makeCtx("ae1", "ae"),
    );
    const prop = testDb
      .prepare("SELECT valor_estimado FROM propuesta WHERE id = ?")
      .get(draft.propuesta_id) as any;
    expect(prop.valor_estimado).toBe(3000000);
  });

  it("promotes with aceptar=true", () => {
    seedInsight(testDb);
    const draft = draftProposalFromInsight("ins-test-1");
    if ("error" in draft) return;
    const result = JSON.parse(
      modificar_borrador(
        { propuesta_id: draft.propuesta_id, aceptar: true },
        makeCtx("ae1", "ae"),
      ),
    );
    expect(result.etapa).toBe("en_preparacion");
  });

  it("rejects empty modifications", () => {
    seedInsight(testDb);
    const draft = draftProposalFromInsight("ins-test-1");
    if ("error" in draft) return;
    const result = JSON.parse(
      modificar_borrador(
        { propuesta_id: draft.propuesta_id },
        makeCtx("ae1", "ae"),
      ),
    );
    expect(result.error).toBeTruthy();
  });
});

describe("feedback-informed drafting", () => {
  function seedFeedback(count: number, valorRatio: number) {
    for (let i = 0; i < count; i++) {
      // Create a propuesta to satisfy FK constraint
      testDb
        .prepare(
          `INSERT OR IGNORE INTO propuesta (id, cuenta_id, ae_id, titulo, etapa) VALUES (?, 'c1', 'ae1', 'FB prop', 'completada')`,
        )
        .run(`prop-fb-${i}`);
      testDb
        .prepare(
          `INSERT INTO feedback_propuesta (id, propuesta_id, ae_id, borrador_valor, final_valor, resultado, fecha_accion)
           VALUES (?, ?, 'ae1', 10000000, ?, 'aceptado_con_cambios', datetime('now'))`,
        )
        .run(`fb-${i}`, `prop-fb-${i}`, Math.round(10000000 * valorRatio));
    }
  }

  it("adjusts value based on historical feedback deltas", () => {
    seedInsight(testDb, { valor_potencial: 10_000_000 });
    seedFeedback(4, 1.2); // AE consistently increases by 20%

    const result = draftProposalFromInsight("ins-test-1");
    if ("error" in result) throw new Error(result.error);
    expect(result.valor_estimado).toBeGreaterThan(10_000_000);
    expect(result.agente_razonamiento).toContain("Aprendizaje");
    expect(result.agente_razonamiento).toContain("incrementa");
  });

  it("does not adjust with fewer than 3 feedback samples", () => {
    seedInsight(testDb, { valor_potencial: 10_000_000 });
    seedFeedback(2, 1.5); // Only 2 — below threshold

    const result = draftProposalFromInsight("ins-test-1");
    if ("error" in result) throw new Error(result.error);
    expect(result.valor_estimado).toBe(10_000_000);
    expect(result.agente_razonamiento).not.toContain("Aprendizaje");
  });
});

describe("pipeline filtering", () => {
  it("excludes borrador_agente from pipeline", async () => {
    const { consultar_pipeline } = await import("../src/tools/consulta.js");
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, etapa) VALUES ('d1', 'c1', 'ae1', 'Draft', 'borrador_agente')",
      )
      .run();
    testDb
      .prepare(
        "INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, etapa) VALUES ('r1', 'c1', 'ae1', 'Real', 'en_preparacion')",
      )
      .run();
    const result = JSON.parse(consultar_pipeline({}, makeCtx("ae1", "ae")));
    const titles = result.propuestas?.map((p: any) => p.titulo) ?? [];
    expect(titles).toContain("Real");
    expect(titles).not.toContain("Draft");
  });
});
