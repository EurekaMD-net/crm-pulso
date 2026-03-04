/**
 * Follow-up Scheduler
 *
 * Writes crm_check_followups IPC task hourly during business hours
 * (9:00-18:00 weekdays, Mexico City time).
 * The engine's IPC watcher picks it up and routes to processCrmIpc().
 */

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const FOLLOWUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function isBusinessHours(): boolean {
  // Mexico City is UTC-6 (CST) or UTC-5 (CDT)
  const now = new Date();
  // Use toLocaleString to get Mexico City local time
  const mxTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const hour = mxTime.getHours();
  const day = mxTime.getDay(); // 0=Sun, 6=Sat
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
}

export function startFollowupScheduler(dataDir: string): void {
  const tasksDir = path.join(dataDir, 'ipc', 'main', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const writeFollowupTask = () => {
    if (!isBusinessHours()) return;
    const filename = `followup-${Date.now()}.json`;
    fs.writeFileSync(
      path.join(tasksDir, filename),
      JSON.stringify({ type: 'crm_check_followups' }),
    );
    logger.info('Follow-up check task scheduled');
  };

  // Delay first run by 5 minutes to let system stabilize after startup
  setTimeout(() => {
    writeFollowupTask();
    setInterval(writeFollowupTask, FOLLOWUP_INTERVAL_MS);
  }, 5 * 60 * 1000);
}
