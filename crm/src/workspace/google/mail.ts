/**
 * Google Mail Operations — Gmail API
 */

import {
  getGmailReadClient,
  getGmailClient,
  getGmailComposeClient,
} from "./auth.js";
import type {
  MailSearchResult,
  MailDetail,
  DraftResult,
  SendResult,
} from "../types.js";

/** Wrap plain text in HTML email template with proper paragraph spacing. */
export function wrapEmailHtml(body: string): string {
  const hasHtml = /<(p|div|table|h[1-6]|ul|ol|br)\b/i.test(body);
  let htmlBody: string;
  if (hasHtml) {
    htmlBody = body;
  } else {
    htmlBody = body
      .split(/\n\n+/)
      .map(
        (para) =>
          `<p style="margin: 0 0 16px 0; line-height: 1.6;">${para.replace(/\n/g, "<br>")}</p>`,
      )
      .join("\n");
  }
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#f5f5f5;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 4px rgba(0,0,0,0.1);">
<tr><td style="padding:32px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:15px;color:#333333;">
${htmlBody}
</td></tr></table>
</td></tr></table>
</body></html>`;
}

function buildRawMessage(
  from: string,
  to: string,
  subject: string,
  bodyHtml: string,
): string {
  return Buffer.from(
    `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${bodyHtml}`,
  ).toString("base64url");
}

export async function searchMail(
  email: string,
  query: string,
  limit: number,
): Promise<MailSearchResult[]> {
  const gmail = getGmailReadClient(email);
  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: limit,
  });

  const messages = res.data.messages ?? [];
  const results: MailSearchResult[] = [];

  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: msg.id!,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers = detail.data.payload?.headers ?? [];
    results.push({
      id: msg.id!,
      from: headers.find((h) => h.name === "From")?.value ?? "",
      subject: headers.find((h) => h.name === "Subject")?.value ?? "",
      date: headers.find((h) => h.name === "Date")?.value ?? "",
      snippet: detail.data.snippet ?? "",
    });
  }

  return results;
}

export async function readMail(
  email: string,
  messageId: string,
): Promise<MailDetail> {
  const gmail = getGmailReadClient(email);
  const detail = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = detail.data.payload?.headers ?? [];
  let body = "";
  const payload = detail.data.payload;
  if (payload?.body?.data) {
    body = Buffer.from(payload.body.data, "base64url").toString("utf-8");
  } else if (payload?.parts) {
    const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
    const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
    const part = textPart ?? htmlPart;
    if (part?.body?.data) {
      body = Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
  }

  if (body.length > 50000) {
    body = body.slice(0, 50000) + "\n... (truncado)";
  }

  return {
    from: headers.find((h) => h.name === "From")?.value ?? "",
    to: headers.find((h) => h.name === "To")?.value ?? "",
    subject: headers.find((h) => h.name === "Subject")?.value ?? "",
    date: headers.find((h) => h.name === "Date")?.value ?? "",
    body,
  };
}

export async function createDraft(
  email: string,
  to: string,
  subject: string,
  bodyHtml: string,
): Promise<DraftResult> {
  const raw = buildRawMessage(email, to, subject, bodyHtml);

  // Try creating a draft first (requires gmail.compose scope)
  try {
    const gmail = getGmailComposeClient(email);
    const res = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw } },
    });
    return { draft_id: res.data.id ?? "unknown" };
  } catch {
    // gmail.compose scope not authorized — fall back to direct send
  }

  // Fallback: send directly (gmail.send scope)
  const gmail = getGmailClient(email);
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  return { message_id: res.data.id ?? "unknown", sent_directly: true };
}

export async function sendMail(
  email: string,
  to: string,
  subject: string,
  bodyHtml: string,
): Promise<SendResult> {
  const gmail = getGmailClient(email);
  const raw = buildRawMessage(email, to, subject, bodyHtml);
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  return { message_id: res.data.id ?? null };
}
