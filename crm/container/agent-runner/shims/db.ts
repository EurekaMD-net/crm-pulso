/**
 * Engine db.ts shim for CRM container.
 * Provides getDatabase() matching the engine signature,
 * backed by better-sqlite3 pointed at CRM_DB_PATH.
 */

// @ts-ignore - better-sqlite3 is in agent-runner/node_modules; not on TS resolution
// path when this file is processed as engine/src/db.ts (container copy target)
import Database from 'better-sqlite3';

const CRM_DB_PATH = process.env.CRM_DB_PATH || '/workspace/extra/crm-db/crm.db';

let _db: InstanceType<typeof Database> | null = null;

export function getDatabase(): InstanceType<typeof Database> {
  if (!_db) {
    _db = new Database(CRM_DB_PATH);
    // DELETE journal mode — no WAL/SHM files needed.
    // Required because the host engine process also opens this file;
    // WAL shared memory cannot cross Docker bind-mount boundaries on Windows.
    _db.pragma('journal_mode = DELETE');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}
