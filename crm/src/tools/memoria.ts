/**
 * Agent Memory Tools — store, search, and reflect on long-term observations.
 *
 * 3 tools that wrap the pluggable MemoryService (Hindsight or SQLite fallback).
 * Bank names are user-facing Spanish; mapped to internal IDs.
 */

import { getMemoryService } from "../memory/index.js";
import type { MemoryBank } from "../memory/types.js";
import type { ToolContext } from "./index.js";

// ---------------------------------------------------------------------------
// Bank mapping (user-facing Spanish → internal ID)
// ---------------------------------------------------------------------------

const BANK_MAP: Record<string, MemoryBank> = {
  ventas: "crm-sales",
  cuentas: "crm-accounts",
  equipo: "crm-team",
};

function resolveBank(bank: string | undefined): MemoryBank {
  return BANK_MAP[bank ?? "ventas"] ?? "crm-sales";
}

// ---------------------------------------------------------------------------
// guardar_observacion
// ---------------------------------------------------------------------------

export async function guardar_observacion(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const contenido = args.contenido as string;
  if (!contenido || typeof contenido !== "string") {
    return JSON.stringify({ error: 'Se requiere el parametro "contenido".' });
  }

  const bank = resolveBank(args.banco as string | undefined);
  const tags = (args.etiquetas as string[]) ?? [];

  await getMemoryService().retain(contenido, {
    bank,
    personaId: ctx.persona_id,
    tags,
    async: true,
  });

  return JSON.stringify({
    mensaje: `Observacion guardada en banco "${args.banco ?? "ventas"}".`,
  });
}

// ---------------------------------------------------------------------------
// buscar_memoria
// ---------------------------------------------------------------------------

export async function buscar_memoria(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const consulta = args.consulta as string;
  if (!consulta || typeof consulta !== "string") {
    return JSON.stringify({ error: 'Se requiere el parametro "consulta".' });
  }

  const bank = resolveBank(args.banco as string | undefined);
  const limite = Math.min(Math.max(Number(args.limite) || 5, 1), 20);

  // Role-based bank access: AE can only search "ventas"
  if (ctx.rol === "ae" && bank !== "crm-sales") {
    return JSON.stringify({
      error: "Solo puedes buscar en el banco de ventas.",
    });
  }

  const memories = await getMemoryService().recall(consulta, {
    bank,
    maxResults: limite,
  });

  if (memories.length === 0) {
    return JSON.stringify({
      mensaje: "No se encontraron memorias relevantes.",
      resultados: [],
    });
  }

  return JSON.stringify({
    resultados: memories.map((m, i) => ({
      indice: i + 1,
      contenido: m.content,
      relevancia: m.relevance ? Math.round(m.relevance * 100) / 100 : undefined,
      fecha: m.createdAt,
    })),
  });
}

// ---------------------------------------------------------------------------
// reflexionar_memoria
// ---------------------------------------------------------------------------

export async function reflexionar_memoria(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<string> {
  const tema = args.tema as string;
  if (!tema || typeof tema !== "string") {
    return JSON.stringify({ error: 'Se requiere el parametro "tema".' });
  }

  const bank = resolveBank(args.banco as string | undefined);

  const reflection = await getMemoryService().reflect(tema, { bank });

  if (!reflection) {
    return JSON.stringify({
      mensaje: "No hay suficientes memorias para reflexionar sobre este tema.",
    });
  }

  return JSON.stringify({ reflexion: reflection });
}
