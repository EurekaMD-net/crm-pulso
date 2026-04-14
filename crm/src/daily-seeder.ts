/**
 * Daily Seeder — subprocess wrapper around scripts/seed-daily.ts.
 *
 * The script is idempotent (INSERT OR IGNORE with date-based IDs) so
 * re-running it continuously is safe: duplicate dates skip, new days get
 * filled. This wrapper is called from `ipc-handlers.ts` when the
 * scheduler fires `crm_daily_seed`, which happens:
 *   - Once at service startup (`startupBehavior: "immediate"`)
 *   - Daily at 5 AM Mexico City (after warmth at 4 AM)
 *
 * Runs the script as a detached subprocess so the scheduler event loop
 * doesn't block on the 5–15 second seed run.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { logger as parentLogger } from "./logger.js";

const logger = parentLogger.child({ component: "daily-seeder" });

// Resolved at module load. The systemd unit's WorkingDirectory is the
// repo root, so this path is `/root/claude/crm-azteca/scripts/seed-daily.ts`
// when run as a service.
const SEED_SCRIPT = resolve(process.cwd(), "scripts/seed-daily.ts");

export interface SeedResult {
  ok: boolean;
  code: number | null;
  durationMs: number;
  output: string;
}

/**
 * Run the daily seed script as a subprocess. Non-blocking on the scheduler
 * event loop. Resolves (never rejects) with the exit code and captured
 * stdout/stderr. On error the result's `ok` flag is false and the logger
 * already recorded the failure — callers typically only need to check `ok`.
 */
export function runDailySeed(): Promise<SeedResult> {
  return new Promise((resolveFn) => {
    const start = Date.now();
    let output = "";

    const child = spawn("npx", ["tsx", SEED_SCRIPT], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("error", (err) => {
      const durationMs = Date.now() - start;
      logger.error({ err: err.message, durationMs }, "daily seed spawn failed");
      resolveFn({ ok: false, code: null, durationMs, output: err.message });
    });

    child.on("exit", (code) => {
      const durationMs = Date.now() - start;
      if (code === 0) {
        logger.info(
          { durationMs, outputTail: output.slice(-400).trim() },
          "daily seed completed",
        );
        resolveFn({ ok: true, code, durationMs, output });
      } else {
        logger.error(
          { code, durationMs, outputTail: output.slice(-400).trim() },
          "daily seed exited non-zero",
        );
        resolveFn({ ok: false, code, durationMs, output });
      }
    });
  });
}
