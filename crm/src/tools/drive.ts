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
  getSlidesClient,
  getSheetsClient,
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

    // Populate content based on document type
    if (contenido) {
      try {
        if (tipoStr === "documento") {
          // Google Docs: update via media upload (plain text → Doc format)
          await drive.files.update({
            fileId,
            media: { mimeType: "text/plain", body: contenido },
          });
        } else if (tipoStr === "presentacion") {
          // Google Slides: create slides from content sections
          const slides = getSlidesClient(email);
          // Split content by double newlines into sections (title = first line, rest = body per slide)
          const sections = contenido.split(/\n\n+/).filter((s) => s.trim());
          const requests: any[] = [];
          for (let i = 0; i < sections.length; i++) {
            const lines = sections[i].split("\n");
            const slideTitle = lines[0]?.trim() || `Slide ${i + 1}`;
            const slideBody = lines.slice(1).join("\n").trim();
            const slideId = `crm_slide_${i}`;
            const titleId = `crm_title_${i}`;
            const bodyId = `crm_body_${i}`;

            requests.push({
              createSlide: {
                objectId: slideId,
                insertionIndex: i + 1, // after the default title slide
                slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
                placeholderIdMappings: [
                  { layoutPlaceholder: { type: "TITLE" }, objectId: titleId },
                  { layoutPlaceholder: { type: "BODY" }, objectId: bodyId },
                ],
              },
            });
            requests.push({
              insertText: { objectId: titleId, text: slideTitle },
            });
            if (slideBody) {
              requests.push({
                insertText: { objectId: bodyId, text: slideBody },
              });
            }
          }
          if (requests.length > 0) {
            // Get the default empty slide ID before adding content
            const pres = await slides.presentations.get({
              presentationId: fileId,
            });
            const defaultSlideId = pres.data.slides?.[0]?.objectId;

            await slides.presentations.batchUpdate({
              presentationId: fileId,
              requestBody: { requests },
            });

            // Delete the default empty title slide
            if (defaultSlideId) {
              await slides.presentations.batchUpdate({
                presentationId: fileId,
                requestBody: {
                  requests: [{ deleteObject: { objectId: defaultSlideId } }],
                },
              });
            }
          }
        } else if (tipoStr === "hoja_de_calculo") {
          // Google Sheets: write rows from content (tab or comma separated)
          const sheets = getSheetsClient(email);
          const rows = contenido
            .split("\n")
            .filter((r) => r.trim())
            .map((row) =>
              row.includes("\t") ? row.split("\t") : row.split(","),
            );
          if (rows.length > 0) {
            // Write values
            await sheets.spreadsheets.values.update({
              spreadsheetId: fileId,
              range: "A1",
              valueInputOption: "USER_ENTERED",
              requestBody: { values: rows },
            });

            // Format: bold header row, freeze it, auto-resize columns
            const numCols = Math.max(...rows.map((r) => r.length));
            await sheets.spreadsheets.batchUpdate({
              spreadsheetId: fileId,
              requestBody: {
                requests: [
                  // Bold header row
                  {
                    repeatCell: {
                      range: {
                        sheetId: 0,
                        startRowIndex: 0,
                        endRowIndex: 1,
                      },
                      cell: {
                        userEnteredFormat: {
                          textFormat: { bold: true },
                          backgroundColor: {
                            red: 0.9,
                            green: 0.9,
                            blue: 0.95,
                          },
                        },
                      },
                      fields:
                        "userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor",
                    },
                  },
                  // Freeze header row
                  {
                    updateSheetProperties: {
                      properties: {
                        sheetId: 0,
                        gridProperties: { frozenRowCount: 1 },
                      },
                      fields: "gridProperties.frozenRowCount",
                    },
                  },
                  // Auto-resize columns to fit content
                  {
                    autoResizeDimensions: {
                      dimensions: {
                        sheetId: 0,
                        dimension: "COLUMNS",
                        startIndex: 0,
                        endIndex: numCols,
                      },
                    },
                  },
                ],
              },
            });
          }
        }
      } catch {
        // Content population failed — file was created but is empty.
        // Non-fatal: return the link and let the user edit manually.
      }
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
