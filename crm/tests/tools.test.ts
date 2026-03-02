/**
 * CRM Tool Tests
 *
 * Tests tool registry, registration tools, query tools, email, calendar.
 * Uses in-memory SQLite with mocked getDatabase().
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrmSchema } from '../src/schema.js';

let testDb: InstanceType<typeof Database>;

vi.mock('../../engine/src/db.js', () => ({
  getDatabase: () => testDb,
}));

const {
  getToolsForRole, executeTool, buildToolContext,
} = await import('../src/tools/index.js');

const { _resetStatementCache } = await import('../src/hierarchy.js');

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setupDb() {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  createCrmSchema(testDb);
  _resetStatementCache();

  // Org chart
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('vp1', 'Roberto', 'vp', null, 'vp1', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ger1', 'Miguel', 'gerente', 'vp1', 'ger1', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ae1', 'María', 'ae', 'ger1', 'ae1', 1)`).run();
  testDb.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, activo) VALUES ('ae2', 'Carlos', 'ae', 'ger1', 'ae2', 1)`).run();

  // Accounts
  testDb.prepare(`INSERT INTO cuenta (id, nombre, tipo, ae_id) VALUES ('c1', 'Coca-Cola', 'directo', 'ae1')`).run();
  testDb.prepare(`INSERT INTO cuenta (id, nombre, tipo, ae_id) VALUES ('c2', 'Bimbo', 'directo', 'ae2')`).run();

  // Contacts
  testDb.prepare(`INSERT INTO contacto (id, nombre, cuenta_id, rol, email) VALUES ('con1', 'Dir Marketing', 'c1', 'decisor', 'mktg@cocacola.com')`).run();

  // Propuestas
  testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES ('p1', 'c1', 'ae1', 'Campaña Verano', 5000000, 'enviada', 10)`).run();
  testDb.prepare(`INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, etapa, dias_sin_actividad) VALUES ('p2', 'c2', 'ae2', 'Campaña Navidad', 8000000, 'en_negociacion', 3)`).run();

  // Inventario
  testDb.prepare(`INSERT INTO inventario (id, medio, propiedad, formato, precio_referencia, precio_piso) VALUES ('inv1', 'tv_abierta', 'Canal Uno', 'spot_30s', 85000, 60000)`).run();

  // Cuota
  const week = Math.ceil(((Date.now() - new Date(2026, 0, 1).getTime()) / 86400000 + 1) / 7);
  testDb.prepare(`INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total, logro) VALUES ('q1', 'ae1', 'ae', 2026, ?, 1000000, 750000)`).run(week);
}

beforeEach(setupDb);

// ---------------------------------------------------------------------------
// Tool Registry
// ---------------------------------------------------------------------------

describe('getToolsForRole', () => {
  it('returns more tools for AE than gerente', () => {
    const aeTools = getToolsForRole('ae');
    const gerTools = getToolsForRole('gerente');
    expect(aeTools.length).toBeGreaterThan(gerTools.length);
  });

  it('AE has registrar_actividad', () => {
    const tools = getToolsForRole('ae');
    const names = tools.map(t => t.function.name);
    expect(names).toContain('registrar_actividad');
    expect(names).toContain('crear_propuesta');
    expect(names).toContain('enviar_email_seguimiento');
  });

  it('gerente has consultar tools and briefing email', () => {
    const tools = getToolsForRole('gerente');
    const names = tools.map(t => t.function.name);
    expect(names).toContain('consultar_pipeline');
    expect(names).toContain('enviar_email_briefing');
    expect(names).not.toContain('registrar_actividad');
  });

  it('VP has consultar tools only', () => {
    const tools = getToolsForRole('vp');
    const names = tools.map(t => t.function.name);
    expect(names).toContain('consultar_pipeline');
    expect(names).not.toContain('registrar_actividad');
    expect(names).not.toContain('enviar_email_briefing');
  });
});

describe('buildToolContext', () => {
  it('builds context for AE', () => {
    const ctx = buildToolContext('ae1');
    expect(ctx).not.toBeNull();
    expect(ctx!.rol).toBe('ae');
    expect(ctx!.team_ids).toEqual([]);
  });

  it('builds context for gerente with team', () => {
    const ctx = buildToolContext('ger1');
    expect(ctx).not.toBeNull();
    expect(ctx!.rol).toBe('gerente');
    expect(ctx!.team_ids.sort()).toEqual(['ae1', 'ae2']);
  });

  it('returns null for unknown persona', () => {
    expect(buildToolContext('ghost')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Registration Tools
// ---------------------------------------------------------------------------

describe('registrar_actividad', () => {
  it('registers an activity for a known account', () => {
    const ctx = buildToolContext('ae1')!;
    const result = JSON.parse(executeTool('registrar_actividad', {
      cuenta_nombre: 'Coca-Cola',
      tipo: 'llamada',
      resumen: 'Llamé al cliente sobre la campaña',
      sentimiento: 'positivo',
    }, ctx));

    expect(result.ok).toBe(true);
    expect(result.id).toBeTruthy();

    const row = testDb.prepare('SELECT * FROM actividad WHERE id = ?').get(result.id) as any;
    expect(row.ae_id).toBe('ae1');
    expect(row.resumen).toContain('campaña');
  });

  it('returns error for unknown account', () => {
    const ctx = buildToolContext('ae1')!;
    const result = JSON.parse(executeTool('registrar_actividad', {
      cuenta_nombre: 'NoExiste',
      tipo: 'llamada',
      resumen: 'Test',
    }, ctx));

    expect(result.error).toContain('No encontré');
  });

  it('updates propuesta timestamp when linked', () => {
    const ctx = buildToolContext('ae1')!;
    executeTool('registrar_actividad', {
      cuenta_nombre: 'Coca',
      tipo: 'reunion',
      resumen: 'Revisión propuesta',
      propuesta_titulo: 'Verano',
    }, ctx);

    const prop = testDb.prepare('SELECT dias_sin_actividad FROM propuesta WHERE id = ?').get('p1') as any;
    expect(prop.dias_sin_actividad).toBe(0);
  });
});

describe('crear_propuesta', () => {
  it('creates a new propuesta', () => {
    const ctx = buildToolContext('ae1')!;
    const result = JSON.parse(executeTool('crear_propuesta', {
      cuenta_nombre: 'Coca-Cola',
      titulo: 'Campaña Navidad 2026',
      valor_estimado: 12000000,
      tipo_oportunidad: 'tentpole',
    }, ctx));

    expect(result.ok).toBe(true);
    const row = testDb.prepare("SELECT * FROM propuesta WHERE titulo = 'Campaña Navidad 2026'").get() as any;
    expect(row).toBeDefined();
    expect(row.etapa).toBe('en_preparacion');
    expect(row.valor_estimado).toBe(12000000);
  });
});

describe('actualizar_propuesta', () => {
  it('updates stage with access', () => {
    const ctx = buildToolContext('ae1')!;
    const result = JSON.parse(executeTool('actualizar_propuesta', {
      propuesta_titulo: 'Verano',
      etapa: 'en_discusion',
    }, ctx));

    expect(result.ok).toBe(true);
    const row = testDb.prepare('SELECT etapa FROM propuesta WHERE id = ?').get('p1') as any;
    expect(row.etapa).toBe('en_discusion');
  });

  it('blocks cross-AE update', () => {
    const ctx = buildToolContext('ae2')!;
    const result = JSON.parse(executeTool('actualizar_propuesta', {
      propuesta_titulo: 'Verano',
      etapa: 'completada',
    }, ctx));

    expect(result.error).toContain('No tienes acceso');
  });

  it('allows gerente to update team propuesta', () => {
    const ctx = buildToolContext('ger1')!;
    const result = JSON.parse(executeTool('actualizar_propuesta', {
      propuesta_titulo: 'Verano',
      etapa: 'en_negociacion',
    }, ctx));

    expect(result.ok).toBe(true);
  });

  it('requires razon for perdida', () => {
    const ctx = buildToolContext('ae1')!;
    const result = JSON.parse(executeTool('actualizar_propuesta', {
      propuesta_titulo: 'Verano',
      etapa: 'perdida',
    }, ctx));

    expect(result.error).toContain('razon_perdida');
  });
});

describe('cerrar_propuesta', () => {
  it('closes a propuesta as completada', () => {
    const ctx = buildToolContext('ae1')!;
    const result = JSON.parse(executeTool('cerrar_propuesta', {
      propuesta_titulo: 'Verano',
      resultado: 'completada',
    }, ctx));

    expect(result.ok).toBe(true);
    const row = testDb.prepare('SELECT etapa FROM propuesta WHERE id = ?').get('p1') as any;
    expect(row.etapa).toBe('completada');
  });
});

// ---------------------------------------------------------------------------
// Query Tools
// ---------------------------------------------------------------------------

describe('consultar_pipeline', () => {
  it('returns propuestas scoped to AE', () => {
    const ctx = buildToolContext('ae1')!;
    const result = JSON.parse(executeTool('consultar_pipeline', {}, ctx));

    expect(result.propuestas.length).toBe(1);
    expect(result.propuestas[0].titulo).toBe('Campaña Verano');
  });

  it('returns all propuestas for VP', () => {
    const ctx = buildToolContext('vp1')!;
    const result = JSON.parse(executeTool('consultar_pipeline', {}, ctx));

    expect(result.propuestas.length).toBe(2);
  });

  it('filters by etapa', () => {
    const ctx = buildToolContext('vp1')!;
    const result = JSON.parse(executeTool('consultar_pipeline', { etapa: 'enviada' }, ctx));

    expect(result.propuestas.length).toBe(1);
    expect(result.propuestas[0].etapa).toBe('enviada');
  });

  it('filters stalled propuestas', () => {
    const ctx = buildToolContext('vp1')!;
    const result = JSON.parse(executeTool('consultar_pipeline', { solo_estancadas: true }, ctx));

    expect(result.propuestas.every((p: any) => p.dias_sin_actividad >= 7)).toBe(true);
  });
});

describe('consultar_cuenta', () => {
  it('returns full account detail', () => {
    const ctx = buildToolContext('ae1')!;
    const result = JSON.parse(executeTool('consultar_cuenta', { cuenta_nombre: 'Coca-Cola' }, ctx));

    expect(result.cuenta.nombre).toBe('Coca-Cola');
    expect(result.contactos.length).toBe(1);
    expect(result.propuestas_activas.length).toBe(1);
  });

  it('returns error for unknown account', () => {
    const ctx = buildToolContext('ae1')!;
    const result = JSON.parse(executeTool('consultar_cuenta', { cuenta_nombre: 'NoExiste' }, ctx));

    expect(result.error).toContain('No encontré');
  });
});

describe('consultar_inventario', () => {
  it('returns all inventory', () => {
    const ctx = buildToolContext('ae1')!;
    const result = JSON.parse(executeTool('consultar_inventario', {}, ctx));

    expect(result.productos.length).toBe(1);
    expect(result.productos[0].precio_referencia).toBe(85000);
  });

  it('filters by medio', () => {
    const ctx = buildToolContext('ae1')!;
    const result = JSON.parse(executeTool('consultar_inventario', { medio: 'radio' }, ctx));

    expect(result.mensaje).toContain('No hay');
  });
});

// ---------------------------------------------------------------------------
// Email Tools
// ---------------------------------------------------------------------------

describe('enviar_email_seguimiento', () => {
  it('creates a draft email', () => {
    const ctx = buildToolContext('ae1')!;
    const result = JSON.parse(executeTool('enviar_email_seguimiento', {
      contacto_id: 'con1',
      asunto: 'Seguimiento propuesta',
      cuerpo: 'Estimado, le envío seguimiento...',
    }, ctx));

    expect(result.ok).toBe(true);
    expect(result.email_id).toBeTruthy();
    expect(result.preview.para).toContain('mktg@cocacola.com');

    const email = testDb.prepare('SELECT * FROM email_log WHERE id = ?').get(result.email_id) as any;
    expect(email.enviado).toBe(0);
    expect(email.tipo).toBe('seguimiento');
  });

  it('returns error for unknown contact', () => {
    const ctx = buildToolContext('ae1')!;
    const result = JSON.parse(executeTool('enviar_email_seguimiento', {
      contacto_id: 'ghost',
      asunto: 'Test',
      cuerpo: 'Test',
    }, ctx));

    expect(result.error).toContain('No encontré');
  });
});

describe('confirmar_envio_email', () => {
  it('marks email as sent (MVP mode: saves as draft)', () => {
    const ctx = buildToolContext('ae1')!;

    // Create draft first
    const draft = JSON.parse(executeTool('enviar_email_seguimiento', {
      contacto_id: 'con1',
      asunto: 'Test',
      cuerpo: 'Test body',
    }, ctx));

    // Confirm it
    const result = JSON.parse(executeTool('confirmar_envio_email', {
      email_id: draft.email_id,
    }, ctx));

    expect(result.ok).toBe(true);
    expect(result.mensaje).toContain('borrador'); // MVP mode
  });
});

// ---------------------------------------------------------------------------
// Calendar Tools
// ---------------------------------------------------------------------------

describe('crear_evento_calendario', () => {
  it('creates a local calendar event', () => {
    const ctx = buildToolContext('ae1')!;
    const result = JSON.parse(executeTool('crear_evento_calendario', {
      titulo: 'Seguimiento P&G',
      fecha_inicio: '2026-03-10T10:00:00Z',
      tipo: 'seguimiento',
      duracion_minutos: 30,
    }, ctx));

    expect(result.ok).toBe(true);
    expect(result.id).toBeTruthy();

    const event = testDb.prepare('SELECT * FROM evento_calendario WHERE id = ?').get(result.id) as any;
    expect(event.titulo).toBe('Seguimiento P&G');
    expect(event.creado_por).toBe('agente');
  });
});

describe('consultar_agenda', () => {
  it('returns events for today', () => {
    const ctx = buildToolContext('ae1')!;

    // Insert an event for today
    const todayStr = new Date().toISOString();
    testDb.prepare(`INSERT INTO evento_calendario (id, persona_id, titulo, fecha_inicio, fecha_fin, tipo) VALUES ('ev-today', 'ae1', 'Reunión Test', ?, ?, 'reunion')`).run(todayStr, todayStr);

    const result = JSON.parse(executeTool('consultar_agenda', { rango: 'hoy' }, ctx));
    expect(result.eventos.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Unknown tool
// ---------------------------------------------------------------------------

describe('executeTool', () => {
  it('returns error for unknown tool', () => {
    const ctx = buildToolContext('ae1')!;
    const result = JSON.parse(executeTool('no_existe', {}, ctx));
    expect(result.error).toContain('desconocida');
  });
});
