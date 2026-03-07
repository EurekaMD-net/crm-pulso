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

    logger.info({ tables: CRM_TABLES.length }, 'CRM schema initialized');
  } catch (err) {
    logger.error({ err }, 'CRM bootstrap failed');
    throw err;
  }
}
