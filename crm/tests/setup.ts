import os from "os";
import path from "path";
import fs from "fs";

/**
 * Global vitest setup — point CRM_DB_PATH at a per-run temp file so tests
 * can never accidentally write to the production crm.db. Files are cleaned
 * up on process exit. Tests that mock db.js (vi.mock("../src/db.js")) are
 * unaffected.
 */
const tmpDb = path.join(
  os.tmpdir(),
  `crm-test-${process.pid}-${Date.now()}.db`,
);
process.env.CRM_DB_PATH = tmpDb;

process.on("exit", () => {
  for (const suffix of ["", "-journal", "-shm", "-wal"]) {
    const f = tmpDb + suffix;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
});
