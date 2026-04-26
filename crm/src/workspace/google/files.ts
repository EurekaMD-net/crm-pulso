/**
 * Google File Operations — Drive, Slides, Sheets APIs
 */

import {
  getDriveClient,
  getDriveWriteClient,
  getSlidesClient,
  getSheetsClient,
} from "./auth.js";
import type {
  FileListResult,
  FileContent,
  FileCreateResult,
  DocType,
  SyncFile,
} from "../types.js";

/**
 * Wrap a Google API promise with an explicit timeout. googleapis defaults
 * can hang 2+ minutes on a partial outage, which blocks the inference loop.
 * 15s is enough for normal calls and small uploads; populateSlides/Sheets
 * uses a longer value because large decks legitimately take longer.
 */
const GOOGLE_TIMEOUT_MS = 15_000;
const GOOGLE_WRITE_TIMEOUT_MS = 30_000;

/**
 * Escape a string for safe embedding inside Drive's `q` query language.
 * Drive uses single-quoted string literals; backslash is the escape char.
 * Order matters: backslashes MUST be escaped first, otherwise the
 * escape backslash we add in front of `'` would itself be re-escaped.
 *
 * Real-world inputs that need this: Mexican surnames like O'Brien, Drive
 * folder names that contain quotes, sync timestamps from external state.
 *
 * Reference: https://developers.google.com/drive/api/guides/ref-search-terms
 */
