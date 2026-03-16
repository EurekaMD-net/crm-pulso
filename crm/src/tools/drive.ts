/**
 * Google Drive Tools
 *
 * listar_archivos_drive — list files/folders from Drive
 * leer_archivo_drive — read file content (truncated to 50KB)
 *
 * All tools gracefully degrade when Google is not configured.
 */

import {
  isGoogleEnabled,
  getDriveClient,
  getDriveWriteClient,
} from "../google-auth.js";
import { getPersonaEmail } from "./helpers.js";
import type { ToolContext } from "./index.js";

// Mapping of user-facing types to Google MIME types
const DOC_TYPES: Record<string, string> = {
  documento: "application/vnd.google-apps.document",
  hoja_de_calculo: "application/vnd.google-apps.spreadsheet",
  presentacion: "application/vnd.google-apps.presentation",
};

// ---------------------------------------------------------------------------
// listar_archivos_drive
// ---------------------------------------------------------------------------

export async function listar_archivos_drive(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  if (!isGoogleEnabled()) {
    return JSON.stringify({ error: "Google Drive no configurado" });
  }

  const email = getPersonaEmail(ctx.persona_id);
  if (!email) {
    return JSON.stringify({ error: "Persona no tiene email configurado" });
  }

  const query = args.query as string | undefined;
  const carpetaId = args.carpeta_id as string | undefined;
  const limite = (args.limite as number) || 20;

  try {
    const drive = getDriveClient(email);

    // Build query string
    const qParts: string[] = [];
    if (query) qParts.push(`fullText contains '${query.replace(/'/g, "\\'")}'`);
    if (carpetaId) qParts.push(`'${carpetaId}' in parents`);
    qParts.push("trashed = false");
    const q = qParts.join(" and ");

    const res = await drive.files.list({
      q,
      pageSize: limite,
      fields: "files(id, name, mimeType, modifiedTime)",
      orderBy: "modifiedTime desc",
    });

    const archivos = (res.data.files ?? []).map((f) => ({
      id: f.id ?? "",
      nombre: f.name ?? "",
      tipo: f.mimeType ?? "",
      fecha: f.modifiedTime ?? "",
    }));

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
  if (!isGoogleEnabled()) {
    return JSON.stringify({ error: "Google Drive no configurado" });
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
    const drive = getDriveClient(email);

    // Get file metadata
    const meta = await drive.files.get({
      fileId: archivoId,
      fields: "id, name, mimeType, size",
    });

    const nombre = meta.data.name ?? "";
    const tipo = meta.data.mimeType ?? "";

    // For Google Docs/Sheets/Slides, export as plain text
    let contenido = "";
    const googleDocTypes = [
      "application/vnd.google-apps.document",
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.google-apps.presentation",
    ];

    if (googleDocTypes.includes(tipo)) {
      const exported = await drive.files.export({
        fileId: archivoId,
        mimeType: "text/plain",
      });
      contenido =
        typeof exported.data === "string"
          ? exported.data
          : JSON.stringify(exported.data);
    } else {
      // Download binary/text file content
      const downloaded = await drive.files.get(
        {
          fileId: archivoId,
          alt: "media",
        },
        { responseType: "text" },
      );
      contenido =
        typeof downloaded.data === "string"
          ? downloaded.data
          : JSON.stringify(downloaded.data);
    }

    // Truncate to 50KB
    if (contenido.length > 50000) {
      contenido = contenido.slice(0, 50000) + "\n... (truncado a 50KB)";
    }

    return JSON.stringify({ nombre, contenido, tipo });
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
  if (!isGoogleEnabled()) {
    return JSON.stringify({ error: "Google Drive no configurado" });
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
  const mimeType = DOC_TYPES[tipoStr];
  if (!mimeType) {
    return JSON.stringify({
      error: `Tipo invalido: "${tipoStr}". Usa: documento, hoja_de_calculo, o presentacion.`,
    });
  }

  const contenido = (args.contenido as string) || undefined;
  const carpetaId = args.carpeta_id as string | undefined;

  try {
    const drive = getDriveWriteClient(email);

    const fileMetadata: Record<string, unknown> = {
      name: nombre,
      mimeType,
    };
    if (carpetaId) {
      fileMetadata.parents = [carpetaId];
    }

    // Create the file
    const created = await drive.files.create({
      requestBody: fileMetadata,
      fields: "id, name, mimeType, webViewLink",
    });

    const fileId = created.data.id!;

    // Make the file accessible to anyone with the link (viewer)
    await drive.permissions.create({
      fileId,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
    });

    // Re-fetch webViewLink after permissions are set
    const updated = await drive.files.get({
      fileId,
      fields: "webViewLink",
    });
    const webLink = updated.data.webViewLink ?? null;

    // If content provided, update the document body
    if (contenido && tipoStr === "documento") {
      // For Google Docs, update via media upload (plain text → converted to Doc format)
      await drive.files.update({
        fileId,
        media: {
          mimeType: "text/plain",
          body: contenido,
        },
      });
    }

    return JSON.stringify({
      ok: true,
      archivo_id: fileId,
      nombre: created.data.name,
      tipo: tipoStr,
      enlace: webLink,
      mensaje: `${tipoStr === "documento" ? "Documento" : tipoStr === "hoja_de_calculo" ? "Hoja de calculo" : "Presentacion"} "${nombre}" creado exitosamente.`,
    });
  } catch (err: any) {
    return JSON.stringify({
      error: `Error creando documento: ${err.message?.slice(0, 200) ?? "unknown"}`,
    });
  }
}
