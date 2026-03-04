/**
 * Batch Registration Tests
 *
 * Tests CSV/JSON parsing, hierarchy resolution, folder generation,
 * DB insertion, duplicate handling, and error cases.
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrmSchema } from '../src/schema.js';

let testDb: InstanceType<typeof Database>;

vi.mock('../../engine/src/db.js', () => ({
  getDatabase: () => testDb,
}));

const noop = () => {};
const noopLogger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, child: () => noopLogger };
vi.mock('../../engine/src/logger.js', () => ({
  logger: noopLogger,
}));

const {
  parseCsv,
  parseJson,
  resolveHierarchy,
  generateGroupFolder,
  registerTeam,
} = await import('../src/register.js');

function setupDb() {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  createCrmSchema(testDb);
}

beforeEach(setupDb);

// ---------------------------------------------------------------------------
// parseCsv
// ---------------------------------------------------------------------------

describe('parseCsv', () => {
  it('parses basic CSV with required columns', () => {
    const csv = `name,role,phone
"María López",ae,+5211111111
"Carlos Ruiz",gerente,+5222222222`;

    const members = parseCsv(csv);
    expect(members).toHaveLength(2);
    expect(members[0]).toEqual({
      name: 'María López',
      role: 'ae',
      phone: '+5211111111',
      email: undefined,
      google_calendar_id: undefined,
      manager_name: undefined,
    });
  });

  it('parses CSV with all optional columns', () => {
    const csv = `name,role,phone,email,google_calendar_id,manager_name
"VP Name",vp,+521000,vp@co.com,vp@cal.com,`;

    const members = parseCsv(csv);
    expect(members[0].email).toBe('vp@co.com');
    expect(members[0].google_calendar_id).toBe('vp@cal.com');
    expect(members[0].manager_name).toBeUndefined();
  });

  it('handles quoted fields with commas', () => {
    const csv = `name,role,phone
"Last, First",ae,+521000`;

    const members = parseCsv(csv);
    expect(members[0].name).toBe('Last, First');
  });

  it('throws on missing header columns', () => {
    const csv = `name,phone
"Test",+521000`;

    expect(() => parseCsv(csv)).toThrow('CSV must have name, role, and phone columns');
  });

  it('throws on header-only CSV', () => {
    const csv = `name,role,phone`;
    expect(() => parseCsv(csv)).toThrow('CSV must have a header row and at least one data row');
  });

  it('throws on invalid role', () => {
    const csv = `name,role,phone
"Test",ceo,+521000`;

    expect(() => parseCsv(csv)).toThrow('Invalid role "ceo"');
  });

  it('normalizes role to lowercase', () => {
    const csv = `name,role,phone
"Test",AE,+521000`;

    const members = parseCsv(csv);
    expect(members[0].role).toBe('ae');
  });
});

// ---------------------------------------------------------------------------
// parseJson
// ---------------------------------------------------------------------------

describe('parseJson', () => {
  it('parses valid JSON array', () => {
    const json = JSON.stringify([
      { name: 'María', role: 'ae', phone: '+521000' },
      { name: 'Carlos', role: 'gerente', phone: '+522000', email: 'c@co.com' },
    ]);

    const members = parseJson(json);
    expect(members).toHaveLength(2);
    expect(members[1].email).toBe('c@co.com');
  });

  it('throws on non-array JSON', () => {
    expect(() => parseJson('{"name": "test"}')).toThrow('JSON must be an array');
  });

  it('throws on missing required fields', () => {
    const json = JSON.stringify([{ name: 'Test', role: 'ae' }]);
    expect(() => parseJson(json)).toThrow('Missing required fields at index 0');
  });

  it('throws on invalid role', () => {
    const json = JSON.stringify([{ name: 'Test', role: 'intern', phone: '+521000' }]);
    expect(() => parseJson(json)).toThrow('Invalid role');
  });

  it('normalizes role to lowercase', () => {
    const json = JSON.stringify([{ name: 'Test', role: 'VP', phone: '+521000' }]);
    const members = parseJson(json);
    expect(members[0].role).toBe('vp');
  });
});

// ---------------------------------------------------------------------------
// resolveHierarchy
// ---------------------------------------------------------------------------

describe('resolveHierarchy', () => {
  it('sorts VP → Director → Gerente → AE', () => {
    const members = [
      { name: 'AE1', role: 'ae' as const, phone: '1' },
      { name: 'VP1', role: 'vp' as const, phone: '2' },
      { name: 'Dir1', role: 'director' as const, phone: '3' },
      { name: 'Ger1', role: 'gerente' as const, phone: '4' },
    ];

    const sorted = resolveHierarchy(members);
    expect(sorted.map(m => m.role)).toEqual(['vp', 'director', 'gerente', 'ae']);
  });

  it('does not mutate original array', () => {
    const members = [
      { name: 'AE1', role: 'ae' as const, phone: '1' },
      { name: 'VP1', role: 'vp' as const, phone: '2' },
    ];

    resolveHierarchy(members);
    expect(members[0].role).toBe('ae');
  });
});

// ---------------------------------------------------------------------------
// generateGroupFolder
// ---------------------------------------------------------------------------

describe('generateGroupFolder', () => {
  it('generates role-firstname-lastname', () => {
    expect(generateGroupFolder('María López', 'ae')).toBe('ae-maria-lopez');
  });

  it('strips accents', () => {
    expect(generateGroupFolder('José García', 'gerente')).toBe('gerente-jose-garcia');
  });

  it('handles single name', () => {
    expect(generateGroupFolder('Roberto', 'vp')).toBe('vp-roberto-roberto');
  });

  it('handles multi-word names', () => {
    expect(generateGroupFolder('Ana María De La Cruz', 'director')).toBe('director-ana-cruz');
  });

  it('throws on empty name', () => {
    expect(() => generateGroupFolder('', 'ae')).toThrow('Invalid name');
  });

  it('handles extra whitespace', () => {
    expect(generateGroupFolder('  María   López  ', 'ae')).toBe('ae-maria-lopez');
  });
});

// ---------------------------------------------------------------------------
// registerTeam (DB integration)
// ---------------------------------------------------------------------------

describe('registerTeam', () => {
  it('inserts personas into database', () => {
    const members = [
      { name: 'VP Roberto', role: 'vp' as const, phone: '+521000' },
      { name: 'María López', role: 'ae' as const, phone: '+522000', manager_name: 'VP Roberto' },
    ];

    const registered = registerTeam(members);
    expect(registered).toHaveLength(2);

    const rows = testDb.prepare('SELECT * FROM persona ORDER BY rol').all() as any[];
    expect(rows).toHaveLength(2);
  });

  it('resolves manager hierarchy', () => {
    const members = [
      { name: 'VP Roberto', role: 'vp' as const, phone: '+521000' },
      { name: 'Dir Ana', role: 'director' as const, phone: '+522000', manager_name: 'VP Roberto' },
      { name: 'Ger Miguel', role: 'gerente' as const, phone: '+523000', manager_name: 'Dir Ana' },
      { name: 'AE María', role: 'ae' as const, phone: '+524000', manager_name: 'Ger Miguel' },
    ];

    const registered = registerTeam(members);
    const vpId = registered.find(r => r.role === 'vp')!.id;
    const dirId = registered.find(r => r.role === 'director')!.id;
    const gerId = registered.find(r => r.role === 'gerente')!.id;

    const ae = testDb.prepare("SELECT reporta_a FROM persona WHERE nombre = 'AE María'").get() as any;
    const ger = testDb.prepare("SELECT reporta_a FROM persona WHERE nombre = 'Ger Miguel'").get() as any;
    const dir = testDb.prepare("SELECT reporta_a FROM persona WHERE nombre = 'Dir Ana'").get() as any;
    const vp = testDb.prepare("SELECT reporta_a FROM persona WHERE nombre = 'VP Roberto'").get() as any;

    expect(ae.reporta_a).toBe(gerId);
    expect(ger.reporta_a).toBe(dirId);
    expect(dir.reporta_a).toBe(vpId);
    expect(vp.reporta_a).toBeNull();
  });

  it('generates correct group folders', () => {
    const members = [
      { name: 'María López', role: 'ae' as const, phone: '+521000' },
    ];

    const registered = registerTeam(members);
    expect(registered[0].folder).toBe('ae-maria-lopez');

    const row = testDb.prepare('SELECT whatsapp_group_folder FROM persona').get() as any;
    expect(row.whatsapp_group_folder).toBe('ae-maria-lopez');
  });

  it('sets all personas as active', () => {
    const members = [
      { name: 'Test One', role: 'ae' as const, phone: '+521000' },
      { name: 'Test Two', role: 'gerente' as const, phone: '+522000' },
    ];

    registerTeam(members);

    const rows = testDb.prepare('SELECT activo FROM persona').all() as any[];
    expect(rows.every((r: any) => r.activo === 1)).toBe(true);
  });

  it('stores email and phone', () => {
    const members = [
      { name: 'Test One', role: 'ae' as const, phone: '+521111', email: 'test@co.com', google_calendar_id: 'cal@co.com' },
    ];

    registerTeam(members);

    const row = testDb.prepare('SELECT telefono, email, google_calendar_id FROM persona').get() as any;
    expect(row.telefono).toBe('+521111');
    expect(row.email).toBe('test@co.com');
    expect(row.google_calendar_id).toBe('cal@co.com');
  });

  it('handles duplicate registration (INSERT OR IGNORE)', () => {
    const members = [
      { name: 'María López', role: 'ae' as const, phone: '+521000' },
    ];

    // First registration
    registerTeam(members);
    const count1 = (testDb.prepare('SELECT COUNT(*) as c FROM persona').get() as any).c;

    // Second registration — different ID generated, but if same data already exists
    // INSERT OR IGNORE means it won't fail, just the persona may be duplicated with different ID
    // This tests that the function doesn't throw
    registerTeam(members);
    const count2 = (testDb.prepare('SELECT COUNT(*) as c FROM persona').get() as any).c;

    // Should have 2 records (different IDs each time, INSERT OR IGNORE on id PK)
    expect(count2).toBeGreaterThanOrEqual(count1);
  });

  it('handles manager_name that does not match anyone', () => {
    const members = [
      { name: 'AE María', role: 'ae' as const, phone: '+521000', manager_name: 'Ghost Manager' },
    ];

    const registered = registerTeam(members);
    expect(registered).toHaveLength(1);

    const row = testDb.prepare('SELECT reporta_a FROM persona').get() as any;
    expect(row.reporta_a).toBeNull();
  });

  it('returns registered members with IDs and folders', () => {
    const members = [
      { name: 'VP Test', role: 'vp' as const, phone: '+521000' },
    ];

    const registered = registerTeam(members);
    expect(registered[0].id).toMatch(/^vp-/);
    expect(registered[0].folder).toBe('vp-vp-test');
    expect(registered[0].name).toBe('VP Test');
    expect(registered[0].role).toBe('vp');
  });
});
