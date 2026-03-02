/**
 * CRM IPC Handlers Tests
 *
 * Tests for the new domain-specific IPC types:
 *   - crm_registrar_actividad
 *   - crm_actualizar_propuesta (with access control)
 *   - crm_crear_propuesta
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrmSchema } from '../src/schema.js';
import type { IpcDeps } from '../../engine/src/ipc.js';

let testDb: InstanceType<typeof Database>;

vi.mock('../../engine/src/db.js', () => ({
  getDatabase: () => testDb,
  _initTestDatabase: () => {},
}));

const noop = () => {};
const noopLogger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, child: () => noopLogger };
vi.mock('../../engine/src/logger.js', () => ({
  logger: noopLogger,
}));

const { processCrmIpc, _resetStatementCache } = await import('../src/ipc-handlers.js');
const { _resetStatementCache: _resetHierarchyCache } = await import('../src/hierarchy.js');

const fakeDeps: IpcDeps = {
  sendMessage: async () => {},
  registeredGroups: () => ({}),
  registerGroup: () => {},
};

function setupDb() {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  createCrmSchema(testDb);
  _resetStatementCache();
  _resetHierarchyCache();

  // AE1 and AE2 in separate groups
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo) VALUES ('ae1', 'María', 'ae', 'ae1', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, activo) VALUES ('ae2', 'Carlos', 'ae', 'ae2', 1)`).run();

  // Gerente manages ae1
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, whatsapp_group_folder, reporta_a, activo) VALUES ('ger1', 'Miguel', 'gerente', 'ger1', null, 1)`).run();
  testDb.prepare(`UPDATE persona SET reporta_a = 'ger1' WHERE id = 'ae1'`).run();

  // Cuenta owned by ae1
  testDb.prepare(`INSERT INTO cuenta (id, nombre, tipo, ae_id) VALUES ('c1', 'Coca-Cola', 'directo', 'ae1')`).run();

  // Propuesta owned by ae1
  testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa) VALUES ('prop1', 'c1', 'ae1', 'Campaña Verano', 5000000, 'enviada')`).run();
}

// --- crm_registrar_actividad ---

describe('crm_registrar_actividad', () => {
  beforeEach(setupDb);

  it('creates an actividad for a valid persona', async () => {
    await processCrmIpc(
      { type: 'crm_registrar_actividad', cuenta_id: 'c1', tipo: 'llamada', resumen: 'Llamé al cliente sobre propuesta', sentimiento: 'positivo' },
      'ae1', false, fakeDeps,
    );

    const row = testDb.prepare('SELECT * FROM actividad WHERE ae_id = ?').get('ae1') as any;
    expect(row).toBeDefined();
    expect(row.resumen).toBe('Llamé al cliente sobre propuesta');
    expect(row.sentimiento).toBe('positivo');
    expect(row.tipo).toBe('llamada');
  });

  it('falls back to "otro" for unknown tipo', async () => {
    await processCrmIpc(
      { type: 'crm_registrar_actividad', tipo: 'smoke_signal', resumen: 'Test' },
      'ae1', false, fakeDeps,
    );

    const row = testDb.prepare('SELECT tipo FROM actividad ORDER BY fecha DESC LIMIT 1').get() as any;
    expect(row.tipo).toBe('otro');
  });

  it('falls back to "neutral" for invalid sentimiento', async () => {
    await processCrmIpc(
      { type: 'crm_registrar_actividad', tipo: 'llamada', resumen: 'Test', sentimiento: 'happy' },
      'ae1', false, fakeDeps,
    );

    const row = testDb.prepare('SELECT sentimiento FROM actividad ORDER BY fecha DESC LIMIT 1').get() as any;
    expect(row.sentimiento).toBe('neutral');
  });

  it('updates propuesta.fecha_ultima_actividad when linked', async () => {
    const before = testDb.prepare('SELECT fecha_ultima_actividad FROM propuesta WHERE id = ?').get('prop1') as any;

    await processCrmIpc(
      { type: 'crm_registrar_actividad', propuesta_id: 'prop1', tipo: 'reunion', resumen: 'Revisión de propuesta' },
      'ae1', false, fakeDeps,
    );

    const after = testDb.prepare('SELECT fecha_ultima_actividad, dias_sin_actividad FROM propuesta WHERE id = ?').get('prop1') as any;
    expect(after.dias_sin_actividad).toBe(0);
    expect(after.fecha_ultima_actividad >= before.fecha_ultima_actividad).toBe(true);
  });

  it('returns true silently for unknown group', async () => {
    const result = await processCrmIpc(
      { type: 'crm_registrar_actividad', tipo: 'llamada', resumen: 'Ghost' },
      'nonexistent', false, fakeDeps,
    );
    expect(result).toBe(true);
    expect(testDb.prepare('SELECT COUNT(*) as c FROM actividad').get() as any).toEqual({ c: 0 });
  });

  it('uses server-side timestamp', async () => {
    const before = new Date().toISOString();
    await processCrmIpc(
      { type: 'crm_registrar_actividad', tipo: 'llamada', resumen: 'Test', fecha: '2020-01-01' },
      'ae1', false, fakeDeps,
    );
    const after = new Date().toISOString();

    const row = testDb.prepare('SELECT fecha FROM actividad ORDER BY fecha DESC LIMIT 1').get() as any;
    expect(row.fecha >= before).toBe(true);
    expect(row.fecha <= after).toBe(true);
  });
});

// --- crm_actualizar_propuesta ---

describe('crm_actualizar_propuesta — access control', () => {
  beforeEach(setupDb);

  it('blocks AE from updating another AE\'s propuesta', async () => {
    await processCrmIpc(
      { type: 'crm_actualizar_propuesta', propuesta_id: 'prop1', etapa: 'en_negociacion' },
      'ae2', false, fakeDeps,
    );

    const row = testDb.prepare('SELECT etapa FROM propuesta WHERE id = ?').get('prop1') as any;
    expect(row.etapa).toBe('enviada'); // unchanged
  });

  it('allows AE to update own propuesta', async () => {
    await processCrmIpc(
      { type: 'crm_actualizar_propuesta', propuesta_id: 'prop1', etapa: 'en_negociacion' },
      'ae1', false, fakeDeps,
    );

    const row = testDb.prepare('SELECT etapa FROM propuesta WHERE id = ?').get('prop1') as any;
    expect(row.etapa).toBe('en_negociacion');
  });

  it('allows gerente to update report\'s propuesta', async () => {
    await processCrmIpc(
      { type: 'crm_actualizar_propuesta', propuesta_id: 'prop1', etapa: 'confirmada_verbal' },
      'ger1', true, fakeDeps,
    );

    const row = testDb.prepare('SELECT etapa FROM propuesta WHERE id = ?').get('prop1') as any;
    expect(row.etapa).toBe('confirmada_verbal');
  });
});

describe('crm_actualizar_propuesta — validation', () => {
  beforeEach(setupDb);

  it('ignores invalid etapa', async () => {
    await processCrmIpc(
      { type: 'crm_actualizar_propuesta', propuesta_id: 'prop1', etapa: 'flying' },
      'ae1', false, fakeDeps,
    );

    const row = testDb.prepare('SELECT etapa FROM propuesta WHERE id = ?').get('prop1') as any;
    expect(row.etapa).toBe('enviada'); // unchanged
  });

  it('ignores negative valor_estimado', async () => {
    await processCrmIpc(
      { type: 'crm_actualizar_propuesta', propuesta_id: 'prop1', valor_estimado: -1000 },
      'ae1', false, fakeDeps,
    );

    const row = testDb.prepare('SELECT valor_estimado FROM propuesta WHERE id = ?').get('prop1') as any;
    expect(row.valor_estimado).toBe(5000000); // unchanged
  });

  it('skips update when all fields invalid', async () => {
    await processCrmIpc(
      { type: 'crm_actualizar_propuesta', propuesta_id: 'prop1', etapa: 'invalid' },
      'ae1', false, fakeDeps,
    );

    const row = testDb.prepare('SELECT etapa FROM propuesta WHERE id = ?').get('prop1') as any;
    expect(row.etapa).toBe('enviada');
  });

  it('handles missing propuesta_id', async () => {
    const result = await processCrmIpc(
      { type: 'crm_actualizar_propuesta', etapa: 'completada' },
      'ae1', false, fakeDeps,
    );
    expect(result).toBe(true);
  });

  it('handles nonexistent propuesta_id', async () => {
    const result = await processCrmIpc(
      { type: 'crm_actualizar_propuesta', propuesta_id: 'ghost', etapa: 'completada' },
      'ae1', false, fakeDeps,
    );
    expect(result).toBe(true);
  });
});

// --- crm_crear_propuesta ---

describe('crm_crear_propuesta', () => {
  beforeEach(setupDb);

  it('creates a propuesta for valid persona', async () => {
    await processCrmIpc(
      { type: 'crm_crear_propuesta', cuenta_id: 'c1', titulo: 'Campaña Navidad', valor_estimado: 8000000, tipo_oportunidad: 'estacional' },
      'ae1', false, fakeDeps,
    );

    const row = testDb.prepare("SELECT * FROM propuesta WHERE titulo = 'Campaña Navidad'").get() as any;
    expect(row).toBeDefined();
    expect(row.ae_id).toBe('ae1');
    expect(row.valor_estimado).toBe(8000000);
    expect(row.etapa).toBe('en_preparacion');
  });

  it('returns true silently for unknown group', async () => {
    const result = await processCrmIpc(
      { type: 'crm_crear_propuesta', titulo: 'Ghost' },
      'nonexistent', false, fakeDeps,
    );
    expect(result).toBe(true);
  });
});

// --- Unknown types ---

describe('unknown IPC types', () => {
  beforeEach(setupDb);

  it('returns false for unrecognised types', async () => {
    const result = await processCrmIpc(
      { type: 'crm_does_not_exist' },
      'ae1', false, fakeDeps,
    );
    expect(result).toBe(false);
  });
});

// --- Input safety ---

describe('input safety', () => {
  beforeEach(setupDb);

  it('truncates oversized resumen', async () => {
    const longResumen = 'x'.repeat(20_000);
    await processCrmIpc(
      { type: 'crm_registrar_actividad', tipo: 'llamada', resumen: longResumen },
      'ae1', false, fakeDeps,
    );

    const row = testDb.prepare('SELECT resumen FROM actividad ORDER BY fecha DESC LIMIT 1').get() as any;
    expect(row.resumen.length).toBe(10_000);
  });

  it('handles non-string resumen', async () => {
    await processCrmIpc(
      { type: 'crm_registrar_actividad', tipo: 'llamada', resumen: 42 },
      'ae1', false, fakeDeps,
    );

    const row = testDb.prepare('SELECT resumen FROM actividad ORDER BY fecha DESC LIMIT 1').get() as any;
    expect(row.resumen).toBe('');
  });

  it('handles non-string propuesta_id', async () => {
    const result = await processCrmIpc(
      { type: 'crm_actualizar_propuesta', propuesta_id: 42, etapa: 'completada' },
      'ae1', false, fakeDeps,
    );
    expect(result).toBe(true);
  });
});
