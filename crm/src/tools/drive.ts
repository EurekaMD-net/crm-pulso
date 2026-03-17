/**
 * Drive Tools
 *
 * listar_archivos_drive — list files
 * leer_archivo_drive — read file content (truncated to 50KB)
 * crear_documento_drive — create docs/sheets/slides with content
 *
 * All tools gracefully degrade when workspace is not configured.
 */

import { isWorkspaceEnabled, getProvider } from "../workspace/provider.js";
import { getPersonaEmail } from "./helpers.js";
import type { ToolContext } from "./index.js";

// ---------------------------------------------------------------------------
// listar_archivos_drive
// ---------------------------------------------------------------------------

export async function listar_archivos_drive(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  if (!isWorkspaceEnabled()) {
    return JSON.stringify({ error: "Archivos no configurados" });
  }

  const email = getPersonaEmail(ctx.persona_id);
  if (!email) {
    return JSON.stringify({ error: "Persona no tiene email configurado" });
  }

  const query = args.query as string | undefined;
  const carpetaId = args.carpeta_id as string | undefined;
  const limite = (args.limite as number) || 20;

  try {
    const archivos = await getProvider().listFiles(
      email,
      query,
      carpetaId,
      limite,
    );
    return JSON.stringify({ archivos });
  } catch (err: any) {
    return JSON.stringify({
      error: `Error listando archivos: ${err.message?.slice(0, 200) ?? "unknown"}`,
    });
  }
}

// ---------------------------------------------------------------------------
// leer_archivo_drive
// ---------------------------------------------------------------------------

export async function leer_archivo_drive(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  if (!isWorkspaceEnabled()) {
    return JSON.stringify({ error: "Archivos no configurados" });
  }

  const email = getPersonaEmail(ctx.persona_id);
  if (!email) {
    return JSON.stringify({ error: "Persona no tiene email configurado" });
  }

  const archivoId = args.archivo_id as string;
  if (!archivoId) {
    return JSON.stringify({ error: "archivo_id es requerido" });
  }

  try {
    const result = await getProvider().readFile(email, archivoId);
    return JSON.stringify(result);
  } catch (err: any) {
    return JSON.stringify({
      error: `Error leyendo archivo: ${err.message?.slice(0, 200) ?? "unknown"}`,
    });
  }
}

// ---------------------------------------------------------------------------
// crear_documento_drive
// ---------------------------------------------------------------------------

export async function crear_documento_drive(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  if (!isWorkspaceEnabled()) {
    return JSON.stringify({ error: "Archivos no configurados" });
  }

  const email = getPersonaEmail(ctx.persona_id);
  if (!email) {
    return JSON.stringify({ error: "Persona no tiene email configurado" });
  }

  const nombre = args.nombre as string;
  if (!nombre) {
    return JSON.stringify({ error: 'Se requiere "nombre" del documento.' });
  }

  const tipoStr = (args.tipo as string) || "documento";
  if (!["documento", "hoja_de_calculo", "presentacion"].includes(tipoStr)) {
    return JSON.stringify({
      error: `Tipo invalido: "${tipoStr}". Usa: documento, hoja_de_calculo, o presentacion.`,
    });
  }

  const contenido = (args.contenido as string) || undefined;
  const carpetaId = args.carpeta_id as string | undefined;

  try {
    const result = await getProvider().createDocument(
      email,
      nombre,
      tipoStr as "documento" | "hoja_de_calculo" | "presentacion",
      contenido,
      carpetaId,
    );

    const tipoLabel =
      tipoStr === "documento"
        ? "Documento"
        : tipoStr === "hoja_de_calculo"
          ? "Hoja de calculo"
          : "Presentacion";

    return JSON.stringify({
      ok: true,
      archivo_id: result.archivo_id,
      nombre: result.nombre,
      tipo: result.tipo,
      enlace: result.enlace,
      mensaje: `${tipoLabel} "${nombre}" creado exitosamente.`,
    });
  } catch (err: any) {
    return JSON.stringify({
      error: `Error creando documento: ${err.message?.slice(0, 200) ?? "unknown"}`,
    });
  }
}
