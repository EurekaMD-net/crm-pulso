/**
 * Dashboard tool — generates a personalized dashboard link for the user.
 *
 * Uses TinyURL to shorten the link so WhatsApp renders it as clickable
 * (raw IP + port URLs are not auto-linked by WhatsApp).
 */

import { createToken, createShortLink } from '../dashboard/auth.js';
import type { ToolContext } from './index.js';

const DASHBOARD_BASE_URL = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';

async function shortenUrl(longUrl: string): Promise<string> {
  try {
    const res = await fetch(
      `https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return longUrl;
    const short = (await res.text()).trim();
    return short.startsWith('http') ? short : longUrl;
  } catch {
    return longUrl; // Fallback to raw URL if shortener is unavailable
  }
}

export async function generar_link_dashboard(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const token = createToken(ctx.persona_id);
  if (!token) {
    return JSON.stringify({ error: 'No se pudo generar el token de acceso.' });
  }

  const code = createShortLink(token, ctx.persona_id);
  const rawUrl = code
    ? `${DASHBOARD_BASE_URL}/go/${code}`
    : `${DASHBOARD_BASE_URL}/go/${token}`;

  const url = await shortenUrl(rawUrl);

  return JSON.stringify({
    url,
    mensaje: `Tu dashboard esta listo. El enlace es valido por 30 dias.`,
  });
}
