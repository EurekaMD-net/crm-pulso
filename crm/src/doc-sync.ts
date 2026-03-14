/**
 * Document Sync Pipeline (Phase 7)
 *
 * Syncs documents from Google Drive into the local RAG store.
 * Pipeline: list files → download → extract text → chunk → embed → store.
 *
 * Embeddings are generated via Dashscope text-embedding-v3 (1024 dims)
 * and indexed with sqlite-vec for fast KNN search.
 *
 * Scheduler writes IPC task every 24h at 3 AM (5-min startup delay).
 * Gracefully degrades when Google is not configured.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDatabase } from "./db.js";
import { embedBatch, embedText } from "./embedding.js";
import { isGoogleEnabled, getDriveClient } from "./google-auth.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------

export interface TextChunk {
  index: number;
  content: string;
}

/**
 * Split text into chunks of ~chunkSize tokens with overlap.
 * Splits by paragraphs first, then sentences if needed.
 */
export function chunkText(
  text: string,
  chunkSize = 512,
  overlap = 64,
): TextChunk[] {
  if (!text || text.trim().length === 0) return [];

  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const chunks: TextChunk[] = [];
  let current = "";
  let idx = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    // Rough token estimate: ~4 chars per token
    if (
      current.length > 0 &&
      (current.length + trimmed.length) / 4 > chunkSize
    ) {
      chunks.push({ index: idx++, content: current.trim() });
      // Overlap: keep last N chars
      const overlapChars = overlap * 4;
      current =
        current.length > overlapChars
          ? current.slice(-overlapChars) + "\n\n" + trimmed
          : trimmed;
    } else {
      current = current ? current + "\n\n" + trimmed : trimmed;
    }
  }

  if (current.trim().length > 0) {
    chunks.push({ index: idx, content: current.trim() });
  }

  // If a single chunk is too large, split by sentences
  const result: TextChunk[] = [];
  let finalIdx = 0;
  for (const chunk of chunks) {
    if (chunk.content.length / 4 > chunkSize * 2) {
      const sentences = chunk.content.split(/(?<=[.!?])\s+/);
      let buf = "";
      for (const sent of sentences) {
        if (buf.length > 0 && (buf.length + sent.length) / 4 > chunkSize) {
          result.push({ index: finalIdx++, content: buf.trim() });
          buf = sent;
        } else {
          buf = buf ? buf + " " + sent : sent;
        }
      }
      if (buf.trim()) result.push({ index: finalIdx++, content: buf.trim() });
    } else {
      result.push({ index: finalIdx++, content: chunk.content });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Document storage
// ---------------------------------------------------------------------------

export async function storeDocument(
  personaId: string,
  source: "drive" | "email" | "manual",
  sourceId: string | null,
  titulo: string,
  tipoDoc: string | null,
  text: string,
): Promise<{ docId: string; chunkCount: number }> {
  const db = getDatabase();
  const contentHash = crypto.createHash("sha256").update(text).digest("hex");

  // Check if document already exists with same hash
  const existing = db
    .prepare(
      "SELECT id FROM crm_documents WHERE source = ? AND source_id = ? AND contenido_hash = ?",
    )
    .get(source, sourceId, contentHash) as any;

  if (existing) {
    return { docId: existing.id, chunkCount: 0 };
  }

  const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const chunks = chunkText(text);
  const now = new Date().toISOString();

  // Generate embeddings via API (batched)
  const embeddings = await embedBatch(chunks.map((c) => c.content));

  const insertDoc = db.prepare(`
    INSERT INTO crm_documents (id, source, source_id, persona_id, titulo, tipo_doc, contenido_hash, chunk_count, fecha_sync, tamano_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertChunk = db.prepare(`
    INSERT INTO crm_embeddings (id, document_id, chunk_index, contenido, embedding)
    VALUES (?, ?, ?, ?, NULL)
  `);

  const insertVec = db.prepare(`
    INSERT INTO crm_vec_embeddings (rowid, embedding)
    VALUES (?, ?)
  `);

  const insertFts = db.prepare(`
    INSERT INTO crm_fts_embeddings (rowid, contenido)
    VALUES (?, ?)
  `);

  const storeAll = db.transaction(() => {
    insertDoc.run(
      docId,
      source,
      sourceId,
      personaId,
      titulo,
      tipoDoc,
      contentHash,
      chunks.length,
      now,
      text.length,
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `emb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const info = insertChunk.run(
        chunkId,
        docId,
        chunks[i].index,
        chunks[i].content,
      );
      const rowid = info.lastInsertRowid;
      insertVec.run(BigInt(rowid as number), embeddings[i]);
      try {
        insertFts.run(BigInt(rowid as number), chunks[i].content);
      } catch {
        // FTS5 may not exist on older DBs — non-fatal
      }
    }
  });

  storeAll();
  return { docId, chunkCount: chunks.length };
}

