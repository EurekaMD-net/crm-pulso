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

export function bootstrapCrm(): void {
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
  } catch (err) {
    logger.error({ err }, "CRM bootstrap failed");
    throw err;
  }
}
