/**
 * Periodic visibility log for actively-running containers.
 *
 * Phase 2c (Option B) — observability without container internals.
 * Operator can grep journalctl for "container active" to spot stuck
 * containers (high ageSec + idleWaiting=false). The 5-min default
 * cadence is chosen to be informative without spamming the log: a
 * normally-idle container produces 1 log line per 5 min interval per
 * group, which is dominated in volume by other engine activity.
 *
 * If `queue.getActiveContainers()` returns an empty list, the tick
 * logs nothing — quiet hours stay quiet in the log.
 */

import type { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';

const DEFAULT_INTERVAL_MS = 300_000; // 5 minutes

export function startContainerStatsLogger(
  queue: GroupQueue,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): () => void {
  const handle = setInterval(() => {
    // Defensive — getActiveContainers() is pure iteration today, but a
    // future change could throw. Catch here so the unhandled exception
    // can't tear down the interval thread silently.
    let active;
    try {
      active = queue.getActiveContainers();
    } catch (err) {
      logger.warn({ err }, 'container-stats-logger: getActiveContainers threw');
      return;
    }
    if (active.length === 0) return;
    for (const entry of active) {
      logger.info(
        {
          group: entry.groupJid,
          container: entry.containerName,
          ageSec: Math.round(entry.ageMs / 1000),
          idleWaiting: entry.idleWaiting,
          isTaskContainer: entry.isTaskContainer,
        },
        'container active',
      );
    }
  }, intervalMs);

  return () => clearInterval(handle);
}
