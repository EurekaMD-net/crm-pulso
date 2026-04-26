/**
 * Dashboard HTTP Server
 *
 * Lightweight REST API server using Node's built-in http module.
 * No framework dependencies. Co-hosted with the engine process.
 *
 * Routes:
 *   GET /api/v1/pipeline           — Pipeline overview (role-scoped)
 *   GET /api/v1/cuota              — Quota tracking (role-scoped)
 *   GET /api/v1/descarga           — Discharge tracking (role-scoped)
 *   GET /api/v1/actividades        — Recent activities (role-scoped)
 *   GET /api/v1/equipo             — Org tree (role-scoped)
 *   GET /api/v1/alertas            — Recent alerts (role-scoped)
 *   GET /api/v1/vp-glance          — VP glance aggregated view (VP only)
 *   GET /api/v1/budget             — Inference cost windows (hourly/daily/monthly)
 *   GET /api/v1/token              — Generate token (localhost-only, CLI use)
 *   GET /api/v1/containers/active  — Active container snapshot (localhost-only, Phase 2c)
 *   GET /health                    — Health check (no auth)
 */

import http from "http";
import fs from "fs";
import path from "path";
import { URL, fileURLToPath } from "url";
import { logger } from "../logger.js";
import {
  verifyToken,
  buildContextFromToken,
  createToken,
  resolveShortLink,
} from "./auth.js";
import {
  getPipeline,
  getCuota,
  getDescarga,
  getActividades,
  getEquipo,
  getAlertas,
  getVpGlance,
  getBudget,
} from "./api.js";
import type { ToolContext } from "../tools/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(__dirname, "../../dashboard");

type ApiHandler = (query: Record<string, string>, ctx: ToolContext) => unknown;

/**
 * Phase 2c — shape of the engine's active-container snapshot, declared
 * inline rather than imported from `engine/src/group-queue.js` so the
 * dashboard module doesn't pull engine internals. The engine guarantees
 * this shape via its own typed export; if the two ever drift, the
 * /api/v1/containers/active endpoint will surface garbage rather than
 * throw — acceptable for an operator-only inspection endpoint.
 */
export interface ActiveContainerInfo {
  groupJid: string;
  containerName: string | null;
  groupFolder: string | null;
  startedAt: number;
  ageMs: number;
  idleWaiting: boolean;
  isTaskContainer: boolean;
}

export interface DashboardOptions {
  /** Engine getter for currently-running containers. Phase 2c. */
  getActiveContainers?: () => ActiveContainerInfo[];
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

const API_ROUTES: Record<string, ApiHandler> = {
  "/api/v1/pipeline": getPipeline,
  "/api/v1/cuota": getCuota,
  "/api/v1/descarga": getDescarga,
  "/api/v1/actividades": getActividades,
  "/api/v1/equipo": getEquipo,
  "/api/v1/alertas": getAlertas,
  "/api/v1/vp-glance": getVpGlance,
  "/api/v1/budget": getBudget,
};

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function parseQuery(url: URL): Record<string, string> {
  const q: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    q[k] = v;
  });
  return q;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: DashboardOptions,
): void {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`,
  );
  const pathname = url.pathname;

  // Health check (no auth)
  if (pathname === "/health") {
    sendJson(res, 200, { status: "ok", timestamp: new Date().toISOString() });
    return;
  }

  // Token generation endpoint (requires persona_id query param, localhost only)
  // Intended for CLI use: curl http://localhost:3000/api/v1/token?persona_id=xxx
  if (pathname === "/api/v1/token") {
    // Restrict to localhost connections for security
    const remoteAddr = req.socket.remoteAddress || "";
    const isLocal =
      remoteAddr === "127.0.0.1" ||
      remoteAddr === "::1" ||
      remoteAddr === "::ffff:127.0.0.1";
    if (!isLocal) {
      sendJson(res, 403, {
        error: "Token endpoint is only accessible from localhost",
      });
      return;
    }
    const personaId = url.searchParams.get("persona_id");
    if (!personaId) {
      sendJson(res, 400, { error: "Missing persona_id query parameter" });
      return;
    }
    const token = createToken(personaId);
    if (!token) {
      sendJson(res, 404, { error: "Persona not found" });
      return;
    }
    sendJson(res, 200, { token });
    return;
  }

  // Active-container snapshot — Phase 2c operator inspection.
  // Localhost-only (matches /api/v1/token pattern) so a public Caddy
  // proxy can't expose the container list. Container names + group
  // folders are operationally sensitive even though not strictly secret.
  if (pathname === "/api/v1/containers/active") {
    const remoteAddr = req.socket.remoteAddress || "";
    const isLocal =
      remoteAddr === "127.0.0.1" ||
      remoteAddr === "::1" ||
      remoteAddr === "::ffff:127.0.0.1";
    if (!isLocal) {
      sendJson(res, 403, {
        error: "Containers endpoint is only accessible from localhost",
      });
      return;
    }
    if (!opts.getActiveContainers) {
      sendJson(res, 503, {
        error: "Containers endpoint not configured",
      });
      return;
    }
    sendJson(res, 200, { containers: opts.getActiveContainers() });
    return;
  }

  // Short redirect: /go/{code} → /dashboard/{role}.html?token={jwt}
  // Short codes keep WhatsApp links clickable (long URLs break auto-linking).
  if (pathname.startsWith("/go/")) {
    const code = pathname.slice(4);
    const token = resolveShortLink(code);
    if (!token) {
      sendJson(res, 404, { error: "Link not found or expired" });
      return;
    }
    const payload = verifyToken(token);
    if (!payload) {
      sendJson(res, 401, { error: "Token expired" });
      return;
    }
    const rolePages: Record<string, string> = {
      vp: "vp.html",
      director: "director.html",
      gerente: "manager.html",
      ae: "ae.html",
    };
    const page = rolePages[payload.rol] || "index.html";
    res.writeHead(302, {
      Location: `/dashboard/${page}?token=${encodeURIComponent(token)}`,
    });
    res.end();
    return;
  }

  // Static file serving for /dashboard/*
  if (pathname.startsWith("/dashboard/")) {
    serveStatic(pathname.slice("/dashboard/".length), res);
    return;
  }

  // All API routes require auth
  const handler = API_ROUTES[pathname];
  if (!handler) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  // Extract Bearer token
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    sendJson(res, 401, { error: "Missing or invalid Authorization header" });
    return;
  }

  const tokenStr = authHeader.slice(7);
  const payload = verifyToken(tokenStr);
  if (!payload) {
    sendJson(res, 401, { error: "Invalid or expired token" });
    return;
  }

  const ctx = buildContextFromToken(payload);
  const query = parseQuery(url);

  try {
    const result = handler(query, ctx);
    sendJson(res, 200, result);
  } catch (err) {
    logger.error({ err, pathname }, "Dashboard API error");
    sendJson(res, 500, { error: "Internal server error" });
  }
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(filePath: string, res: http.ServerResponse): void {
  // Prevent directory traversal
  const safe = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const fullPath = path.join(STATIC_DIR, safe);

  // Must stay within STATIC_DIR
  if (!fullPath.startsWith(STATIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const content = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=300",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: http.Server | null = null;

export function startDashboardServer(
  port?: number,
  opts: DashboardOptions = {},
): http.Server {
  const p = port || Number(process.env.DASHBOARD_PORT) || 3000;
  server = http.createServer((req, res) => handleRequest(req, res, opts));
  server.listen(p, () => {
    logger.info({ port: p }, "Dashboard server started");
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
