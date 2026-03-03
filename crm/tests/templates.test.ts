/**
 * Template Validation Tests
 *
 * Validates that persona templates in crm/groups/ are consistent
 * with the CRM schema (tables, tools, enums) defined in code.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { describe, it, expect, vi } from 'vitest';
import { CRM_TABLES } from '../src/schema.js';

// Mock engine modules to avoid pino dependency
let testDb: InstanceType<typeof Database>;
vi.mock('../../engine/src/db.js', () => ({
  getDatabase: () => testDb,
}));

// Dynamic import after mock
const { getToolsForRole } = await import('../src/tools/index.js');

const GROUPS_DIR = path.resolve(__dirname, '../groups');

function readTemplate(name: string): string {
  return fs.readFileSync(path.join(GROUPS_DIR, name), 'utf-8');
}

const globalMd = readTemplate('global.md');
const aeMd = readTemplate('ae.md');
const managerMd = readTemplate('manager.md');
const directorMd = readTemplate('director.md');
const vpMd = readTemplate('vp.md');
const teamMgrMd = readTemplate('team-mgr.md');
const teamDirMd = readTemplate('team-dir.md');
const teamVpMd = readTemplate('team-vp.md');

const allTemplates = [globalMd, aeMd, managerMd, directorMd, vpMd, teamMgrMd, teamDirMd, teamVpMd];
const allTemplateNames = ['global.md', 'ae.md', 'manager.md', 'director.md', 'vp.md', 'team-mgr.md', 'team-dir.md', 'team-vp.md'];

// ---------------------------------------------------------------------------
// global.md -- Schema coverage
// ---------------------------------------------------------------------------

describe('global.md -- schema coverage', () => {
  it('references all 12 CRM table names', () => {
    for (const table of CRM_TABLES) {
      expect(globalMd, `Missing table: ${table}`).toContain(table);
    }
  });

  it('contains all pipeline stages', () => {
    const stages = [
      'en_preparacion', 'enviada', 'en_discusion', 'en_negociacion',
      'confirmada_verbal', 'orden_recibida', 'en_ejecucion',
      'completada', 'perdida', 'cancelada',
    ];
    for (const stage of stages) {
      expect(globalMd, `Missing pipeline stage: ${stage}`).toContain(stage);
    }
  });

  it('contains all activity types', () => {
    const types = ['llamada', 'whatsapp', 'comida', 'email', 'reunion', 'visita', 'envio_propuesta', 'otro'];
    for (const t of types) {
      expect(globalMd, `Missing activity type: ${t}`).toContain(t);
    }
  });

  it('contains all sentimiento values', () => {
    const sentimientos = ['positivo', 'neutral', 'negativo', 'urgente'];
    for (const s of sentimientos) {
      expect(globalMd, `Missing sentimiento: ${s}`).toContain(s);
    }
  });

  it('contains all contact roles', () => {
    const roles = ['comprador', 'planeador', 'decisor', 'operativo'];
    for (const r of roles) {
      expect(globalMd, `Missing contact role: ${r}`).toContain(r);
    }
  });

  it('contains all opportunity types', () => {
    const types = ['estacional', 'lanzamiento', 'reforzamiento', 'evento_especial', 'tentpole', 'prospeccion'];
    for (const t of types) {
      expect(globalMd, `Missing opportunity type: ${t}`).toContain(t);
    }
  });

  it('contains all media types', () => {
    const medios = ['tv_abierta', 'ctv', 'radio', 'digital'];
    for (const m of medios) {
      expect(globalMd, `Missing medio: ${m}`).toContain(m);
    }
  });

  it('contains all contract statuses', () => {
    const statuses = ['negociando', 'firmado', 'en_ejecucion', 'cerrado'];
    for (const s of statuses) {
      expect(globalMd, `Missing contract status: ${s}`).toContain(s);
    }
  });

  it('contains all calendar event types', () => {
    const types = ['seguimiento', 'reunion', 'tentpole', 'deadline', 'briefing'];
    for (const t of types) {
      expect(globalMd, `Missing calendar type: ${t}`).toContain(t);
    }
  });

  it('contains all email types', () => {
    const types = ['seguimiento', 'briefing', 'alerta', 'propuesta'];
    for (const t of types) {
      expect(globalMd, `Missing email type: ${t}`).toContain(t);
    }
  });
});

// ---------------------------------------------------------------------------
// global.md -- Tool coverage
// ---------------------------------------------------------------------------

describe('global.md -- tool coverage', () => {
  // Collect all unique tool names across all roles
  const allToolNames = new Set<string>();
  for (const role of ['ae', 'gerente', 'director', 'vp'] as const) {
    for (const tool of getToolsForRole(role)) {
      allToolNames.add(tool.function.name);
    }
  }

  it('references all 17 tool names', () => {
    expect(allToolNames.size).toBe(17);
    for (const name of allToolNames) {
      expect(globalMd, `Missing tool: ${name}`).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// Role templates -- correct tool references
// ---------------------------------------------------------------------------

describe('ae.md -- tool references', () => {
  const aeTools = getToolsForRole('ae').map(t => t.function.name);

  it('references all 16 AE tools', () => {
    for (const name of aeTools) {
      expect(aeMd, `Missing AE tool: ${name}`).toContain(name);
    }
  });

  it('does not reference gerente-only tools', () => {
    expect(aeMd).not.toContain('enviar_email_briefing');
  });
});

describe('manager.md -- tool references', () => {
  const gerenteTools = getToolsForRole('gerente').map(t => t.function.name);

  it('references all 9 gerente tools', () => {
    for (const name of gerenteTools) {
      expect(managerMd, `Missing gerente tool: ${name}`).toContain(name);
    }
  });

  it('does not reference AE-only write tools', () => {
    const aeOnlyTools = ['registrar_actividad', 'crear_propuesta', 'actualizar_propuesta',
      'cerrar_propuesta', 'actualizar_descarga', 'establecer_recordatorio',
      'enviar_email_seguimiento', 'confirmar_envio_email'];
    for (const name of aeOnlyTools) {
      expect(managerMd, `Should not contain AE tool: ${name}`).not.toContain(name);
    }
  });
});

describe('director.md -- tool references', () => {
  const directorTools = getToolsForRole('director').map(t => t.function.name);

  it('references all 8 director tools', () => {
    for (const name of directorTools) {
      expect(directorMd, `Missing director tool: ${name}`).toContain(name);
    }
  });

  it('does not reference briefing tool', () => {
    expect(directorMd).not.toContain('enviar_email_briefing');
  });
});

describe('vp.md -- tool references', () => {
  const vpTools = getToolsForRole('vp').map(t => t.function.name);

  it('references all 7 VP tools', () => {
    for (const name of vpTools) {
      expect(vpMd, `Missing VP tool: ${name}`).toContain(name);
    }
  });

  it('does not reference write tools', () => {
    expect(vpMd).not.toContain('crear_evento_calendario');
    expect(vpMd).not.toContain('enviar_email_briefing');
  });
});

// ---------------------------------------------------------------------------
// No OLD schema/tool references
// ---------------------------------------------------------------------------

describe('no OLD English schema references', () => {
  const oldNames = [
    'crm_people', 'crm_accounts', 'crm_contacts', 'crm_opportunities',
    'crm_interactions', 'crm_quotas', 'crm_events', 'crm_media_types',
    'crm_proposals', 'crm_tasks_crm',
  ];

  for (let i = 0; i < allTemplates.length; i++) {
    it(`${allTemplateNames[i]} has no old schema names`, () => {
      for (const old of oldNames) {
        expect(allTemplates[i], `Found old name "${old}" in ${allTemplateNames[i]}`).not.toContain(old);
      }
    });
  }
});

describe('no OLD English tool references', () => {
  const oldTools = [
    'log_interaction', 'update_opportunity', 'create_crm_task', 'update_crm_task',
  ];

  for (let i = 0; i < allTemplates.length; i++) {
    it(`${allTemplateNames[i]} has no old tool names`, () => {
      for (const old of oldTools) {
        expect(allTemplates[i], `Found old tool "${old}" in ${allTemplateNames[i]}`).not.toContain(old);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// WhatsApp formatting
// ---------------------------------------------------------------------------

describe('WhatsApp formatting rules', () => {
  it('global.md mentions WhatsApp formatting', () => {
    expect(globalMd).toContain('WhatsApp');
  });

  it('global.md prohibits markdown headers', () => {
    expect(globalMd).toMatch(/NO.*markdown|no.*markdown/i);
  });

  it('global.md specifies bold formatting with asterisks', () => {
    expect(globalMd).toContain('*negritas*');
  });
});

// ---------------------------------------------------------------------------
// Business concepts in global.md
// ---------------------------------------------------------------------------

describe('global.md -- business concepts', () => {
  it('explains descarga concept', () => {
    expect(globalMd.toLowerCase()).toContain('descarga');
    expect(globalMd).toContain('gap');
  });

  it('explains cuota semanal', () => {
    expect(globalMd.toLowerCase()).toContain('cuota');
  });

  it('explains mega-deal threshold', () => {
    expect(globalMd).toContain('15M');
  });

  it('explains dias_sin_actividad', () => {
    expect(globalMd).toContain('dias_sin_actividad');
  });

  it('explains es_fundador priority', () => {
    expect(globalMd).toContain('es_fundador');
  });

  it('references generated columns', () => {
    expect(globalMd).toContain('generado');
    expect(globalMd).toContain('es_mega');
    expect(globalMd).toContain('porcentaje');
  });
});

// ---------------------------------------------------------------------------
// Team templates -- privacy rules
// ---------------------------------------------------------------------------

describe('team templates -- privacy rules', () => {
  it('team-mgr.md has privacy rules', () => {
    expect(teamMgrMd.toLowerCase()).toContain('nunca');
    expect(teamMgrMd.toLowerCase()).toMatch(/individual|privado/);
  });

  it('team-dir.md has privacy rules', () => {
    expect(teamDirMd.toLowerCase()).toContain('nunca');
    expect(teamDirMd.toLowerCase()).toMatch(/individual|privado/);
  });

  it('team-vp.md has privacy rules', () => {
    expect(teamVpMd.toLowerCase()).toMatch(/individual|privado/);
  });

  it('team templates mention @mentions', () => {
    expect(teamMgrMd).toContain('@');
    expect(teamDirMd).toContain('@');
    expect(teamVpMd).toContain('@');
  });
});

// ---------------------------------------------------------------------------
// All 8 template files exist
// ---------------------------------------------------------------------------

describe('all template files exist', () => {
  for (const name of allTemplateNames) {
    it(`${name} exists and is non-empty`, () => {
      const content = readTemplate(name);
      expect(content.length).toBeGreaterThan(50);
    });
  }
});
