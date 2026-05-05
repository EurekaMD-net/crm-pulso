/**
 * CRM Bootstrap
 *
 * Called from engine/src/index.ts after initDatabase().
 * Creates CRM schema tables in the shared SQLite database.
 */

import { getDatabase } from "./db.js";
import { logger } from "./logger.js";
import { createCrmSchema, CRM_TABLES } from "./schema.js";
import { initShortLinks } from "./dashboard/auth.js";
import { initMemoryService } from "./memory/index.js";
import { startEvictionCleanup } from "./tool-eviction.js";

/**
 * Hostnames the CRM is known to use as inference providers. Update when
 * onboarding a new provider — a missing entry is supposed to fail loudly
 * at bootstrap rather than silently route traffic somewhere unexpected.
 */
const INFERENCE_HOST_ALLOWLIST = new Set<string>([
  "dashscope.aliyuncs.com",
  "dashscope-intl.aliyuncs.com",
  "coding-intl.dashscope.aliyuncs.com",
  "api.minimax.chat",
  "api.fireworks.ai",
]);

/** Private + link-local IPv4 ranges that an SSRF payload would target. */
function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

/**
 * Private + link-local IPv6 ranges. Note WHATWG URL returns IPv6 hostnames
 * wrapped in brackets (`[::1]`, `[::ffff:7f00:1]`), and `::ffff:127.0.0.1`
 * normalizes to `::ffff:7f00:1`. Match on the bracketed lowercased form.
 */
function isPrivateIPv6(host: string): boolean {
  if (!host.startsWith("[") || !host.endsWith("]")) return false;
  const inner = host.slice(1, -1).toLowerCase();
  if (inner === "::1" || inner === "::") return true; // loopback / unspecified
  if (inner.startsWith("fe80:") || inner.startsWith("fe80::")) return true; // link-local
  if (inner.startsWith("fc") || inner.startsWith("fd")) return true; // unique-local fc00::/7
  // IPv4-mapped IPv6 (::ffff:a.b.c.d, normalized to ::ffff:hex:hex). Reject
  // any ::ffff:* form — it's an IPv4 address being smuggled through IPv6.
  if (inner.startsWith("::ffff:")) return true;
  return false;
}

function validateInferenceUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `CRM bootstrap aborted — INFERENCE_PRIMARY_URL is not a valid URL: ${raw}`,
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `CRM bootstrap aborted — INFERENCE_PRIMARY_URL must use https:// in production (got ${url.protocol}).`,
    );
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || isPrivateIPv4(host) || isPrivateIPv6(host)) {
    throw new Error(
      `CRM bootstrap aborted — INFERENCE_PRIMARY_URL points at private/loopback host: ${host}.`,
    );
  }
  if (!INFERENCE_HOST_ALLOWLIST.has(host)) {
    throw new Error(
      `CRM bootstrap aborted — INFERENCE_PRIMARY_URL host "${host}" not in allowlist. Add it to INFERENCE_HOST_ALLOWLIST in crm/src/bootstrap.ts after verifying the provider.`,
    );
  }
}

/**
 * Fail fast on missing required env vars before we touch the schema. The
 * previous behavior was to silently boot, then fail 30s into the first
 * inference call (no INFERENCE_PRIMARY_URL), or to silently mint a JWT with
 * a random secret on every restart in production (no DASHBOARD_JWT_SECRET).
 */
export function validateEnv(): void {
  const required = ["INFERENCE_PRIMARY_URL", "INFERENCE_PRIMARY_MODEL"];
  if (process.env.NODE_ENV === "production") {
    required.push("DASHBOARD_JWT_SECRET");
  }
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `CRM bootstrap aborted — required env vars missing: ${missing.join(", ")}`,
    );
  }

  // A5 — JWT secret length floor. The original incident (commit 4eee0e3)
  // was a random fallback being silently minted on each restart. Catching
  // missing-var doesn't catch `DASHBOARD_JWT_SECRET=changeme` — enforce
  // the .env.example recommendation of `openssl rand -hex 32` (64 chars).
  // Accept >= 32 since a 32-char alphanumeric secret carries adequate
  // entropy for HS256.
  if (process.env.NODE_ENV === "production") {
    const secret = process.env.DASHBOARD_JWT_SECRET ?? "";
    if (secret.length < 32) {
      throw new Error(
        `CRM bootstrap aborted — DASHBOARD_JWT_SECRET must be ≥ 32 chars in production (got ${secret.length}). Use \`openssl rand -hex 32\`.`,
      );
    }
  }

  // B4 — SSRF hardening for INFERENCE_PRIMARY_URL. If env-var write is
  // compromised, an attacker can repoint inference at cloud metadata
  // (169.254.169.254), local Postgres (localhost:5433), or the Supabase
  // Kong (localhost:8100) and read sensitive responses through the
  // inference stream. Defense-in-depth — require https, allowlist
  // hostnames we actually use, reject private IPs.
  //
  // Skip in non-production AND under vitest (tests stub localhost URLs).
  if (process.env.NODE_ENV === "production" && !process.env.VITEST) {
    validateInferenceUrl(process.env.INFERENCE_PRIMARY_URL!);
  }
}

export function bootstrapCrm(): void {
  validateEnv();
  const db = getDatabase();
  try {
    // Pragmas — journal_mode is set in db.ts (DELETE, not WAL, for Docker compat)

    createCrmSchema(db);
    initShortLinks(getDatabase);

    logger.info({ tables: CRM_TABLES.length }, "CRM schema initialized");

    // Fire-and-forget: memory service init is async (Hindsight health check).
    // getMemoryService() returns SQLite fallback until this resolves.
    initMemoryService().catch((err) => {
      logger.warn(
        { err },
        "Memory service init failed — using SQLite fallback",
      );
    });

    // Background cleanup of oversized-tool-result temp files. Previously
    // this ran probabilistically inside the hot path on every eviction,
    // which added unpredictable latency. Now it runs every 10 minutes off
    // the event loop.
    startEvictionCleanup();
  } catch (err) {
    logger.error({ err }, "CRM bootstrap failed");
    throw err;
  }
}
