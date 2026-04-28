/**
 * Auto-memory hook tests.
 *
 * The 3 rules are pure functions of (args, ctx) — tested directly. The
 * `maybeAutoRetain` dispatcher is tested with a mocked memory service to
 * verify success-path retain calls + error swallowing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { noopLogger, retainSpy } = vi.hoisted(() => {
  const noop = () => {};
  const logger: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
  };
  logger.child = () => logger;
  return {
    noopLogger: logger,
    retainSpy: vi.fn(async () => {}),
  };
});

vi.mock("../src/logger.js", () => ({ logger: noopLogger }));
vi.mock("../src/memory/index.js", () => ({
  getMemoryService: () => ({
    retain: retainSpy,
    recall: vi.fn(async () => []),
    reflect: vi.fn(async () => ""),
    isHealthy: vi.fn(async () => true),
  }),
}));

import {
  AUTO_MEMORY_RULES,
  maybeAutoRetain,
} from "../src/tools/auto-memory.js";
import type { ToolContext } from "../src/tools/index.js";

const ctx: ToolContext = {
  persona_id: "ae1",
  rol: "ae",
  team_ids: [],
  full_team_ids: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  retainSpy.mockClear();
  retainSpy.mockImplementation(async () => {});
});

describe("AUTO_MEMORY_RULES.registrar_actividad", () => {
  it("emits an account-bank observation with sentiment + tipo + cuenta tags", () => {
    const entry = AUTO_MEMORY_RULES.registrar_actividad(
      {
        cuenta_nombre: "Coca-Cola",
        tipo: "reunion",
        resumen: "Hablamos de presupuesto Q3",
        sentimiento: "positivo",
      },
      ctx,
    );
    expect(entry).toEqual({
      content:
        "[reunion con Coca-Cola, sentimiento: positivo] Hablamos de presupuesto Q3",
      bank: "crm-accounts",
      tags: ["actividad", "reunion", "positivo", "Coca-Cola"],
    });
  });

  it("includes propuesta context when present", () => {
    const entry = AUTO_MEMORY_RULES.registrar_actividad(
      {
        cuenta_nombre: "Bimbo",
        tipo: "llamada",
        resumen: "Confirmaron oferta",
        propuesta_titulo: "Q4 tentpole",
      },
      ctx,
    );
    expect(entry?.content).toContain("[propuesta: Q4 tentpole]");
    expect(entry?.content).toContain("sentimiento: neutral"); // default
  });

  it("returns null when required fields missing", () => {
    expect(
      AUTO_MEMORY_RULES.registrar_actividad({ tipo: "llamada" }, ctx),
    ).toBeNull();
    expect(
      AUTO_MEMORY_RULES.registrar_actividad(
        { cuenta_nombre: "X", resumen: "Y" }, // no tipo
        ctx,
      ),
    ).toBeNull();
  });
});

describe("AUTO_MEMORY_RULES.cerrar_propuesta", () => {
  it("emits a sales-bank observation with razon when provided", () => {
    const entry = AUTO_MEMORY_RULES.cerrar_propuesta(
      {
        propuesta_titulo: "Tentpole Mundial",
        cuenta_nombre: "Heineken",
        resultado: "perdida",
        razon: "Cliente eligio competidor por precio",
      },
      ctx,
    );
    expect(entry?.bank).toBe("crm-sales");
    expect(entry?.content).toBe(
      'Propuesta "Tentpole Mundial" (Heineken) cerrada como perdida. Razon: Cliente eligio competidor por precio.',
    );
    expect(entry?.tags).toEqual(["cierre", "perdida", "Heineken"]);
  });

  it("works without optional cuenta and razon", () => {
    const entry = AUTO_MEMORY_RULES.cerrar_propuesta(
      { propuesta_titulo: "X", resultado: "completada" },
      ctx,
    );
    expect(entry?.content).toBe('Propuesta "X" cerrada como completada.');
    expect(entry?.tags).toEqual(["cierre", "completada"]);
  });

  it("returns null without resultado or titulo", () => {
    expect(
      AUTO_MEMORY_RULES.cerrar_propuesta({ propuesta_titulo: "X" }, ctx),
    ).toBeNull();
    expect(
      AUTO_MEMORY_RULES.cerrar_propuesta({ resultado: "perdida" }, ctx),
    ).toBeNull();
  });
});

describe("AUTO_MEMORY_RULES.registrar_interaccion_ejecutiva", () => {
  it("emits an account-bank observation with calidad + lugar", () => {
    const entry = AUTO_MEMORY_RULES.registrar_interaccion_ejecutiva(
      {
        contacto_nombre: "Fernando Ochoa",
        tipo: "comida",
        resumen: "Habló de su proceso de renovación",
        calidad: "excepcional",
        lugar: "Pujol",
      },
      ctx,
    );
    expect(entry).toEqual({
      content:
        "[ejecutiva comida con Fernando Ochoa en Pujol, calidad: excepcional] Habló de su proceso de renovación",
      bank: "crm-accounts",
      tags: ["ejecutiva", "comida", "excepcional", "Fernando Ochoa"],
    });
  });
});

describe("maybeAutoRetain", () => {
  it("calls retain with rule output for known tools", async () => {
    await maybeAutoRetain(
      "registrar_actividad",
      {
        cuenta_nombre: "Bimbo",
        tipo: "llamada",
        resumen: "Quote pendiente",
        sentimiento: "urgente",
      },
      ctx,
    );
    expect(retainSpy).toHaveBeenCalledTimes(1);
    expect(retainSpy).toHaveBeenCalledWith(
      expect.stringContaining("urgente"),
      expect.objectContaining({
        bank: "crm-accounts",
        personaId: "ae1",
        async: true,
      }),
    );
  });

  it("is a no-op for tools without a rule", async () => {
    await maybeAutoRetain("consultar_pipeline", {}, ctx);
    expect(retainSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when the rule returns null (incomplete args)", async () => {
    await maybeAutoRetain("cerrar_propuesta", { propuesta_titulo: "X" }, ctx);
    expect(retainSpy).not.toHaveBeenCalled();
  });

  it("swallows retain failures (does not throw)", async () => {
    retainSpy.mockImplementationOnce(async () => {
      throw new Error("hindsight down");
    });
    await expect(
      maybeAutoRetain(
        "registrar_actividad",
        { cuenta_nombre: "X", tipo: "llamada", resumen: "Y" },
        ctx,
      ),
    ).resolves.toBeUndefined();
  });
});
