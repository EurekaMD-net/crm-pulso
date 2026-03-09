/**
 * Dashboard tool — generates a personalized dashboard link for the user.
 *
 * URL shortening strategy:
 * 1. If DASHBOARD_BASE_URL has a domain (not raw IP) → no shortener needed
 * 2. If BITLY_API_TOKEN is set → use Bitly (professional, no spam)
 * 3. Fallback → raw URL (WhatsApp may not auto-link IP-based URLs)
 */

import { createToken, createShortLink } from '../dashboard/auth.js';
import { logger } from '../logger.js';
import type { ToolContext } from './index.js';

const DASHBOARD_BASE_URL = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';

/** Returns true if the base URL is a raw IP (not a domain). */
function isRawIpUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return /^[\d.]+$/.test(host) || host === 'localhost';
  } catch {
    return true;
  }
}

async function shortenWithBitly(longUrl: string): Promise<string | null> {
  const token = process.env.BITLY_API_TOKEN;
  if (!token) return null;

  try {
    const res = await fetch('https://api-ssl.bitly.com/v4/shorten', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ long_url: longUrl }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Bitly shorten failed');
      return null;
    }
    const data = await res.json() as { link?: string };
    return data.link ?? null;
  } catch (err) {
    logger.warn({ err }, 'Bitly shorten error');
    return null;
  }
}

async function shortenUrl(longUrl: string): Promise<string> {
  // If the URL already has a proper domain, no shortening needed
  if (!isRawIpUrl(longUrl)) return longUrl;

  // Try Bitly
  const short = await shortenWithBitly(longUrl);
  if (short) return short;

  return longUrl;
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
