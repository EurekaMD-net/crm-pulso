/**
 * Briefing Seeds
 *
 * Seeds cron-scheduled briefing tasks for each active persona.
 * Uses the engine's scheduled_tasks table directly (host process).
 * Idempotent — safe to call on every startup.
 */

import { CronExpressionParser } from 'cron-parser';
import { getDatabase as getCrmDatabase } from './db.js';
import { getDatabase as getEngineDatabase, createTask } from '../../engine/src/db.js';
import { TIMEZONE } from '../../engine/src/config.js';
import { logger } from './logger.js';

interface BriefingSeed {
  rol: string;
  cron: string;
  prompt: string;
}

const BRIEFING_SEEDS: BriefingSeed[] = [
  {
    rol: 'ae',
    cron: '10 9 * * 1-5',  // Staggered: base 9:10, offset by index
    prompt: 'Briefing matutino: revisa mi agenda de hoy, deals estancados >7 dias, acciones pendientes con fecha vencida, y mi porcentaje de cuota esta semana. Formato WhatsApp, conciso.',
  },
  {
    rol: 'ae',
    cron: '0 16 * * 5',
    prompt: 'Revision semanal: pipeline por etapa con valores, propuestas estancadas >14 dias, gap de descarga acumulado, y plan de accion para la siguiente semana. Formato WhatsApp.',
  },
  {
    rol: 'gerente',
    cron: '0 9 * * 1',  // Staggered: base 9:00, offset by index
    prompt: 'Resumen semanal de equipo: cuota por AE (logro vs meta), propuestas en riesgo (estancadas >14d o valor >5M), actividad por AE (ultima semana), gap descarga por cuenta, y top wins/losses. Formato WhatsApp.',
  },
  {
    rol: 'director',
    cron: '52 8 * * 1',
    prompt: 'Revision regional: pipeline total por equipo, ranking cuota por gerente, mega-deals activos, varianza descarga por region, alertas escaladas. Formato WhatsApp.',
  },
  {
    rol: 'vp',
    cron: '45 8 * * 1-5',
    prompt: 'Brief ejecutivo: agenda del dia, asuntos urgentes, estado mega-deals, alertas pendientes, y recomendacion de accion. Formato WhatsApp.',
  },
];

export { BRIEFING_SEEDS };

export function seedBriefings(): void {
  const crmDb = getCrmDatabase();     // persona (CRM tables in data/store/crm.db)
  const engineDb = getEngineDatabase(); // registered_groups, scheduled_tasks (store/messages.db)

  // Get all active personas with group folders
  const personas = crmDb.prepare(
    "SELECT id, rol, whatsapp_group_folder FROM persona WHERE activo = 1 AND whatsapp_group_folder IS NOT NULL",
  ).all() as { id: string; rol: string; whatsapp_group_folder: string }[];

  // Resolve group folders to JIDs
  const groups = engineDb.prepare(
    'SELECT jid, folder FROM registered_groups',
  ).all() as { jid: string; folder: string }[];

  const jidByFolder = new Map<string, string>();
  for (const g of groups) {
    jidByFolder.set(g.folder, g.jid);
  }

  // Check existing active tasks to avoid duplicates
  const existingTasks = engineDb.prepare(
    "SELECT group_folder, schedule_value FROM scheduled_tasks WHERE status = 'active' AND schedule_type = 'cron'",
  ).all() as { group_folder: string; schedule_value: string }[];

  const existingSet = new Set(
    existingTasks.map(t => `${t.group_folder}::${t.schedule_value}`),
  );

  let created = 0;

  for (const persona of personas) {
    const jid = jidByFolder.get(persona.whatsapp_group_folder);
    if (!jid) continue;

    const matchingSeeds = BRIEFING_SEEDS.filter(s => s.rol === persona.rol);

    for (const seed of matchingSeeds) {
      const key = `${persona.whatsapp_group_folder}::${seed.cron}`;
      if (existingSet.has(key)) continue;

      const taskId = `brief-${persona.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const nextRun = CronExpressionParser.parse(seed.cron, { tz: TIMEZONE })
        .next().toISOString();

      createTask({
        id: taskId,
        group_folder: persona.whatsapp_group_folder,
        chat_jid: jid,
        prompt: seed.prompt,
        schedule_type: 'cron',
        schedule_value: seed.cron,
        context_mode: 'group',
        next_run: nextRun,
        status: 'active',
        created_at: new Date().toISOString(),
      });

      existingSet.add(key);
      created++;
    }
  }

  if (created > 0) {
    logger.info({ count: created }, 'Briefing tasks seeded');
  }
}
