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
 * Fail fast on missing required env vars before we touch the schema. The
 * previous behavior was to silently boot, then fail 30s into the first
 * inference call (no INFERENCE_PRIMARY_URL), or to silently mint a JWT with
 * a random secret on every restart in production (no DASHBOARD_JWT_SECRET).
 */
function validateEnv(): void {
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
