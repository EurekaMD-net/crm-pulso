/**
 * CRM Database — dedicated SQLite at data/store/crm.db.
 *
 * Separate from the engine's store/messages.db to avoid SQLITE_IOERR_SHMOPEN.
 * Uses DELETE journal mode (not WAL) so Docker containers can open the same
 * file via bind mount on Windows without needing a shared SHM file.
 *
 * On the host side, this module opens data/store/crm.db.
 * In containers, CRM_DB_PATH env var overrides the path (set by container-runner.ts).
 */

// @ts-ignore - better-sqlite3 resolved from root node_modules
import Database from "better-sqlite3";
// @ts-ignore - sqlite-vec resolved from root node_modules
import * as sqliteVec from "sqlite-vec";
import fs from "fs";
import path from "path";

const CRM_DB_PATH =
  process.env.CRM_DB_PATH ??
  path.join(process.cwd(), "data", "store", "crm.db");

let _db: InstanceType<typeof Database> | null = null;

export function getDatabase(): InstanceType<typeof Database> {
  if (!_db) {
    fs.mkdirSync(path.dirname(CRM_DB_PATH), { recursive: true });
    _db = new Database(CRM_DB_PATH);
    // DELETE journal mode: no WAL/SHM files — required for Docker bind mounts on Windows.
    // The container opens the same file; WAL shared memory can't cross the bind mount boundary.
    _db.pragma("journal_mode = DELETE");
    _db.pragma("synchronous = NORMAL");
    _db.pragma("cache_size = -64000");
    _db.pragma("temp_store = MEMORY");
    _db.pragma("mmap_size = 268435456");
    _db.pragma("foreign_keys = ON");
    // Wait up to 5s on SQLITE_BUSY before failing (concurrent container writes)
    _db.pragma("busy_timeout = 5000");
    sqliteVec.load(_db);
  }
  return _db;
}
