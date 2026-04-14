/**
 * Unified CRM Scheduler
 *
 * Replaces 5 independent setInterval schedulers with a single cron-based
 * setTimeout chain. Each entry computes its next fire time via cron-parser,
 * sets a setTimeout, fires, then recomputes. No polling, no wasted cycles.
 *
 * All tasks are written as JSON files to /data/ipc/main/tasks/ and consumed
 * by the engine's IPC watcher → processCrmIpc().
 */

import fs from "fs";
import path from "path";
import { CronExpressionParser } from "cron-parser";
import { logger } from "./logger.js";
import { isBusinessHours } from "./followup-scheduler.js";

// Re-export for ipc-handlers.ts (line 479: dynamic import from warmth-scheduler)
export { recomputeAllWarmth } from "./warmth-scheduler.js";

const TIMEZONE = process.env.TZ || "America/Mexico_City";

interface ScheduleEntry {
  name: string;
  cron: string;
  taskType: string;
  startupBehavior: "immediate" | "delay" | "none";
  startupDelayMs?: number;
  /** Optional guard — task only written if this returns true */
  guard?: () => boolean;
}

const SCHEDULES: ScheduleEntry[] = [
  {
    name: "alerts",
    cron: "0 */2 * * *",
    taskType: "crm_evaluate_alerts",
    startupBehavior: "immediate",
  },
  {
    name: "followups",
    cron: "0 9-17 * * 1-5",
    taskType: "crm_check_followups",
    startupBehavior: "delay",
    startupDelayMs: 5 * 60 * 1000,
    guard: isBusinessHours,
  },
  {
    name: "overnight",
    cron: "0 2 * * *",
    taskType: "crm_overnight_analysis",
    startupBehavior: "none",
  },
  {
    name: "doc-sync",
    cron: "0 3 * * *",
    taskType: "crm_doc_sync",
    startupBehavior: "none",
  },
  {
    name: "warmth",
    cron: "0 4 * * *",
    taskType: "crm_warmth_recompute",
    startupBehavior: "none",
  },
  {
    // Daily activity seeder — fills any date gaps from the last run up to
    // today for every active AE, plus cuota + descarga for the current
    // week. Idempotent (date-based IDs with INSERT OR IGNORE). Runs once
    // on startup and every day at 5 AM Mexico City (after warmth).
    name: "daily-seed",
    cron: "0 5 * * *",
    taskType: "crm_daily_seed",
    startupBehavior: "immediate",
  },
];

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let stopped = false;

function hasPendingTask(tasksDir: string, name: string): boolean {
  try {
    const files = fs.readdirSync(tasksDir);
    return files.some((f) => f.startsWith(`${name}-`) && f.endsWith(".json"));
  } catch {
    return false;
  }
}

function writeTask(tasksDir: string, name: string, taskType: string): void {
  try {
    fs.mkdirSync(tasksDir, { recursive: true });

    // Concurrency guard: if a task file with the same name prefix already
    // exists, the previous run has not yet been consumed by the IPC watcher.
    // Skipping avoids double-fires after a scheduler restart mid-batch
    // (SQLITE_BUSY cascades + half-computed warmth rows).
    if (hasPendingTask(tasksDir, name)) {
      logger.warn(
        { name, taskType },
        "Scheduler task already pending — skipping to avoid overlap",
      );
      return;
    }

    const filename = `${name}-${Date.now()}.json`;
    fs.writeFileSync(
      path.join(tasksDir, filename),
      JSON.stringify({ type: taskType }),
    );
    logger.info({ name, taskType }, "Scheduler task written");
  } catch (err) {
    logger.error({ err, name }, "Failed to write scheduler task file");
  }
}

const RECOVERY_DELAY_MS = 60_000; // retry after 60s on cron error

function scheduleNext(entry: ScheduleEntry, tasksDir: string): void {
  if (stopped) return;

  let delayMs: number;
  try {
    const cron = CronExpressionParser.parse(entry.cron, { tz: TIMEZONE });
    const next = cron.next();
    const iso = next.toISOString();
    delayMs = iso
      ? Math.max(new Date(iso).getTime() - Date.now(), 1000)
      : RECOVERY_DELAY_MS;
  } catch (err) {
    logger.error(
      { err, name: entry.name },
      "Cron parse/next failed, retrying in 60s",
    );
    delayMs = RECOVERY_DELAY_MS;
  }

  const timer = setTimeout(() => {
    if (stopped) return;
    if (!entry.guard || entry.guard()) {
      writeTask(tasksDir, entry.name, entry.taskType);
    }
    scheduleNext(entry, tasksDir);
  }, delayMs);

  if (timer.unref) timer.unref();
  timers.set(entry.name, timer);
}

export function startScheduler(dataDir: string): void {
  stopped = false;
  const tasksDir = path.join(dataDir, "ipc", "main", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });

  for (const entry of SCHEDULES) {
    if (entry.startupBehavior === "immediate") {
      writeTask(tasksDir, entry.name, entry.taskType);
      scheduleNext(entry, tasksDir);
    } else if (entry.startupBehavior === "delay") {
      const delayTimer = setTimeout(() => {
        if (stopped) return;
        if (!entry.guard || entry.guard()) {
          writeTask(tasksDir, entry.name, entry.taskType);
        }
        scheduleNext(entry, tasksDir);
      }, entry.startupDelayMs ?? 0);
      if (delayTimer.unref) delayTimer.unref();
      timers.set(`${entry.name}-startup`, delayTimer);
    } else {
      scheduleNext(entry, tasksDir);
    }
  }

  logger.info({ count: SCHEDULES.length }, "Scheduler started");
}

export function stopScheduler(): void {
  stopped = true;
  for (const [name, timer] of timers) {
    clearTimeout(timer);
    timers.delete(name);
  }
  logger.info("Scheduler stopped");
}
