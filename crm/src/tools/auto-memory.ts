/**
 * Auto-memory hook — promotes high-signal tool calls to long-term memory
 * without requiring the agent to call guardar_observacion explicitly.
 *
 * Rationale: in 7+ days of production no agent ever called a memoria_* tool
 * unprompted, so banks stayed empty. Persona instructions are too soft to
 * change model behavior. This hook removes the model-compliance variance:
 * any successful call to a state-changing tool whose args carry real-world
 * facts (interaction summary, win/loss outcome, exec interaction) is
 * synthesized into a one-line observation and retained automatically.
 *
 * Add a new tool by writing a rule below. Keep rules pure (args+ctx in,
 * observation out) — `maybeAutoRetain` handles dispatch, async retain,
 * and error logging.
 */

import { getMemoryService } from "../memory/index.js";
import type { MemoryBank } from "../memory/types.js";
import type { ToolContext } from "./index.js";
import { logger } from "../logger.js";

interface AutoMemoryEntry {
  content: string;
  bank: MemoryBank;
  tags: string[];
}

type AutoMemoryRule = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => AutoMemoryEntry | null;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

export const AUTO_MEMORY_RULES: Record<string, AutoMemoryRule> = {
  registrar_actividad: (args) => {
    const resumen = str(args.resumen);
    const tipo = str(args.tipo);
    const cuenta = str(args.cuenta_nombre);
    if (!resumen || !tipo || !cuenta) return null;
    const sentimiento = str(args.sentimiento) ?? "neutral";
    const propuesta = str(args.propuesta_titulo);
    const propuestaCtx = propuesta ? ` [propuesta: ${propuesta}]` : "";
    return {
      content: `[${tipo} con ${cuenta}, sentimiento: ${sentimiento}]${propuestaCtx} ${resumen}`,
      bank: "crm-accounts",
      tags: ["actividad", tipo, sentimiento, cuenta],
    };
  },

  cerrar_propuesta: (args) => {
    const titulo = str(args.propuesta_titulo);
    const resultado = str(args.resultado);
    if (!titulo || !resultado) return null;
    const cuenta = str(args.cuenta_nombre);
    const razon = str(args.razon);
    const cuentaCtx = cuenta ? ` (${cuenta})` : "";
    const razonCtx = razon ? ` Razon: ${razon}.` : "";
    return {
      content: `Propuesta "${titulo}"${cuentaCtx} cerrada como ${resultado}.${razonCtx}`,
      bank: "crm-sales",
      tags: ["cierre", resultado, ...(cuenta ? [cuenta] : [])],
    };
  },

  registrar_interaccion_ejecutiva: (args) => {
    const contacto = str(args.contacto_nombre);
    const resumen = str(args.resumen);
    if (!contacto || !resumen) return null;
    const tipo = str(args.tipo) ?? "otro";
    const calidad = str(args.calidad) ?? "normal";
    const lugar = str(args.lugar);
    const lugarCtx = lugar ? ` en ${lugar}` : "";
    return {
      content: `[ejecutiva ${tipo} con ${contacto}${lugarCtx}, calidad: ${calidad}] ${resumen}`,
      bank: "crm-accounts",
      tags: ["ejecutiva", tipo, calidad, contacto],
    };
  },
};

/**
 * Apply the auto-memory rule for `name`, if any. Fire-and-forget: never
 * throws, errors are logged. Safe to call from a `finally` block.
 */
export async function maybeAutoRetain(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<void> {
  const rule = AUTO_MEMORY_RULES[name];
  if (!rule) return;

  let entry: AutoMemoryEntry | null;
  try {
    entry = rule(args, ctx);
  } catch (err) {
    logger.warn(
      {
        tool: name,
        op: "auto-memory-rule",
        err: err instanceof Error ? err.message : String(err),
      },
      "auto-memory rule threw",
    );
    return;
  }
  if (!entry) return;

  try {
    await getMemoryService().retain(entry.content, {
      bank: entry.bank,
      personaId: ctx.persona_id,
      tags: entry.tags,
      async: true,
    });
  } catch (err) {
    logger.warn(
      {
        tool: name,
        bank: entry.bank,
        op: "auto-memory-retain",
        err: err instanceof Error ? err.message : String(err),
      },
      "auto-memory retain failed",
    );
  }
}
