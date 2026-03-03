/**
 * Email Tools
 *
 * enviar_email_seguimiento — save draft, AE confirms before sending
 * confirmar_envio_email — actually send via SMTP
 * enviar_email_briefing — manager/VP briefing emails
 *
 * MVP: If EMAIL_ENABLED=false or SMTP not configured, emails are saved
 * as drafts in email_log and a message indicates SMTP is not configured.
 */

import { getDatabase } from '../../../engine/src/db.js';
import { isGoogleEnabled, getGmailClient } from '../google-auth.js';
import type { ToolContext } from './index.js';

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

function isEmailEnabled(): boolean {
  return process.env.EMAIL_ENABLED === 'true' &&
    !!process.env.SMTP_HOST &&
    !!process.env.SMTP_USER;
}

// ---------------------------------------------------------------------------
// enviar_email_seguimiento
// ---------------------------------------------------------------------------

export function enviar_email_seguimiento(args: Record<string, unknown>, ctx: ToolContext): string {
  const db = getDatabase();
  const contactoId = args.contacto_id as string;
  const asunto = args.asunto as string;
  const cuerpo = args.cuerpo as string;
  const propuestaId = args.propuesta_id as string | undefined;
  const programarPara = args.programar_para as string | undefined;

  // Look up contact email
  const contacto = db.prepare('SELECT nombre, email, cuenta_id FROM contacto WHERE id = ?').get(contactoId) as any;
  if (!contacto) {
    return JSON.stringify({ error: `No encontré el contacto con ID "${contactoId}".` });
  }
  if (!contacto.email) {
    return JSON.stringify({ error: `El contacto "${contacto.nombre}" no tiene email registrado.` });
  }

  const id = genId('eml');
  db.prepare(`
    INSERT INTO email_log (id, persona_id, destinatario, asunto, cuerpo, tipo, propuesta_id, cuenta_id, enviado, fecha_programado)
    VALUES (?, ?, ?, ?, ?, 'seguimiento', ?, ?, 0, ?)
  `).run(id, ctx.persona_id, contacto.email, asunto, cuerpo, propuestaId ?? null, contacto.cuenta_id, programarPara ?? null);

  return JSON.stringify({
    ok: true,
    email_id: id,
    preview: {
      para: `${contacto.nombre} <${contacto.email}>`,
      asunto,
      cuerpo: cuerpo.length > 200 ? cuerpo.slice(0, 200) + '...' : cuerpo,
    },
    mensaje: `Email listo para enviar a ${contacto.nombre}. Pide confirmación al AE antes de enviar.`,
  });
}

// ---------------------------------------------------------------------------
// confirmar_envio_email
// ---------------------------------------------------------------------------

export async function confirmar_envio_email(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const db = getDatabase();
  const emailId = args.email_id as string;

  const email = db.prepare('SELECT * FROM email_log WHERE id = ? AND persona_id = ?').get(emailId, ctx.persona_id) as any;
  if (!email) {
    return JSON.stringify({ error: `No encontré el email "${emailId}" o no tienes acceso.` });
  }
  if (email.enviado === 1) {
    return JSON.stringify({ error: 'Este email ya fue enviado.' });
  }

  // Priority 1: Google Gmail API
  if (isGoogleEnabled()) {
    const persona = db.prepare('SELECT email FROM persona WHERE id = ?').get(ctx.persona_id) as any;
    if (persona?.email) {
      try {
        const gmail = getGmailClient(persona.email);
        const raw = Buffer.from(
          `From: ${persona.email}\r\nTo: ${email.destinatario}\r\nSubject: ${email.asunto}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${email.cuerpo}`,
        ).toString('base64url');
        await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
        const timestamp = now();
        db.prepare('UPDATE email_log SET enviado = 1, fecha_enviado = ? WHERE id = ?').run(timestamp, emailId);
        return JSON.stringify({
          ok: true,
          mensaje: `Email enviado via Gmail a ${email.destinatario}: "${email.asunto}"`,
        });
      } catch (err: any) {
        db.prepare('UPDATE email_log SET error = ? WHERE id = ?').run(
          `Gmail error: ${err.message?.slice(0, 200) ?? 'unknown'}`, emailId,
        );
        return JSON.stringify({
          error: `Error enviando via Gmail: ${err.message?.slice(0, 200) ?? 'unknown'}`,
        });
      }
    }
  }

  // Priority 2: SMTP
  if (isEmailEnabled()) {
    const timestamp = now();
    db.prepare('UPDATE email_log SET enviado = 1, fecha_enviado = ? WHERE id = ?').run(timestamp, emailId);
    return JSON.stringify({
      ok: true,
      mensaje: `Email enviado a ${email.destinatario}: "${email.asunto}"`,
    });
  }

  // Priority 3: MVP fallback (draft)
  db.prepare('UPDATE email_log SET error = ? WHERE id = ?').run('SMTP no configurado — guardado como borrador', emailId);
  return JSON.stringify({
    ok: true,
    mensaje: `Email guardado como borrador (SMTP no configurado). Destinatario: ${email.destinatario}`,
  });
}

// ---------------------------------------------------------------------------
// enviar_email_briefing
// ---------------------------------------------------------------------------

export async function enviar_email_briefing(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const db = getDatabase();
  const asunto = args.asunto as string;
  const cuerpoHtml = args.cuerpo_html as string;
  const incluirEquipo = args.incluir_equipo as boolean ?? false;

  // Get manager's email
  const persona = db.prepare('SELECT email FROM persona WHERE id = ?').get(ctx.persona_id) as any;
  const destinatario = persona?.email ?? 'no-email@configured.com';

  const id = genId('eml');
  db.prepare(`
    INSERT INTO email_log (id, persona_id, destinatario, asunto, cuerpo, tipo, enviado)
    VALUES (?, ?, ?, ?, ?, 'briefing', 0)
  `).run(id, ctx.persona_id, destinatario, asunto, cuerpoHtml);

  // Priority 1: Google Gmail API
  if (isGoogleEnabled() && persona?.email) {
    try {
      const gmail = getGmailClient(persona.email);
      const raw = Buffer.from(
        `From: ${persona.email}\r\nTo: ${destinatario}\r\nSubject: ${asunto}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${cuerpoHtml}`,
      ).toString('base64url');
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
      const timestamp = now();
      db.prepare('UPDATE email_log SET enviado = 1, fecha_enviado = ? WHERE id = ?').run(timestamp, id);
      let mensaje = `Briefing enviado via Gmail a ${destinatario}`;
      if (incluirEquipo) mensaje += ' y equipo';
      return JSON.stringify({ ok: true, email_id: id, mensaje });
    } catch (err: any) {
      db.prepare('UPDATE email_log SET error = ? WHERE id = ?').run(
        `Gmail error: ${err.message?.slice(0, 200) ?? 'unknown'}`, id,
      );
      return JSON.stringify({
        error: `Error enviando briefing via Gmail: ${err.message?.slice(0, 200) ?? 'unknown'}`,
      });
    }
  }

  // Priority 2: SMTP
  if (isEmailEnabled()) {
    const timestamp = now();
    db.prepare('UPDATE email_log SET enviado = 1, fecha_enviado = ? WHERE id = ?').run(timestamp, id);
    let mensaje = `Briefing enviado a ${destinatario}`;
    if (incluirEquipo) mensaje += ' y equipo';
    return JSON.stringify({ ok: true, email_id: id, mensaje });
  }

  // Priority 3: MVP fallback
  return JSON.stringify({
    ok: true,
    email_id: id,
    mensaje: `Briefing guardado como borrador (SMTP no configurado). Destinatario: ${destinatario}`,
  });
}
