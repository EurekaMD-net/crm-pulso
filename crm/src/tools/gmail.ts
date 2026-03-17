/**
 * Gmail Tools
 *
 * buscar_emails — search inbox
 * leer_email — read full email content
 * crear_borrador_email — create a draft email
 *
 * All tools gracefully degrade when workspace is not configured.
 */

import { isWorkspaceEnabled, getProvider } from "../workspace/provider.js";
import { wrapEmailHtml } from "../workspace/google/mail.js";
import { getPersonaEmail } from "./helpers.js";
import type { ToolContext } from "./index.js";

// Re-export for email.ts which also needs wrapEmailHtml
export { wrapEmailHtml };

// ---------------------------------------------------------------------------
// buscar_emails
// ---------------------------------------------------------------------------

export async function buscar_emails(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  if (!isWorkspaceEnabled()) {
    return JSON.stringify({ error: "Correo no configurado" });
  }

  const email = getPersonaEmail(ctx.persona_id);
  if (!email) {
    return JSON.stringify({ error: "Persona no tiene email configurado" });
  }

  const query = args.query as string | undefined;
  const limite = (args.limite as number) || 10;

  try {
    const results = await getProvider().searchMail(email, query ?? "", limite);
    return JSON.stringify({ emails: results });
  } catch (err: any) {
    return JSON.stringify({
      error: `Error buscando emails: ${err.message?.slice(0, 200) ?? "unknown"}`,
    });
  }
}

// ---------------------------------------------------------------------------
// leer_email
// ---------------------------------------------------------------------------

export async function leer_email(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  if (!isWorkspaceEnabled()) {
    return JSON.stringify({ error: "Correo no configurado" });
  }

  const email = getPersonaEmail(ctx.persona_id);
  if (!email) {
    return JSON.stringify({ error: "Persona no tiene email configurado" });
  }

  const emailId = args.email_id as string;
  if (!emailId) {
    return JSON.stringify({ error: "email_id es requerido" });
  }

  try {
    const detail = await getProvider().readMail(email, emailId);
    return JSON.stringify(detail);
  } catch (err: any) {
    return JSON.stringify({
      error: `Error leyendo email: ${err.message?.slice(0, 200) ?? "unknown"}`,
    });
  }
}

// ---------------------------------------------------------------------------
// crear_borrador_email
// ---------------------------------------------------------------------------

export async function crear_borrador_email(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  if (!isWorkspaceEnabled()) {
    return JSON.stringify({ error: "Correo no configurado" });
  }

  const email = getPersonaEmail(ctx.persona_id);
  if (!email) {
    return JSON.stringify({ error: "Persona no tiene email configurado" });
  }

  const destinatario = args.destinatario as string;
  const asunto = args.asunto as string;
  const cuerpo = args.cuerpo as string;

  if (!destinatario || !asunto || !cuerpo) {
    return JSON.stringify({
      error: "destinatario, asunto y cuerpo son requeridos",
    });
  }

  const htmlBody = wrapEmailHtml(cuerpo);

  try {
    const result = await getProvider().createDraft(
      email,
      destinatario,
      asunto,
      htmlBody,
    );

    if (result.sent_directly) {
      return JSON.stringify({
        message_id: result.message_id ?? "unknown",
        mensaje: `Email enviado directamente a ${destinatario}: "${asunto}" (no se pudo crear borrador, se envio directo)`,
      });
    }

    return JSON.stringify({
      draft_id: result.draft_id ?? "unknown",
      mensaje: `Borrador creado para ${destinatario}: "${asunto}"`,
    });
  } catch (err: any) {
    return JSON.stringify({
      error: `Error enviando email: ${err.message?.slice(0, 200) ?? "unknown"}`,
    });
  }
}
