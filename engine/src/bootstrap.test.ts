/**
 * Phase 2b — bootstrap sequence tests.
 *
 * The bootstrap sequence used to live inline in index.ts:main(). The
 * extraction must preserve:
 *   1. The order of subsystem initialization (load-bearing — schema
 *      must exist before scheduler starts, etc.)
 *   2. The fail-fast behavior when bootstrapCrm throws (process.exit(1))
 *   3. The proxyServer return value used by main()'s shutdown handler
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const initDatabase = vi.fn();
const bootstrapCrm = vi.fn();
const startScheduler = vi.fn();
const seedBriefings = vi.fn();
const startDashboardServer = vi.fn();
const startCredentialProxy = vi.fn(
  async () =>
    ({
      fakeServer: true,
    }) as any,
);
const ensureContainerRuntimeRunning = vi.fn();
const cleanupOrphans = vi.fn();
const fatal = vi.fn();
const info = vi.fn();

vi.mock('../../crm/src/bootstrap.js', () => ({
  bootstrapCrm: () => bootstrapCrm(),
}));
vi.mock('../../crm/src/briefing-seeds.js', () => ({
  seedBriefings: () => seedBriefings(),
}));
vi.mock('../../crm/src/scheduler.js', () => ({
  startScheduler: (dir: string) => startScheduler(dir),
}));
vi.mock('../../crm/src/dashboard/server.js', () => ({
  startDashboardServer: () => startDashboardServer(),
}));
vi.mock('./credential-proxy.js', () => ({
  startCredentialProxy: (port: number, host: string) =>
    startCredentialProxy(port, host),
}));
vi.mock('./container-runtime.js', () => ({
  ensureContainerRuntimeRunning: () => ensureContainerRuntimeRunning(),
  cleanupOrphans: () => cleanupOrphans(),
  PROXY_BIND_HOST: '127.0.0.1',
}));
vi.mock('./db.js', () => ({
  initDatabase: () => initDatabase(),
}));
vi.mock('./config.js', () => ({
  CREDENTIAL_PROXY_PORT: 7462,
  DATA_DIR: '/tmp/test-data',
}));
vi.mock('./logger.js', () => ({
  logger: {
    fatal: (...args: unknown[]) => fatal(...args),
    info: (...args: unknown[]) => info(...args),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      fatal: (...args: unknown[]) => fatal(...args),
      info: (...args: unknown[]) => info(...args),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

const { bootstrapEngine } = await import('./bootstrap.js');

describe('bootstrapEngine (Phase 2b)', () => {
  beforeEach(() => {
    initDatabase.mockClear();
    bootstrapCrm.mockClear();
    startScheduler.mockClear();
    seedBriefings.mockClear();
    startDashboardServer.mockClear();
    startCredentialProxy.mockClear();
    ensureContainerRuntimeRunning.mockClear();
    cleanupOrphans.mockClear();
    fatal.mockClear();
    info.mockClear();
  });

  it('calls subsystems in the expected order and returns proxyServer', async () => {
    const handles = await bootstrapEngine();

    // Each subsystem fired once.
    expect(ensureContainerRuntimeRunning).toHaveBeenCalledTimes(1);
    expect(cleanupOrphans).toHaveBeenCalledTimes(1);
    expect(initDatabase).toHaveBeenCalledTimes(1);
    expect(bootstrapCrm).toHaveBeenCalledTimes(1);
    expect(startScheduler).toHaveBeenCalledWith('/tmp/test-data');
    expect(seedBriefings).toHaveBeenCalledTimes(1);
    expect(startDashboardServer).toHaveBeenCalledTimes(1);
    expect(startCredentialProxy).toHaveBeenCalledWith(7462, '127.0.0.1');

    // Order: container runtime → cleanup → initDB → CRM → scheduler →
    // briefings → dashboard → proxy. The CRM schema must exist before
    // the scheduler tries to read it, so this ordering is load-bearing.
    const order = [
      ensureContainerRuntimeRunning.mock.invocationCallOrder[0],
      cleanupOrphans.mock.invocationCallOrder[0],
      initDatabase.mock.invocationCallOrder[0],
      bootstrapCrm.mock.invocationCallOrder[0],
      startScheduler.mock.invocationCallOrder[0],
      seedBriefings.mock.invocationCallOrder[0],
      startDashboardServer.mock.invocationCallOrder[0],
      startCredentialProxy.mock.invocationCallOrder[0],
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1]);
    }

    // The handle main() needs for SIGTERM teardown.
    expect(handles.proxyServer).toEqual({ fakeServer: true });
  });

  it('exits process when bootstrapCrm throws (fail-fast contract)', async () => {
    // Replace process.exit with a sentinel throw so the test can observe
    // the exit attempt without actually killing the test runner.
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: number | string | null) => {
        throw new Error(`__exit_called__:${code}`);
      });

    bootstrapCrm.mockImplementationOnce(() => {
      throw new Error('schema migration failed');
    });

    await expect(bootstrapEngine()).rejects.toThrow('__exit_called__:1');
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'CRM bootstrap failed — aborting startup',
    );

    // Subsystems that come AFTER bootstrapCrm in the sequence must not
    // have fired — fail-fast means we stop at the failure point.
    expect(startScheduler).not.toHaveBeenCalled();
    expect(seedBriefings).not.toHaveBeenCalled();
    expect(startDashboardServer).not.toHaveBeenCalled();
    expect(startCredentialProxy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});