// ---------------------------------------------------------------------------
// Internal result type for fusion
// ---------------------------------------------------------------------------

interface RankedResult {
  rowid: number;
  contenido: string;
  titulo: string;
  persona_id: string;
}

type SearchResult = {
  titulo: string;
  fragmento: string;
  similitud: number;
  persona_id: string;
};

function truncateFragment(text: string): string {
  return text.length > 300 ? text.slice(0, 300) + "..." : text;
}

// ---------------------------------------------------------------------------
// Vector search (sqlite-vec KNN)
// ---------------------------------------------------------------------------

async function searchDocumentsVector(
  query: string,
  personaIds: string[],
  limite: number,
  tipoDoc?: string,
): Promise<RankedResult[]> {
  const db = getDatabase();
  const queryEmbedding = await embedText(query);

  const overFetchK = Math.max(limite * 5, 50);

  const vecRows = db
    .prepare(
      `
    SELECT rowid, distance
    FROM crm_vec_embeddings
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `,
    )
    .all(queryEmbedding, overFetchK) as {
    rowid: number | bigint;
    distance: number;
  }[];

  if (vecRows.length === 0) return [];

  const rowids = vecRows.map((r) => Number(r.rowid));
  const placeholders = rowids.map(() => "?").join(",");
  let sql = `
    SELECT e.rowid as rid, e.contenido, d.titulo, d.persona_id
    FROM crm_embeddings e
    JOIN crm_documents d ON e.document_id = d.id
    WHERE e.rowid IN (${placeholders})
  `;
  const params: unknown[] = [...rowids];

  if (personaIds.length > 0) {
    sql += ` AND d.persona_id IN (${personaIds.map(() => "?").join(",")})`;
    params.push(...personaIds);
  }
  if (tipoDoc) {
    sql += " AND d.tipo_doc = ?";
    params.push(tipoDoc);
  }

  const metaRows = db.prepare(sql).all(...params) as {
    rid: number | bigint;
    contenido: string;
    titulo: string;
    persona_id: string;
  }[];

  // Sort by distance (lower = better)
  const distanceMap = new Map(
    vecRows.map((r) => [Number(r.rowid), r.distance]),
  );
  return metaRows
    .map((row) => ({
      rowid: Number(row.rid),
      contenido: row.contenido,
      titulo: row.titulo,
      persona_id: row.persona_id,
      _distance: distanceMap.get(Number(row.rid)) ?? Infinity,
    }))
    .sort((a, b) => a._distance - b._distance)
    .map(({ _distance, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Keyword search (FTS5)
// ---------------------------------------------------------------------------

export function searchDocumentsKeyword(
  query: string,
  personaIds: string[],
  limite: number,
  tipoDoc?: string,
): RankedResult[] {
  try {
    const db = getDatabase();

    // Sanitize query: split words, filter short, wrap in quotes
    const words = query.split(/\s+/).filter((w) => w.length >= 2);
    if (words.length === 0) return [];
    const ftsQuery = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" ");

    const overFetchK = Math.max(limite * 3, 30);

    let sql = `
      SELECT e.rowid as rid, e.contenido, d.titulo, d.persona_id
      FROM crm_fts_embeddings fts
      JOIN crm_embeddings e ON e.rowid = fts.rowid
      JOIN crm_documents d ON e.document_id = d.id
      WHERE crm_fts_embeddings MATCH ?
    `;
    const params: unknown[] = [ftsQuery];

    if (personaIds.length > 0) {
      sql += ` AND d.persona_id IN (${personaIds.map(() => "?").join(",")})`;
      params.push(...personaIds);
    }
    if (tipoDoc) {
      sql += " AND d.tipo_doc = ?";
      params.push(tipoDoc);
    }
    sql += " ORDER BY fts.rank LIMIT ?";
    params.push(overFetchK);

    const rows = db.prepare(sql).all(...params) as {
      rid: number | bigint;
      contenido: string;
      titulo: string;
      persona_id: string;
    }[];

    return rows.map((row) => ({
      rowid: Number(row.rid),
      contenido: row.contenido,
      titulo: row.titulo,
      persona_id: row.persona_id,
    }));
  } catch {
    // FTS5 table may not exist on older DBs — graceful fallback
    return [];
  }
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion (ported from Hindsight's fusion.py)
// ---------------------------------------------------------------------------

export function reciprocalRankFusion(
  resultLists: RankedResult[][],
  limite: number,
  k = 60,
): SearchResult[] {
  const scores = new Map<number, number>();
  const metadata = new Map<number, RankedResult>();

  for (const list of resultLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const score = 1 / (k + rank + 1); // 1-indexed rank
      scores.set(item.rowid, (scores.get(item.rowid) ?? 0) + score);
      if (!metadata.has(item.rowid)) {
        metadata.set(item.rowid, item);
      }
    }
  }

  // Normalize to 0-1 range
  const maxPossible = resultLists.length / (k + 1);

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limite)
    .map(([rowid, score]) => {
      const item = metadata.get(rowid)!;
      return {
        titulo: item.titulo,
        fragmento: truncateFragment(item.contenido),
        similitud: Math.round((score / maxPossible) * 100) / 100,
        persona_id: item.persona_id,
      };
    });
}

// ---------------------------------------------------------------------------
// Hybrid document search (vector + keyword + RRF)
// ---------------------------------------------------------------------------

export async function searchDocuments(
  query: string,
  personaIds: string[],
  limite = 5,
  tipoDoc?: string,
): Promise<SearchResult[]> {
  const [vectorResults, keywordResults] = await Promise.all([
    searchDocumentsVector(query, personaIds, limite, tipoDoc),
    Promise.resolve(searchDocumentsKeyword(query, personaIds, limite, tipoDoc)),
  ]);

  // Edge cases
  if (vectorResults.length === 0 && keywordResults.length === 0) return [];

  if (keywordResults.length === 0) {
    return vectorResults.slice(0, limite).map((r) => ({
      titulo: r.titulo,
      fragmento: truncateFragment(r.contenido),
      similitud: 1, // Already sorted by distance
      persona_id: r.persona_id,
    }));
  }

  if (vectorResults.length === 0) {
    return keywordResults.slice(0, limite).map((r) => ({
      titulo: r.titulo,
      fragmento: truncateFragment(r.contenido),
      similitud: 1,
      persona_id: r.persona_id,
    }));
  }

  return reciprocalRankFusion([vectorResults, keywordResults], limite);
}

// ---------------------------------------------------------------------------
// Google Drive sync
// ---------------------------------------------------------------------------

export async function syncPersonaDrive(
  personaId: string,
  personaEmail: string,
): Promise<number> {
  if (!isGoogleEnabled()) return 0;

  const db = getDatabase();
  let synced = 0;

  try {
    const drive = getDriveClient(personaEmail);

    // Get last sync time for this persona
    const lastSync = db
      .prepare(
        "SELECT MAX(fecha_sync) as last FROM crm_documents WHERE persona_id = ? AND source = ?",
      )
      .get(personaId, "drive") as any;

    let query =
      "mimeType != 'application/vnd.google-apps.folder' and trashed = false";
    if (lastSync?.last) {
      query += ` and modifiedTime > '${lastSync.last}'`;
    }

    const res = await drive.files.list({
      q: query,
      pageSize: 50,
      fields: "files(id,name,mimeType,modifiedTime,size)",
    });

    const files = res.data.files ?? [];

    for (const file of files) {
      if (!file.id || !file.name) continue;

      try {
        let text = "";
        const mime = file.mimeType ?? "";

        if (mime === "application/vnd.google-apps.document") {
          // Export Google Docs as plain text
          const exported = await drive.files.export({
            fileId: file.id,
            mimeType: "text/plain",
          });
          text = String(exported.data ?? "");
        } else if (mime === "text/plain" || mime.startsWith("text/")) {
          const downloaded = await drive.files.get({
            fileId: file.id,
            alt: "media",
          });
          text = String(downloaded.data ?? "");
        } else {
          // Skip binary files (PDF, images, etc.) — would need officeparser
          continue;
        }

        if (text.length < 50) continue; // Skip very small files
        if (text.length > 500_000) text = text.slice(0, 500_000); // Cap at 500KB

        const tipoDoc = mime.includes("document")
          ? "google_doc"
          : mime.includes("spreadsheet")
            ? "google_sheet"
            : "text";

        const result = await storeDocument(
          personaId,
          "drive",
          file.id,
          file.name,
          tipoDoc,
          text,
        );
        if (result.chunkCount > 0) synced++;
      } catch (err) {
        logger.warn(
          { err, fileId: file.id, fileName: file.name },
          "Failed to sync Drive file",
        );
      }
    }
  } catch (err) {
    logger.warn({ err, personaId }, "Failed to list Drive files");
  }

  return synced;
}

// ---------------------------------------------------------------------------
// Full sync: all active personas
// ---------------------------------------------------------------------------

export async function syncDocuments(): Promise<number> {
  const db = getDatabase();
  const personas = db
    .prepare(
      "SELECT id, email FROM persona WHERE activo = 1 AND email IS NOT NULL",
    )
    .all() as { id: string; email: string }[];

  let total = 0;
  for (const p of personas) {
    const count = await syncPersonaDrive(p.id, p.email);
    total += count;
  }

  if (total > 0) {
    logger.info({ count: total }, "Documents synced from Drive");
  }
  return total;
}

// ---------------------------------------------------------------------------
// Doc sync scheduler
// ---------------------------------------------------------------------------

export function startDocSyncScheduler(dataDir: string): void {
  const ipcDir = path.join(dataDir, "ipc", "main", "tasks");

  // 5 minute startup delay, then write task
  setTimeout(
    () => {
      writeDocSyncTask(ipcDir);
      // Repeat every 24h
      setInterval(() => writeDocSyncTask(ipcDir), 24 * 60 * 60 * 1000);
    },
    5 * 60 * 1000,
  );
}

function writeDocSyncTask(ipcDir: string): void {
  // Only during low-traffic hours (3 AM Mexico City)
  const hour = parseInt(
    new Date().toLocaleString("en-US", {
      timeZone: "America/Mexico_City",
      hour: "numeric",
      hour12: false,
    }),
  );
  if (hour !== 3) return;

  try {
    fs.mkdirSync(ipcDir, { recursive: true });
    const taskFile = path.join(ipcDir, `doc-sync-${Date.now()}.json`);
    fs.writeFileSync(taskFile, JSON.stringify({ type: "crm_doc_sync" }));
  } catch {
    // Non-critical
  }
}