export function escapeDriveQueryString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Google API timeout (${label}, ${ms}ms)`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Lightweight markdown → HTML for Google Docs upload. No external deps. */
function markdownToHtml(md: string): string {
  return (
    md
      .split("\n")
      .map((line) => {
        // Headings
        if (line.startsWith("### ")) return `<h3>${line.slice(4)}</h3>`;
        if (line.startsWith("## ")) return `<h2>${line.slice(3)}</h2>`;
        if (line.startsWith("# ")) return `<h1>${line.slice(2)}</h1>`;
        // Horizontal rule
        if (/^---+$/.test(line.trim())) return "<hr>";
        // List items
        if (/^\s*[-*•]\s/.test(line))
          return `<li>${line.replace(/^\s*[-*•]\s/, "")}</li>`;
        if (/^\s*\d+\.\s/.test(line))
          return `<li>${line.replace(/^\s*\d+\.\s/, "")}</li>`;
        // Empty line → paragraph break
        if (!line.trim()) return "<br>";
        // Normal line
        return `<p>${line}</p>`;
      })
      .join("\n")
      // Inline formatting
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/\*(.+?)\*/g, "<i>$1</i>")
      .replace(/_(.+?)_/g, "<i>$1</i>")
      .replace(/`(.+?)`/g, "<code>$1</code>")
  );
}

const DOC_TYPES: Record<string, string> = {
  documento: "application/vnd.google-apps.document",
  hoja_de_calculo: "application/vnd.google-apps.spreadsheet",
  presentacion: "application/vnd.google-apps.presentation",
};

const GOOGLE_DOC_MIMES = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
];

export async function listFiles(
  email: string,
  query?: string,
  folderId?: string,
  limit = 20,
): Promise<FileListResult[]> {
  const drive = getDriveClient(email);

  const qParts: string[] = [];
  if (query)
    qParts.push(`fullText contains '${escapeDriveQueryString(query)}'`);
  if (folderId) qParts.push(`'${escapeDriveQueryString(folderId)}' in parents`);
  qParts.push("trashed = false");

  const res = await withTimeout(
    drive.files.list({
      q: qParts.join(" and "),
      pageSize: limit,
      fields: "files(id, name, mimeType, modifiedTime)",
      orderBy: "modifiedTime desc",
    }),
    GOOGLE_TIMEOUT_MS,
    "drive.files.list",
  );

  return (res.data.files ?? []).map((f) => ({
    id: f.id ?? "",
    nombre: f.name ?? "",
    tipo: f.mimeType ?? "",
    fecha: f.modifiedTime ?? "",
  }));
}

export async function readFile(
  email: string,
  fileId: string,
): Promise<FileContent> {
  const drive = getDriveClient(email);

  const meta = await withTimeout(
    drive.files.get({
      fileId,
      fields: "id, name, mimeType, size",
    }),
    GOOGLE_TIMEOUT_MS,
    "drive.files.get",
  );

  const nombre = meta.data.name ?? "";
  const tipo = meta.data.mimeType ?? "";

  let contenido = "";
  if (GOOGLE_DOC_MIMES.includes(tipo)) {
    const exported = await withTimeout(
      drive.files.export({
        fileId,
        mimeType: "text/plain",
      }),
      GOOGLE_TIMEOUT_MS,
      "drive.files.export",
    );
    contenido =
      typeof exported.data === "string"
        ? exported.data
        : JSON.stringify(exported.data);
  } else {
    const downloaded = await withTimeout(
      drive.files.get({ fileId, alt: "media" }, { responseType: "text" }),
      GOOGLE_TIMEOUT_MS,
      "drive.files.get(media)",
    );
    contenido =
      typeof downloaded.data === "string"
        ? downloaded.data
        : JSON.stringify(downloaded.data);
  }

  if (contenido.length > 50000) {
    contenido = contenido.slice(0, 50000) + "\n... (truncado a 50KB)";
  }

  return { nombre, contenido, tipo };
}

export async function createDocument(
  email: string,
  name: string,
  type: DocType,
  content?: string,
  folderId?: string,
): Promise<FileCreateResult> {
  const mimeType = DOC_TYPES[type];
  if (!mimeType) throw new Error(`Invalid doc type: ${type}`);

  const drive = getDriveWriteClient(email);

  const fileMetadata: Record<string, unknown> = { name, mimeType };
  if (folderId) fileMetadata.parents = [folderId];

  const created = await withTimeout(
    drive.files.create({
      requestBody: fileMetadata,
      fields: "id, name, mimeType, webViewLink",
    }),
    GOOGLE_WRITE_TIMEOUT_MS,
    "drive.files.create",
  );

  const fileId = created.data.id!;

  // Make accessible via link
  await withTimeout(
    drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
    }),
    GOOGLE_TIMEOUT_MS,
    "drive.permissions.create",
  );

  const updated = await withTimeout(
    drive.files.get({ fileId, fields: "webViewLink" }),
    GOOGLE_TIMEOUT_MS,
    "drive.files.get(link)",
  );
  const webLink = updated.data.webViewLink ?? null;

  // Populate content
  if (content) {
    try {
      if (type === "documento") {
        // Convert markdown to basic HTML so Google Docs renders formatting
        const html = markdownToHtml(content);
        await withTimeout(
          drive.files.update({
            fileId,
            media: { mimeType: "text/html", body: html },
          }),
          GOOGLE_WRITE_TIMEOUT_MS,
          "drive.files.update(doc)",
        );
      } else if (type === "presentacion") {
        await populateSlides(email, fileId, content);
      } else if (type === "hoja_de_calculo") {
        await populateSheet(email, fileId, content);
      }
    } catch {
      // Content population failed — file created empty. Non-fatal.
    }
  }

  return {
    archivo_id: fileId,
    nombre: created.data.name ?? name,
    tipo: type,
    enlace: webLink,
  };
}

async function populateSlides(
  email: string,
  fileId: string,
  content: string,
): Promise<void> {
  const slides = getSlidesClient(email);
  const sections = content.split(/\n\n+/).filter((s) => s.trim());
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
        insertionIndex: i + 1,
        slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
        placeholderIdMappings: [
          { layoutPlaceholder: { type: "TITLE" }, objectId: titleId },
          { layoutPlaceholder: { type: "BODY" }, objectId: bodyId },
        ],
      },
    });
    requests.push({ insertText: { objectId: titleId, text: slideTitle } });
    if (slideBody) {
      requests.push({ insertText: { objectId: bodyId, text: slideBody } });
    }
  }

  if (requests.length > 0) {
    const pres = await slides.presentations.get({ presentationId: fileId });
    const defaultSlideId = pres.data.slides?.[0]?.objectId;

    await slides.presentations.batchUpdate({
      presentationId: fileId,
      requestBody: { requests },
    });

    if (defaultSlideId) {
      await slides.presentations.batchUpdate({
        presentationId: fileId,
        requestBody: {
          requests: [{ deleteObject: { objectId: defaultSlideId } }],
        },
      });
    }
  }
}

async function populateSheet(
  email: string,
  fileId: string,
  content: string,
): Promise<void> {
  const sheets = getSheetsClient(email);
  const rows = content
    .split("\n")
    .filter((r) => r.trim())
    .map((row) => (row.includes("\t") ? row.split("\t") : row.split(",")));

  if (rows.length === 0) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId: fileId,
    range: "A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });

  const numCols = Math.max(...rows.map((r) => r.length));
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: fileId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.9, green: 0.9, blue: 0.95 },
              },
            },
            fields:
              "userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor",
          },
        },
        {
          updateSheetProperties: {
            properties: {
              sheetId: 0,
              gridProperties: { frozenRowCount: 1 },
            },
            fields: "gridProperties.frozenRowCount",
          },
        },
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

// ---------------------------------------------------------------------------
// Doc sync operations
// ---------------------------------------------------------------------------

export async function listModifiedFiles(
  email: string,
  since?: string,
): Promise<SyncFile[]> {
  const drive = getDriveClient(email);

  let query =
    "mimeType != 'application/vnd.google-apps.folder' and trashed = false";
  if (since) {
    query += ` and modifiedTime > '${escapeDriveQueryString(since)}'`;
  }

  const res = await drive.files.list({
    q: query,
    pageSize: 50,
    fields: "files(id,name,mimeType,modifiedTime,size)",
  });

  return (res.data.files ?? []).map((f) => ({
    id: f.id ?? "",
    name: f.name ?? "",
    mimeType: f.mimeType ?? "",
    modifiedTime: f.modifiedTime ?? "",
    size: f.size ? Number(f.size) : undefined,
  }));
}

export async function exportFileText(
  email: string,
  fileId: string,
  mimeType: string,
): Promise<string> {
  const drive = getDriveClient(email);

  if (mimeType === "application/vnd.google-apps.document") {
    const exported = await drive.files.export({
      fileId,
      mimeType: "text/plain",
    });
    return String(exported.data ?? "");
  } else if (mimeType === "text/plain" || mimeType.startsWith("text/")) {
    const downloaded = await drive.files.get({ fileId, alt: "media" });
    return String(downloaded.data ?? "");
  }

  return ""; // Binary files not supported for text extraction
}
