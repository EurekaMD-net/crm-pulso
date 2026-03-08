/**
 * Dashboard Auth — JWT token generation and validation
 *
 * Uses Node's built-in crypto module (no external dependencies).
 * Tokens encode persona_id and rol with HMAC-SHA256 signature.
 */

import crypto from 'crypto';
import { getPersonById, getTeamIds, getFullTeamIds } from '../hierarchy.js';
import type { ToolContext } from '../tools/index.js';

const SECRET = process.env.DASHBOARD_JWT_SECRET || 'crm-dashboard-dev-secret';
const TOKEN_EXPIRY_DAYS = 30;

// ---------------------------------------------------------------------------
// JWT helpers (minimal, no library needed)
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlEncode(obj: unknown): string {
  return base64url(Buffer.from(JSON.stringify(obj)));
}

function base64urlDecode(str: string): unknown {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(padded, 'base64').toString());
}

function sign(header: string, payload: string): string {
  return base64url(
    crypto.createHmac('sha256', SECRET).update(`${header}.${payload}`).digest(),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TokenPayload {
  persona_id: string;
  rol: 'ae' | 'gerente' | 'director' | 'vp';
  exp: number; // Unix timestamp
}

/** Create a signed JWT for a persona. */
export function createToken(personaId: string): string | null {
  const persona = getPersonById(personaId);
  if (!persona) return null;

  const header = base64urlEncode({ alg: 'HS256', typ: 'JWT' });
  const payload = base64urlEncode({
    persona_id: persona.id,
    rol: persona.rol,
    exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_DAYS * 86400,
  });
  const signature = sign(header, payload);
  return `${header}.${payload}.${signature}`;
}

/** Verify a JWT and return the payload, or null if invalid/expired. */
export function verifyToken(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;
  const expected = sign(header, payload);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const data = base64urlDecode(payload) as TokenPayload;
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Build a ToolContext from a verified token payload. */
export function buildContextFromToken(payload: TokenPayload): ToolContext {
  return {
    persona_id: payload.persona_id,
    rol: payload.rol,
    team_ids: getTeamIds(payload.persona_id),
    full_team_ids: getFullTeamIds(payload.persona_id),
  };
}
