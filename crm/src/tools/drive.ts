/**
 * Google Drive Tools
 *
 * listar_archivos_drive — list files/folders from Drive
 * leer_archivo_drive — read file content (truncated to 50KB)
 *
 * All tools gracefully degrade when Google is not configured.
 */

import { getDatabase } from '../db.js';
import { isGoogleEnabled, getDriveClient } from '../google-auth.js';
import type { ToolContext } from './index.js';

function getPersonaEmail(personaId: string): string | null {
  const db = getDatabase();
  const row = db.prepare('SELECT email FROM persona WHERE id = ?').get(personaId) as any;
  return row?.email ?? null;
}

// ---------------------------------------------------------------------------
// listar_archivos_drive
// ---------------------------------------------------------------------------

export async function listar_archivos_drive(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  if (!isGoogleEnabled()) {
    return JSON.stringify({ error: 'Google Drive no configurado' });
  }

  const email = getPersonaEmail(ctx.persona_id);
  if (!email) {
    return JSON.stringify({ error: 'Persona no tiene email configurado' });
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
    qParts.push('trashed = false');
    const q = qParts.join(' and ');

    const res = await drive.files.list({
      q,
      pageSize: limite,
      fields: 'files(id, name, mimeType, modifiedTime)',
      orderBy: 'modifiedTime desc',
    });

    const archivos = (res.data.files ?? []).map(f => ({
      id: f.id ?? '',
      nombre: f.name ?? '',
      tipo: f.mimeType ?? '',
      fecha: f.modifiedTime ?? '',
    }));

    return JSON.stringify({ archivos });
  } catch (err: any) {
    return JSON.stringify({ error: `Error listando archivos: ${err.message?.slice(0, 200) ?? 'unknown'}` });
  }
}

// ---------------------------------------------------------------------------
// leer_archivo_drive
// ---------------------------------------------------------------------------

export async function leer_archivo_drive(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  if (!isGoogleEnabled()) {
    return JSON.stringify({ error: 'Google Drive no configurado' });
  }

  const email = getPersonaEmail(ctx.persona_id);
  if (!email) {
    return JSON.stringify({ error: 'Persona no tiene email configurado' });
  }

  const archivoId = args.archivo_id as string;
  if (!archivoId) {
    return JSON.stringify({ error: 'archivo_id es requerido' });
  }

  try {
    const drive = getDriveClient(email);

    // Get file metadata
    const meta = await drive.files.get({
      fileId: archivoId,
      fields: 'id, name, mimeType, size',
    });

    const nombre = meta.data.name ?? '';
    const tipo = meta.data.mimeType ?? '';

    // For Google Docs/Sheets/Slides, export as plain text
    let contenido = '';
    const googleDocTypes = [
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation',
    ];

    if (googleDocTypes.includes(tipo)) {
      const exported = await drive.files.export({
        fileId: archivoId,
        mimeType: 'text/plain',
      });
      contenido = typeof exported.data === 'string' ? exported.data : JSON.stringify(exported.data);
    } else {
      // Download binary/text file content
      const downloaded = await drive.files.get({
        fileId: archivoId,
        alt: 'media',
      }, { responseType: 'text' });
      contenido = typeof downloaded.data === 'string' ? downloaded.data : JSON.stringify(downloaded.data);
    }

    // Truncate to 50KB
    if (contenido.length > 50000) {
      contenido = contenido.slice(0, 50000) + '\n... (truncado a 50KB)';
    }

    return JSON.stringify({ nombre, contenido, tipo });
  } catch (err: any) {
    return JSON.stringify({ error: `Error leyendo archivo: ${err.message?.slice(0, 200) ?? 'unknown'}` });
  }
}
