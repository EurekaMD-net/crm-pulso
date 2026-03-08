import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrmSchema } from '../src/schema.js';

let testDb: InstanceType<typeof Database>;

vi.mock('../src/db.js', () => ({
  getDatabase: () => testDb,
}));

const {
  isManagerOf,
  isDirectorOf,
  isVp,
  getDirectReports,
  getSubtree,
  hasAccessTo,
  getPersonByGroupFolder,
  getTeamIds,
  getFullTeamIds,
  getRole,
  getManager,
  getDirector,
  _resetStatementCache,
} = await import('../src/hierarchy.js');

/**
 * Test hierarchy:
 *   vp1 (VP)
 *     └── dir1 (Director)
 *           ├── ger1 (Gerente)
 *           │     ├── ae1 (AE, group_folder='ae1')
 *           │     └── ae2 (AE, group_folder='ae2')
 *           └── ger2 (Gerente)
 *                 └── ae3 (AE, group_folder='ae3')
 *   ae4 (AE, no manager, group_folder='ae4') — orphan
 *   ae_inactive (AE, inactive, group_folder='ae_gone')
 */
function setupHierarchy() {
  testDb = new Database(':memory:');
    sqliteVec.load(testDb);
  testDb.pragma('foreign_keys = ON');
  createCrmSchema(testDb);
  _resetStatementCache();

  const insert = testDb.prepare(`
    INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insert.run('vp1', 'Roberto Vega', 'vp', null, 'vp1', 1);
  insert.run('dir1', 'Ana Martínez', 'director', 'vp1', 'dir1', 1);
  insert.run('ger1', 'Miguel Ríos', 'gerente', 'dir1', 'ger1', 1);
  insert.run('ger2', 'Laura Sánchez', 'gerente', 'dir1', 'ger2', 1);
  insert.run('ae1', 'María López', 'ae', 'ger1', 'ae1', 1);
  insert.run('ae2', 'Carlos Hernández', 'ae', 'ger1', 'ae2', 1);
  insert.run('ae3', 'José García', 'ae', 'ger2', 'ae3', 1);
  insert.run('ae4', 'AE Orphan', 'ae', null, 'ae4', 1);
  insert.run('ae_inactive', 'AE Gone', 'ae', 'ger1', 'ae_gone', 0);
}

beforeEach(setupHierarchy);

describe('isManagerOf', () => {
  it('returns true for direct report', () => {
    expect(isManagerOf('ger1', 'ae1')).toBe(true);
  });

  it('returns false for non-report', () => {
    expect(isManagerOf('ger1', 'ae3')).toBe(false);
  });
});

describe('isDirectorOf', () => {
  it('returns true for 2-level report', () => {
    expect(isDirectorOf('dir1', 'ae1')).toBe(true);
  });

  it('returns true for direct report of director', () => {
    expect(isDirectorOf('dir1', 'ger1')).toBe(true);
  });

  it('returns false for orphan outside subtree', () => {
    expect(isDirectorOf('dir1', 'ae4')).toBe(false);
  });
});

describe('isVp', () => {
  it('identifies VP role', () => {
    expect(isVp('vp1')).toBe(true);
  });

  it('returns false for non-VP', () => {
    expect(isVp('dir1')).toBe(false);
  });
});

describe('getDirectReports', () => {
  it('returns immediate children only', () => {
    const reports = getDirectReports('ger1');
    const ids = reports.map((r) => r.id).sort();
    expect(ids).toEqual(['ae1', 'ae2']);
  });

  it('excludes inactive members', () => {
    // ae_inactive reports to ger1 but is inactive
    const reports = getDirectReports('ger1');
    const ids = reports.map((r) => r.id);
    expect(ids).not.toContain('ae_inactive');
  });
});

describe('getTeamIds', () => {
  it('returns IDs of direct reports', () => {
    const ids = getTeamIds('ger1').sort();
    expect(ids).toEqual(['ae1', 'ae2']);
  });
});

describe('getFullTeamIds', () => {
  it('returns all descendant IDs recursively', () => {
    const ids = getFullTeamIds('dir1').sort();
    expect(ids).toEqual(['ae1', 'ae2', 'ae3', 'ger1', 'ger2']);
  });
});

describe('getSubtree', () => {
  it('returns full recursive tree', () => {
    const tree = getSubtree('dir1');
    const ids = tree.map((r) => r.id).sort();
    expect(ids).toEqual(['ae1', 'ae2', 'ae3', 'ger1', 'ger2']);
  });

  it('returns empty for leaf node', () => {
    expect(getSubtree('ae1')).toEqual([]);
  });
});

describe('getRole', () => {
  it('returns correct role', () => {
    expect(getRole('ae1')).toBe('ae');
    expect(getRole('ger1')).toBe('gerente');
    expect(getRole('dir1')).toBe('director');
    expect(getRole('vp1')).toBe('vp');
  });

  it('returns null for unknown ID', () => {
    expect(getRole('nonexistent')).toBeNull();
  });
});

describe('getManager', () => {
  it('returns manager ID', () => {
    expect(getManager('ae1')).toBe('ger1');
    expect(getManager('ger1')).toBe('dir1');
  });

  it('returns null for root', () => {
    expect(getManager('vp1')).toBeNull();
  });
});

describe('getDirector', () => {
  it('returns director for AE (2 levels up)', () => {
    expect(getDirector('ae1')).toBe('dir1');
  });

  it('returns director for gerente (1 level up)', () => {
    expect(getDirector('ger1')).toBe('dir1');
  });

  it('returns self for director', () => {
    expect(getDirector('dir1')).toBe('dir1');
  });
});

describe('hasAccessTo', () => {
  it('allows self-access for AE', () => {
    expect(hasAccessTo('ae1', 'ae1')).toBe(true);
  });

  it('blocks cross-AE access', () => {
    expect(hasAccessTo('ae1', 'ae2')).toBe(false);
  });

  it('allows gerente -> direct report', () => {
    expect(hasAccessTo('ger1', 'ae1')).toBe(true);
  });

  it('blocks gerente -> non-report', () => {
    expect(hasAccessTo('ger1', 'ae3')).toBe(false);
  });

  it('allows director -> 2-level report', () => {
    expect(hasAccessTo('dir1', 'ae1')).toBe(true);
  });

  it('allows VP -> anyone', () => {
    expect(hasAccessTo('vp1', 'ae3')).toBe(true);
  });

  it('returns false for unknown group folder', () => {
    expect(hasAccessTo('nonexistent', 'ae1')).toBe(false);
  });
});

describe('getPersonByGroupFolder', () => {
  it('finds active person', () => {
    const p = getPersonByGroupFolder('ae1');
    expect(p).toBeDefined();
    expect(p!.nombre).toBe('María López');
  });

  it('returns undefined for inactive person', () => {
    expect(getPersonByGroupFolder('ae_gone')).toBeUndefined();
  });
});

describe('hasAccessTo — Persona overload', () => {
  it('accepts a Persona object directly', () => {
    const person = getPersonByGroupFolder('ger1')!;
    expect(person).toBeDefined();
    expect(hasAccessTo(person, 'ae1')).toBe(true);
  });
});
