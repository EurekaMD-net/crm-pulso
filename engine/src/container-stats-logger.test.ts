/**
 * Phase 2c — container-stats-logger tests.
 *
 * Pins the cadence + teardown contract. The logger fires every
 * intervalMs ticks, calls queue.getActiveContainers(), and logs each
 * entry. Empty list → no log spam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const info = vi.fn();
vi.mock('./logger.js', () => ({
  logger: {
    info: (...args: unknown[]) => info(...args),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: () => ({
      info: (...args: unknown[]) => info(...args),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
    }),
  },
}));

const { startContainerStatsLogger } =
  await import('./container-stats-logger.js');

/** Minimal queue shape — the logger only calls getActiveContainers(). */
function makeFakeQueue(snapshots: Array<unknown[]>) {
  let i = 0;
  return {
    getActiveContainers: () => {
      const snap = snapshots[Math.min(i, snapshots.length - 1)];
      i++;
      return snap as any;
    },
  } as any;
}

describe('startContainerStatsLogger (Phase 2c)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    info.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs one line per active container per tick', async () => {
    const queue = makeFakeQueue([
      [
        {
          groupJid: 'g1@g.us',
          containerName: 'c1',
          groupFolder: 'f1',
          startedAt: 1000,
          ageMs: 65_000,
          idleWaiting: false,
          isTaskContainer: false,
        },
        {
          groupJid: 'g2@g.us',
          containerName: 'c2',
          groupFolder: 'f2',
          startedAt: 2000,
          ageMs: 30_000,
          idleWaiting: true,
          isTaskContainer: false,
        },
      ],
    ]);

    const stop = startContainerStatsLogger(queue, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        group: 'g1@g.us',
        container: 'c1',
        ageSec: 65,
        idleWaiting: false,
      }),
      'container active',
    );
    expect(info).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        group: 'g2@g.us',
        container: 'c2',
        ageSec: 30,
        idleWaiting: true,
      }),
      'container active',
    );

    stop();
  });

  it('does not log when no containers are active (quiet hours stay quiet)', async () => {
    const queue = makeFakeQueue([[], []]);
    const stop = startContainerStatsLogger(queue, 60_000);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(info).not.toHaveBeenCalled();
    stop();
  });

  it('teardown stops the interval (no further logs after stop)', async () => {
    const oneActive = [
      {
        groupJid: 'g1@g.us',
        containerName: 'c1',
        groupFolder: 'f1',
        startedAt: 0,
        ageMs: 1_000,
        idleWaiting: false,
        isTaskContainer: false,
      },
    ];
    const queue = makeFakeQueue([oneActive, oneActive, oneActive]);

    const stop = startContainerStatsLogger(queue, 60_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(info).toHaveBeenCalledTimes(1);

    stop();

    // Advance well past the next would-be interval; no further logs.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(info).toHaveBeenCalledTimes(1);
  });
});
