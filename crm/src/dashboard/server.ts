/**
 * Dashboard HTTP Server
 *
 * Lightweight REST API server using Node's built-in http module.
 * No framework dependencies. Co-hosted with the engine process.
 *
 * Routes:
 *   GET /api/v1/pipeline    — Pipeline overview (role-scoped)
 *   GET /api/v1/cuota       — Quota tracking (role-scoped)
 *   GET /api/v1/descarga    — Discharge tracking (role-scoped)
 *   GET /api/v1/actividades — Recent activities (role-scoped)
 *   GET /api/v1/equipo      — Org tree (role-scoped)
 *   GET /api/v1/alertas     — Recent alerts (role-scoped)
 *   GET /api/v1/token       — Generate token (internal CLI use)
 *   GET /health             — Health check (no auth)
 */

import http from 'http';
import { URL } from 'url';
import { logger } from '../logger.js';
import { verifyToken, buildContextFromToken, createToken } from './auth.js';
import {
  getPipeline, getCuota, getDescarga,
  getActividades, getEquipo, getAlertas,
} from './api.js';
import type { ToolContext } from '../tools/index.js';

type ApiHandler = (query: Record<string, string>, ctx: ToolContext) => unknown;

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

const API_ROUTES: Record<string, ApiHandler> = {
  '/api/v1/pipeline': getPipeline,
  '/api/v1/cuota': getCuota,
  '/api/v1/descarga': getDescarga,
  '/api/v1/actividades': getActividades,
  '/api/v1/equipo': getEquipo,
  '/api/v1/alertas': getAlertas,
};

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function parseQuery(url: URL): Record<string, string> {
  const q: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { q[k] = v; });
  return q;
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Health check (no auth)
  if (pathname === '/health') {
    sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
    return;
  }

  // Token generation endpoint (requires persona_id query param, no auth)
  // Intended for CLI use: curl http://localhost:3000/api/v1/token?persona_id=xxx
  if (pathname === '/api/v1/token') {
    const personaId = url.searchParams.get('persona_id');
    if (!personaId) {
      sendJson(res, 400, { error: 'Missing persona_id query parameter' });
      return;
    }
    const token = createToken(personaId);
    if (!token) {
      sendJson(res, 404, { error: 'Persona not found' });
      return;
    }
    sendJson(res, 200, { token });
    return;
  }

  // All API routes require auth
  const handler = API_ROUTES[pathname];
  if (!handler) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  // Extract Bearer token
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    sendJson(res, 401, { error: 'Missing or invalid Authorization header' });
    return;
  }

  const tokenStr = authHeader.slice(7);
  const payload = verifyToken(tokenStr);
  if (!payload) {
    sendJson(res, 401, { error: 'Invalid or expired token' });
    return;
  }

  const ctx = buildContextFromToken(payload);
  const query = parseQuery(url);

  try {
    const result = handler(query, ctx);
    sendJson(res, 200, result);
  } catch (err) {
    logger.error({ err, pathname }, 'Dashboard API error');
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: http.Server | null = null;

export function startDashboardServer(port?: number): http.Server {
  const p = port || Number(process.env.DASHBOARD_PORT) || 3000;
  server = http.createServer(handleRequest);
  server.listen(p, () => {
    logger.info({ port: p }, 'Dashboard server started');
  });
  return server;
}

export function stopDashboardServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
}
