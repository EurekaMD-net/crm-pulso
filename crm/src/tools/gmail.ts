/**
 * Gmail Tools
 *
 * buscar_emails — search inbox with Gmail API
 * leer_email — read full email content
 * crear_borrador_email — create a draft email
 *
 * All tools gracefully degrade when Google is not configured.
 */

import { getDatabase } from '../../../engine/src/db.js';
import { isGoogleEnabled, getGmailReadClient, getGmailClient } from '../google-auth.js';
import type { ToolContext } from './index.js';

function getPersonaEmail(personaId: string): string | null {
  const db = getDatabase();
  const row = db.prepare('SELECT email FROM persona WHERE id = ?').get(personaId) as any;
  return row?.email ?? null;
}

// ---------------------------------------------------------------------------
// buscar_emails
// ---------------------------------------------------------------------------

export async function buscar_emails(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  if (!isGoogleEnabled()) {
    return JSON.stringify({ error: 'Gmail no configurado' });
  }

  const email = getPersonaEmail(ctx.persona_id);
  if (!email) {
    return JSON.stringify({ error: 'Persona no tiene email configurado' });
  }

  const query = args.query as string | undefined;
  const limite = (args.limite as number) || 10;

  try {
    const gmail = getGmailReadClient(email);
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query ?? '',
      maxResults: limite,
    });

    const messages = res.data.messages ?? [];
    const emails: Array<{ id: string; from: string; subject: string; date: string; snippet: string }> = [];

    for (const msg of messages) {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });

      const headers = detail.data.payload?.headers ?? [];
      const from = headers.find(h => h.name === 'From')?.value ?? '';
      const subject = headers.find(h => h.name === 'Subject')?.value ?? '';
      const date = headers.find(h => h.name === 'Date')?.value ?? '';

      emails.push({
        id: msg.id!,
        from,
        subject,
        date,
        snippet: detail.data.snippet ?? '',
      });
    }

    return JSON.stringify({ emails });
  } catch (err: any) {
    return JSON.stringify({ error: `Error buscando emails: ${err.message?.slice(0, 200) ?? 'unknown'}` });
  }
}

// ---------------------------------------------------------------------------
// leer_email
// ---------------------------------------------------------------------------

export async function leer_email(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  if (!isGoogleEnabled()) {
    return JSON.stringify({ error: 'Gmail no configurado' });
  }

  const email = getPersonaEmail(ctx.persona_id);
  if (!email) {
    return JSON.stringify({ error: 'Persona no tiene email configurado' });
  }

  const emailId = args.email_id as string;
  if (!emailId) {
    return JSON.stringify({ error: 'email_id es requerido' });
  }

  try {
    const gmail = getGmailReadClient(email);
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: emailId,
      format: 'full',
    });

    const headers = detail.data.payload?.headers ?? [];
    const from = headers.find(h => h.name === 'From')?.value ?? '';
    const to = headers.find(h => h.name === 'To')?.value ?? '';
    const subject = headers.find(h => h.name === 'Subject')?.value ?? '';
    const date = headers.find(h => h.name === 'Date')?.value ?? '';

    // Extract body from payload
    let body = '';
    const payload = detail.data.payload;
    if (payload?.body?.data) {
      body = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    } else if (payload?.parts) {
      const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
      const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
      const part = textPart ?? htmlPart;
      if (part?.body?.data) {
        body = Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
    }

    // Truncate body to 50KB
    if (body.length > 50000) {
      body = body.slice(0, 50000) + '\n... (truncado)';
    }

    return JSON.stringify({ from, to, subject, date, body });
  } catch (err: any) {
    return JSON.stringify({ error: `Error leyendo email: ${err.message?.slice(0, 200) ?? 'unknown'}` });
  }
}

// ---------------------------------------------------------------------------
// crear_borrador_email
// ---------------------------------------------------------------------------

export async function crear_borrador_email(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  if (!isGoogleEnabled()) {
    return JSON.stringify({ error: 'Gmail no configurado' });
  }

  const email = getPersonaEmail(ctx.persona_id);
  if (!email) {
    return JSON.stringify({ error: 'Persona no tiene email configurado' });
  }

  const destinatario = args.destinatario as string;
  const asunto = args.asunto as string;
  const cuerpo = args.cuerpo as string;

  if (!destinatario || !asunto || !cuerpo) {
    return JSON.stringify({ error: 'destinatario, asunto y cuerpo son requeridos' });
  }

  try {
    const gmail = getGmailClient(email);
    const raw = Buffer.from(
      `From: ${email}\r\nTo: ${destinatario}\r\nSubject: ${asunto}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${cuerpo}`,
    ).toString('base64url');

    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: { raw },
      },
    });

    return JSON.stringify({
      draft_id: res.data.id ?? 'unknown',
      mensaje: `Borrador creado para ${destinatario}: "${asunto}"`,
    });
  } catch (err: any) {
    return JSON.stringify({ error: `Error creando borrador: ${err.message?.slice(0, 200) ?? 'unknown'}` });
  }
}
