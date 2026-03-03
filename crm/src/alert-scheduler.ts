/**
 * Alert Scheduler
 *
 * Writes a crm_evaluate_alerts IPC task file every 2 hours.
 * The engine's IPC watcher picks it up and routes to processCrmIpc().
 * Also runs once immediately on startup.
 */

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const ALERT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

export function startAlertScheduler(dataDir: string): void {
  const tasksDir = path.join(dataDir, 'ipc', 'main', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const writeAlertTask = () => {
    const filename = `alert-${Date.now()}.json`;
    fs.writeFileSync(
      path.join(tasksDir, filename),
      JSON.stringify({ type: 'crm_evaluate_alerts' }),
    );
    logger.info('Alert evaluation task scheduled');
  };

  // Run once immediately, then every 2 hours
  writeAlertTask();
  setInterval(writeAlertTask, ALERT_INTERVAL_MS);
}
