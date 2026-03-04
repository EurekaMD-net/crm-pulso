/**
 * Document Sync Pipeline (Phase 7)
 *
 * Syncs documents from Google Drive into the local RAG store.
 * Pipeline: list files → download → extract text → chunk → embed → store.
 *
 * Scheduler writes IPC task every 24h at 3 AM (5-min startup delay).
 * Gracefully degrades when Google is not configured.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../../engine/src/db.js';
import { isGoogleEnabled, getDriveClient } from './google-auth.js';
import { logger } from './logger.js';

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
export function chunkText(text: string, chunkSize = 512, overlap = 64): TextChunk[] {
  if (!text || text.trim().length === 0) return [];

  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  const chunks: TextChunk[] = [];
  let current = '';
  let idx = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    // Rough token estimate: ~4 chars per token
    if (current.length > 0 && (current.length + trimmed.length) / 4 > chunkSize) {
      chunks.push({ index: idx++, content: current.trim() });
      // Overlap: keep last N chars
      const overlapChars = overlap * 4;
      current = current.length > overlapChars
        ? current.slice(-overlapChars) + '\n\n' + trimmed
        : trimmed;
    } else {
      current = current ? current + '\n\n' + trimmed : trimmed;
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
      let buf = '';
      for (const sent of sentences) {
        if (buf.length > 0 && (buf.length + sent.length) / 4 > chunkSize) {
          result.push({ index: finalIdx++, content: buf.trim() });
          buf = sent;
        } else {
          buf = buf ? buf + ' ' + sent : sent;
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
// Simple embedding (TF-IDF-like bag of words for JS-only fallback)
// ---------------------------------------------------------------------------

/**
 * Generate a simple embedding vector for text.
 * Uses a deterministic hash-based approach (bag of trigrams → fixed-dim vector).
 * This is a lightweight fallback — replace with HuggingFace transformers for production.
 */
export function embedText(text: string, dims = 384): Float32Array {
  const vec = new Float32Array(dims);
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, '');
  const words = normalized.split(/\s+/).filter(w => w.length > 1);

  for (const word of words) {
    // Hash each word to multiple dimensions
    for (let i = 0; i < Math.min(word.length - 1, 3); i++) {
      const trigram = word.slice(i, i + 3) || word;
      const hash = simpleHash(trigram);
      const dim = Math.abs(hash) % dims;
      vec[dim] += (hash > 0 ? 1 : -1);
    }
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) vec[i] /= norm;

  return vec;
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ---------------------------------------------------------------------------
// Document storage
// ---------------------------------------------------------------------------

export function storeDocument(
  personaId: string,
  source: 'drive' | 'email' | 'manual',
  sourceId: string | null,
  titulo: string,
  tipoDoc: string | null,
  text: string,
): { docId: string; chunkCount: number } {
  const db = getDatabase();
  const contentHash = crypto.createHash('sha256').update(text).digest('hex');

  // Check if document already exists with same hash
  const existing = db.prepare(
    'SELECT id FROM crm_documents WHERE source = ? AND source_id = ? AND contenido_hash = ?',
  ).get(source, sourceId, contentHash) as any;

  if (existing) {
    return { docId: existing.id, chunkCount: 0 };
  }

  const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const chunks = chunkText(text);
  const now = new Date().toISOString();

  const insertDoc = db.prepare(`
    INSERT INTO crm_documents (id, source, source_id, persona_id, titulo, tipo_doc, contenido_hash, chunk_count, fecha_sync, tamano_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertChunk = db.prepare(`
    INSERT INTO crm_embeddings (id, document_id, chunk_index, contenido, embedding)
    VALUES (?, ?, ?, ?, ?)
  `);

  const storeAll = db.transaction(() => {
    insertDoc.run(docId, source, sourceId, personaId, titulo, tipoDoc, contentHash, chunks.length, now, text.length);

    for (const chunk of chunks) {
      const embedding = embedText(chunk.content);
      const embeddingBlob = Buffer.from(embedding.buffer);
      const chunkId = `emb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      insertChunk.run(chunkId, docId, chunk.index, chunk.content, embeddingBlob);
    }
  });

  storeAll();
  return { docId, chunkCount: chunks.length };
}

// ---------------------------------------------------------------------------
// Document search (cosine similarity in JS)
// ---------------------------------------------------------------------------

