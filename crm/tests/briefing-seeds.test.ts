/**
 * Briefing Seeds Tests
 *
 * Tests idempotent seeding of cron-scheduled briefing tasks.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrmSchema } from '../src/schema.js';

let testDb: InstanceType<typeof Database>;

vi.mock('../src/db.js', () => ({
  getDatabase: () => testDb,
}));

vi.mock('../../engine/src/db.js', () => ({
  getDatabase: () => testDb,
  createTask: (task: any) => {
    testDb.prepare(`
      INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.group_folder, task.chat_jid, task.prompt, task.schedule_type, task.schedule_value, task.context_mode, task.next_run, task.status, task.created_at);
  },
}));

// Mock cron-parser (engine dependency, not installed in CRM)
vi.mock('cron-parser', () => ({
  CronExpressionParser: {
    parse: () => ({
      next: () => ({ toISOString: () => new Date(Date.now() + 86400000).toISOString() }),
    }),
  },
}));

// Mock engine config
vi.mock('../../engine/src/config.js', () => ({
  TIMEZONE: 'America/Mexico_City',
}));

const noop = () => {};
const noopLogger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, child: () => noopLogger };
vi.mock('../src/logger.js', () => ({
  logger: noopLogger,
}));

const { seedBriefings, BRIEFING_SEEDS } = await import('../src/briefing-seeds.js');
const { _resetStatementCache } = await import('../src/hierarchy.js');

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setupDb() {
  testDb = new Database(':memory:');
    sqliteVec.load(testDb);
  testDb.pragma('foreign_keys = ON');
  createCrmSchema(testDb);
  _resetStatementCache();

  // Create scheduled_tasks and registered_groups tables (engine tables)
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Org chart: Gerente -> AE1, AE2
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ger1', 'Miguel', 'gerente', null, 'ger-miguel', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ae1', 'Maria', 'ae', 'ger1', 'ae-maria', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ae2', 'Carlos', 'ae', 'ger1', 'ae-carlos', 1)`).run();
  // Inactive AE
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ae3', 'Pedro', 'ae', 'ger1', 'ae-pedro', 0)`).run();
  // AE without group folder
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ae4', 'Luis', 'ae', 'ger1', null, 1)`).run();
  // Director
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('dir1', 'Ana', 'director', null, 'dir-ana', 1)`).run();
  // VP
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('vp1', 'Roberto', 'vp', null, 'vp-roberto', 1)`).run();

  // Register groups (JID <-> folder mapping)
  testDb.prepare(`INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at) VALUES ('jid-ae1', 'AE Maria', 'ae-maria', '@bot', '2026-01-01')`).run();
  testDb.prepare(`INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at) VALUES ('jid-ae2', 'AE Carlos', 'ae-carlos', '@bot', '2026-01-01')`).run();
  testDb.prepare(`INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at) VALUES ('jid-ger1', 'Gerente Miguel', 'ger-miguel', '@bot', '2026-01-01')`).run();
  testDb.prepare(`INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at) VALUES ('jid-dir1', 'Director Ana', 'dir-ana', '@bot', '2026-01-01')`).run();
  testDb.prepare(`INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at) VALUES ('jid-vp1', 'VP Roberto', 'vp-roberto', '@bot', '2026-01-01')`).run();
}

beforeEach(setupDb);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('seedBriefings', () => {
  it('creates correct number of tasks per role', () => {
    seedBriefings();

    const tasks = testDb.prepare('SELECT * FROM scheduled_tasks').all() as any[];
    // AE: 2 seeds x 2 active AEs with groups = 4
    // Gerente: 1 seed x 1 = 1
    // Director: 1 seed x 1 = 1
    // VP: 1 seed x 1 = 1
    // Total: 7
    expect(tasks.length).toBe(7);
  });

  it('is idempotent — second call creates no new tasks', () => {
    seedBriefings();
    const first = testDb.prepare('SELECT COUNT(*) as c FROM scheduled_tasks').get() as any;

    seedBriefings();
    const second = testDb.prepare('SELECT COUNT(*) as c FROM scheduled_tasks').get() as any;

    expect(second.c).toBe(first.c);
  });

  it('creates tasks with correct cron expressions', () => {
    seedBriefings();

    const aeTasks = testDb.prepare(
      "SELECT * FROM scheduled_tasks WHERE group_folder = 'ae-maria' ORDER BY schedule_value",
    ).all() as any[];

    const crons = aeTasks.map((t: any) => t.schedule_value).sort();
    expect(crons).toEqual(['0 16 * * 5', '10 9 * * 1-5']);
  });

  it('skips inactive personas', () => {
    seedBriefings();

    const pedroTasks = testDb.prepare(
      "SELECT * FROM scheduled_tasks WHERE group_folder = 'ae-pedro'",
    ).all();

    expect(pedroTasks.length).toBe(0);
  });

  it('skips personas without whatsapp_group_folder', () => {
    seedBriefings();

    // ae4 (Luis) has no group folder — should not create tasks
    // We can't easily check by null folder, but total count verifies this
    const tasks = testDb.prepare('SELECT * FROM scheduled_tasks').all() as any[];
    const folders = tasks.map((t: any) => t.group_folder);
    expect(folders).not.toContain(null);
  });

  it('skips personas whose group is not registered', () => {
    // Remove ae2's registration
    testDb.prepare("DELETE FROM registered_groups WHERE folder = 'ae-carlos'").run();

    seedBriefings();

    const carlosTasks = testDb.prepare(
      "SELECT * FROM scheduled_tasks WHERE group_folder = 'ae-carlos'",
    ).all();

    expect(carlosTasks.length).toBe(0);
  });

  it('all tasks have context_mode group', () => {
    seedBriefings();

    const tasks = testDb.prepare('SELECT context_mode FROM scheduled_tasks').all() as any[];
    expect(tasks.every((t: any) => t.context_mode === 'group')).toBe(true);
  });

  it('all tasks have status active', () => {
    seedBriefings();

    const tasks = testDb.prepare('SELECT status FROM scheduled_tasks').all() as any[];
    expect(tasks.every((t: any) => t.status === 'active')).toBe(true);
  });

  it('all tasks have valid future next_run', () => {
    seedBriefings();

    const tasks = testDb.prepare('SELECT next_run FROM scheduled_tasks').all() as any[];
    const now = new Date();
    for (const t of tasks) {
      expect(t.next_run).toBeTruthy();
      expect(new Date(t.next_run as string).getTime()).toBeGreaterThan(now.getTime() - 60000);
    }
  });

  it('BRIEFING_SEEDS covers all expected roles', () => {
    const roles = [...new Set(BRIEFING_SEEDS.map(s => s.rol))];
    expect(roles.sort()).toEqual(['ae', 'director', 'gerente', 'vp']);
  });
});

// ---------------------------------------------------------------------------
// Stagger order verification
// ---------------------------------------------------------------------------

describe('briefing stagger order', () => {
  it('VP fires before Director', () => {
    const vpSeed = BRIEFING_SEEDS.find(s => s.rol === 'vp')!;
    const dirSeed = BRIEFING_SEEDS.find(s => s.rol === 'director')!;

    // VP: 45 8 → 8:45, Director: 52 8 → 8:52
    const vpMinute = parseInt(vpSeed.cron.split(' ')[0]);
    const vpHour = parseInt(vpSeed.cron.split(' ')[1]);
    const dirMinute = parseInt(dirSeed.cron.split(' ')[0]);
    const dirHour = parseInt(dirSeed.cron.split(' ')[1]);

    expect(vpHour * 60 + vpMinute).toBeLessThan(dirHour * 60 + dirMinute);
  });

  it('Director fires before Gerente', () => {
    const dirSeed = BRIEFING_SEEDS.find(s => s.rol === 'director')!;
    const gerSeed = BRIEFING_SEEDS.find(s => s.rol === 'gerente')!;

    const dirMinute = parseInt(dirSeed.cron.split(' ')[0]);
    const dirHour = parseInt(dirSeed.cron.split(' ')[1]);
    const gerMinute = parseInt(gerSeed.cron.split(' ')[0]);
    const gerHour = parseInt(gerSeed.cron.split(' ')[1]);

    expect(dirHour * 60 + dirMinute).toBeLessThan(gerHour * 60 + gerMinute);
  });

  it('Gerente fires before AE morning', () => {
    const gerSeed = BRIEFING_SEEDS.find(s => s.rol === 'gerente')!;
    const aeMorningSeed = BRIEFING_SEEDS.find(s => s.rol === 'ae' && s.cron.includes('1-5'))!;

    const gerMinute = parseInt(gerSeed.cron.split(' ')[0]);
    const gerHour = parseInt(gerSeed.cron.split(' ')[1]);
    const aeMinute = parseInt(aeMorningSeed.cron.split(' ')[0]);
    const aeHour = parseInt(aeMorningSeed.cron.split(' ')[1]);

    expect(gerHour * 60 + gerMinute).toBeLessThan(aeHour * 60 + aeMinute);
  });

  it('all seeds have distinct cron expressions per role', () => {
    const seen = new Set<string>();
    for (const seed of BRIEFING_SEEDS) {
      const key = `${seed.rol}::${seed.cron}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
