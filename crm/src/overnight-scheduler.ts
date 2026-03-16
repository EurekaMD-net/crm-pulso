/**
 * Overnight Analysis Scheduler
 *
 * Writes IPC task at 2 AM Mexico City to trigger the overnight
 * commercial analysis engine. Follows warmth-scheduler.ts pattern.
 */

import fs from "fs";
import path from "path";

export function startOvernightScheduler(dataDir: string): void {
  const ipcDir = path.join(dataDir, "ipc", "main", "tasks");

  // Check every hour, write task only at 2 AM MX
  setInterval(
    () => {
      const hour = parseInt(
        new Date().toLocaleString("en-US", {
          timeZone: "America/Mexico_City",
          hour: "numeric",
          hour12: false,
        }),
      );
      if (hour !== 2) return;

      try {
        fs.mkdirSync(ipcDir, { recursive: true });
        const taskFile = path.join(
          ipcDir,
          `overnight-analysis-${Date.now()}.json`,
        );
        fs.writeFileSync(
          taskFile,
          JSON.stringify({ type: "crm_overnight_analysis" }),
        );
      } catch {
        // Non-critical
      }
    },
    60 * 60 * 1000,
  );
}
