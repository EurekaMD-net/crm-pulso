/**
 * Engine db.ts shim for CRM container.
 * Provides getDatabase() matching the engine signature,
 * backed by better-sqlite3 pointed at CRM_DB_PATH.
 */

import Database from 'better-sqlite3';

const CRM_DB_PATH = process.env.CRM_DB_PATH || '/workspace/extra/crm-db/messages.db';

let _db: InstanceType<typeof Database> | null = null;

export function getDatabase(): InstanceType<typeof Database> {
  if (!_db) {
    _db = new Database(CRM_DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}
