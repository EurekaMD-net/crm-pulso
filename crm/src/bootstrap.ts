/**
 * CRM Bootstrap
 *
 * Called from engine/src/index.ts after initDatabase().
 * Creates CRM schema tables in the shared SQLite database.
 */

import { getDatabase } from '../../engine/src/db.js';
import { logger } from './logger.js';
import { createCrmSchema, CRM_TABLES } from './schema.js';

export function bootstrapCrm(): void {
  const db = getDatabase();
  try {
    // Performance pragmas — safe for single-writer, multi-reader pattern
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');
    db.pragma('temp_store = MEMORY');
    db.pragma('mmap_size = 268435456');

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
