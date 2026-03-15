/**
 * Nightly Warmth Recomputation Scheduler
 *
 * Runs at 4 AM Mexico City via IPC task. Iterates all relacion_ejecutiva
 * rows, fetches interactions, computes warmth, and updates scores.
 */

import fs from "fs";
import path from "path";
import { getDatabase } from "./db.js";
import { computeWarmth } from "./warmth.js";
import type { InteractionRow } from "./warmth.js";
import { logger } from "./logger.js";

/**
 * Recompute warmth scores for all tracked relationships.
 * Called by IPC handler for `crm_warmth_recompute` task type.
 */
export function recomputeAllWarmth(): number {
  const db = getDatabase();
  const relationships = db
    .prepare("SELECT id FROM relacion_ejecutiva")
    .all() as { id: string }[];

  if (relationships.length === 0) return 0;

  const getInteractions = db.prepare(
    "SELECT tipo, calidad, fecha FROM interaccion_ejecutiva WHERE relacion_id = ? ORDER BY fecha DESC",
  );
  const updateWarmth = db.prepare(
    "UPDATE relacion_ejecutiva SET warmth_score = ?, warmth_updated = datetime('now') WHERE id = ?",
  );

  let updated = 0;
  const updateAll = db.transaction(() => {
    for (const rel of relationships) {
      const interactions = getInteractions.all(rel.id) as InteractionRow[];
      const score = computeWarmth(interactions);
      updateWarmth.run(score, rel.id);
      updated++;
    }
  });

  updateAll();
  logger.info({ updated }, "Warmth scores recomputed");
  return updated;
}

/**
 * Start the nightly warmth scheduler.
 * Writes IPC task at 4 AM Mexico City (same pattern as doc-sync).
 */
export function startWarmthScheduler(dataDir: string): void {
  const ipcDir = path.join(dataDir, "ipc", "main", "tasks");

  // Check every hour, write task only at 4 AM MX
  setInterval(
    () => {
      const hour = parseInt(
        new Date().toLocaleString("en-US", {
          timeZone: "America/Mexico_City",
          hour: "numeric",
          hour12: false,
        }),
      );
      if (hour !== 4) return;

      try {
        fs.mkdirSync(ipcDir, { recursive: true });
        const taskFile = path.join(
          ipcDir,
          `warmth-recompute-${Date.now()}.json`,
        );
        fs.writeFileSync(
          taskFile,
          JSON.stringify({ type: "crm_warmth_recompute" }),
        );
      } catch {
        // Non-critical
      }
    },
    60 * 60 * 1000,
  );
}