export function searchDocuments(
  query: string,
  personaIds: string[],
  limite = 5,
  tipoDoc?: string,
): { titulo: string; fragmento: string; similitud: number; persona_id: string }[] {
  const db = getDatabase();
  const queryEmbed = embedText(query);

  // Build persona filter
  let personaFilter = '';
  const params: unknown[] = [];
  if (personaIds.length > 0) {
    personaFilter = `AND d.persona_id IN (${personaIds.map(() => '?').join(',')})`;
    params.push(...personaIds);
  }

  let tipoFilter = '';
  if (tipoDoc) {
    tipoFilter = 'AND d.tipo_doc = ?';
    params.push(tipoDoc);
  }

  const rows = db.prepare(`
    SELECT e.contenido, e.embedding, d.titulo, d.persona_id
    FROM crm_embeddings e
    JOIN crm_documents d ON e.document_id = d.id
    WHERE 1=1 ${personaFilter} ${tipoFilter}
  `).all(...params) as any[];

  // Score each chunk
  const scored = rows
    .map(row => {
      const stored = new Float32Array(new Uint8Array(row.embedding).buffer);
      return {
        titulo: row.titulo,
        fragmento: row.contenido.length > 300 ? row.contenido.slice(0, 300) + '...' : row.contenido,
        similitud: cosineSimilarity(queryEmbed, stored),
        persona_id: row.persona_id,
      };
    })
    .sort((a, b) => b.similitud - a.similitud)
    .slice(0, limite);

  return scored;
}

// ---------------------------------------------------------------------------
// Google Drive sync
// ---------------------------------------------------------------------------

export async function syncPersonaDrive(personaId: string, personaEmail: string): Promise<number> {
  if (!isGoogleEnabled()) return 0;

  const db = getDatabase();
  let synced = 0;

  try {
    const drive = getDriveClient(personaEmail);

    // Get last sync time for this persona
    const lastSync = db.prepare(
      'SELECT MAX(fecha_sync) as last FROM crm_documents WHERE persona_id = ? AND source = ?',
    ).get(personaId, 'drive') as any;

    let query = "mimeType != 'application/vnd.google-apps.folder' and trashed = false";
    if (lastSync?.last) {
      query += ` and modifiedTime > '${lastSync.last}'`;
    }

    const res = await drive.files.list({
      q: query,
      pageSize: 50,
      fields: 'files(id,name,mimeType,modifiedTime,size)',
    });

    const files = res.data.files ?? [];

    for (const file of files) {
      if (!file.id || !file.name) continue;

      try {
        let text = '';
        const mime = file.mimeType ?? '';

        if (mime === 'application/vnd.google-apps.document') {
          // Export Google Docs as plain text
          const exported = await drive.files.export({ fileId: file.id, mimeType: 'text/plain' });
          text = String(exported.data ?? '');
        } else if (mime === 'text/plain' || mime.startsWith('text/')) {
          const downloaded = await drive.files.get({ fileId: file.id, alt: 'media' });
          text = String(downloaded.data ?? '');
        } else {
          // Skip binary files (PDF, images, etc.) — would need officeparser
          continue;
        }

        if (text.length < 50) continue; // Skip very small files
        if (text.length > 500_000) text = text.slice(0, 500_000); // Cap at 500KB

        const tipoDoc = mime.includes('document') ? 'google_doc'
          : mime.includes('spreadsheet') ? 'google_sheet'
          : 'text';

        const result = storeDocument(personaId, 'drive', file.id, file.name, tipoDoc, text);
        if (result.chunkCount > 0) synced++;
      } catch (err) {
        logger.warn({ err, fileId: file.id, fileName: file.name }, 'Failed to sync Drive file');
      }
    }
  } catch (err) {
    logger.warn({ err, personaId }, 'Failed to list Drive files');
  }

  return synced;
}

// ---------------------------------------------------------------------------
// Full sync: all active personas
// ---------------------------------------------------------------------------

export async function syncDocuments(): Promise<number> {
  const db = getDatabase();
  const personas = db.prepare(
    "SELECT id, email FROM persona WHERE activo = 1 AND email IS NOT NULL",
  ).all() as { id: string; email: string }[];

  let total = 0;
  for (const p of personas) {
    const count = await syncPersonaDrive(p.id, p.email);
    total += count;
  }

  if (total > 0) {
    logger.info({ count: total }, 'Documents synced from Drive');
  }
  return total;
}

// ---------------------------------------------------------------------------
// Doc sync scheduler
// ---------------------------------------------------------------------------

export function startDocSyncScheduler(dataDir: string): void {
  const ipcDir = path.join(dataDir, 'ipc', 'main', 'tasks');

  // 5 minute startup delay, then write task
  setTimeout(() => {
    writeDocSyncTask(ipcDir);
    // Repeat every 24h
    setInterval(() => writeDocSyncTask(ipcDir), 24 * 60 * 60 * 1000);
  }, 5 * 60 * 1000);
}

function writeDocSyncTask(ipcDir: string): void {
  // Only during low-traffic hours (3 AM Mexico City)
  const hour = parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City', hour: 'numeric', hour12: false }),
  );
  if (hour !== 3) return;

  try {
    fs.mkdirSync(ipcDir, { recursive: true });
    const taskFile = path.join(ipcDir, `doc-sync-${Date.now()}.json`);
    fs.writeFileSync(taskFile, JSON.stringify({ type: 'crm_doc_sync' }));
  } catch {
    // Non-critical
  }
}
