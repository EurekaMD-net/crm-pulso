/**
 * CRM Bootstrap
 *
 * Called from engine/src/index.ts after initDatabase().
 * Creates CRM schema tables in the shared SQLite database.
 */

import { getDatabase } from './db.js';
import { logger } from './logger.js';
import { createCrmSchema, CRM_TABLES } from './schema.js';

export function bootstrapCrm(): void {
  const db = getDatabase();
  try {
    // Pragmas — journal_mode is set in db.ts (DELETE, not WAL, for Docker compat)

    createCrmSchema(db);

    // Verify all expected tables exist
    const existing = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const existingNames = new Set(existing.map(r => r.name));
    const missing = CRM_TABLES.filter(t => !existingNames.has(t));

    if (missing.length > 0) {
      logger.warn({ missing }, 'CRM tables missing after bootstrap');
    }

    logger.info({ tables: CRM_TABLES.length - missing.length, expected: CRM_TABLES.length }, 'CRM schema initialized');
  } catch (err) {
    logger.error({ err }, 'CRM bootstrap failed');
    throw err;
  }
}
