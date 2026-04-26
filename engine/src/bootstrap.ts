/**
 * Engine bootstrap sequence.
 *
 * Pulled out of index.ts:main() to keep startup logic separate from the
 * message-loop wiring. Called once at process start; returns the
 * long-lived handles (currently just proxyServer) that main() needs to
 * wire into the shutdown handler.
 *
 * Order of operations is load-bearing:
 *
 *   1. ensureContainerSystemRunning — verify docker is reachable + reap
 *      orphaned containers from a previous (crashed) run.
 *   2. initDatabase — engine SQLite must exist before any subsystem reads
 *      it.
 *   3. bootstrapCrm — CRM hook. Validates env, creates schema, registers
 *      memory + eviction services. If this throws we exit(1) — the CRM
 *      and engine share the same DB, so partial CRM state is worse than
 *      a hard restart.
 *   4. startScheduler — CRM cron loop (alerts, followups, warmth,
 *      overnight, doc-sync). Depends on the schema from step 3.
 *   5. seedBriefings — idempotent, safe after schema exists.
 *   6. startDashboardServer — HTTP listener for the dashboard REST API.
 *   7. startCredentialProxy — host-side proxy that masks Anthropic API
 *      keys from agent containers. Awaited; the returned handle goes back
 *      to main() so SIGTERM can close it.
 *
 * Anything that depends on engine module state (registeredGroups,
 * sessions, channels, queue, etc.) STAYS in index.ts. The split here is
 * "subsystems that boot themselves" vs "the runtime state machine."
 */

import type { Server } from 'http';

import { bootstrapCrm } from '../../crm/src/bootstrap.js';
import { seedBriefings } from '../../crm/src/briefing-seeds.js';
import { startScheduler } from '../../crm/src/scheduler.js';
import { startDashboardServer } from '../../crm/src/dashboard/server.js';
import { CREDENTIAL_PROXY_PORT, DATA_DIR } from './config.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import { startCredentialProxy } from './credential-proxy.js';
import { initDatabase } from './db.js';
import type { ActiveContainerInfo } from './group-queue.js';
import { logger } from './logger.js';

/**
 * Verify the container runtime is reachable and clean up any orphans
 * left over from a previous crashed run. Pure side-effects, no shared
 * state — kept private to this module since main() no longer calls it
 * directly after the extraction.
 */
function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

export interface BootstrapHandles {
  proxyServer: Server;
}

/**
 * Optional dependencies threaded into bootstrapEngine. Right now the
 * only one is `getActiveContainers` for Phase 2c observability — the
 * GroupQueue is created in index.ts and stays there, so its getter is
 * passed in here rather than bootstrap.ts importing the queue
 * instance.
 */
export interface BootstrapOptions {
  getActiveContainers?: () => ActiveContainerInfo[];
}

export async function bootstrapEngine(
  opts: BootstrapOptions = {},
): Promise<BootstrapHandles> {
  ensureContainerSystemRunning();
  initDatabase();
  try {
    bootstrapCrm(); // CRM hook: initialize CRM schema and hooks
  } catch (err) {
    logger.fatal({ err }, 'CRM bootstrap failed — aborting startup');
    process.exit(1);
  }
  startScheduler(DATA_DIR); // CRM hook: unified cron scheduler (alerts, followups, warmth, overnight, doc-sync)
  seedBriefings(); // CRM hook: idempotent briefing task seeding
  startDashboardServer(undefined, {
    getActiveContainers: opts.getActiveContainers,
  }); // CRM hook: dashboard REST API + Phase 2c container visibility
  logger.info('Database initialized');

  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  return { proxyServer };
}
