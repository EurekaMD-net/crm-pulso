/**
 * Briefing Seeds
 *
 * Seeds cron-scheduled briefing tasks for each active persona.
 * Uses the engine's scheduled_tasks table directly (host process).
 * Idempotent — safe to call on every startup.
 */

import { CronExpressionParser } from "cron-parser";
import { getDatabase as getCrmDatabase } from "./db.js";
import {
  getDatabase as getEngineDatabase,
  createTask,
} from "../../engine/src/db.js";
import { TIMEZONE } from "../../engine/src/config.js";
import { logger } from "./logger.js";

interface BriefingSeed {
  rol: string;
  cron: string;
  prompt: string;
}

const BRIEFING_SEEDS: BriefingSeed[] = [
  {
    rol: "ae",
    cron: "10 9 * * 1-5", // Staggered: base 9:10, offset by index
    prompt:
      "Briefing matutino: llama generar_briefing para obtener datos agregados. Con los resultados, presenta: 1) acciones pendientes de dias anteriores (carry-over), 2) cuentas sin contacto en >14 dias, 3) path-to-close (gap de cuota vs deals cerrables), 4) agenda del dia, 5) propuestas estancadas >7 dias. Formato WhatsApp, conciso.",
  },
  {
    rol: "ae",
    cron: "0 16 * * 5",
    prompt:
      "Revision semanal: llama generar_briefing para el contexto de path-to-close y cuentas sin contacto. Complementa con consultar_pipeline (por etapa con valores), propuestas estancadas >14 dias, gap de descarga acumulado, y plan de accion para la siguiente semana. Formato WhatsApp.",
  },
  {
    rol: "ae",
    cron: "30 18 * * 1-5",
    prompt:
      "Cierre del dia: usa consultar_resumen_dia para revisar mis actividades de hoy, propuestas que avanzaron o se estancaron, acciones pendientes vencidas, y mi avance de cuota. Sugiere 3 acciones prioritarias para manana. Si no hubo actividades hoy, preguntame como fue mi dia. Formato WhatsApp, conciso.",
  },
  {
    rol: "gerente",
    cron: "0 9 * * 1", // Staggered: base 9:00, offset by index
    prompt:
      "Resumen semanal de equipo: llama generar_briefing para datos agregados. Con los resultados, presenta: 1) sentimiento del equipo y Ejecutivos con tendencia negativa, 2) compliance de wrap-up (quien no registro actividades ayer), 3) path-to-close por Ejecutivo (gap vs cerrables), 4) propuestas estancadas del equipo. Complementa con gap descarga por cuenta y top wins/losses. Formato WhatsApp.",
  },
  {
    rol: "director",
    cron: "52 8 * * 1",
    prompt:
      "Revision regional: llama generar_briefing para datos agregados. Con los resultados, presenta: 1) sentimiento cross-equipo (comparar gerentes), 2) frecuencia de coaching de gerentes, 3) trayectoria de mega-deals con sentimiento, 4) pipeline por equipo, 5) ranking de cuota por gerente. Formato WhatsApp.",
  },
  {
    rol: "vp",
    cron: "45 8 * * 1-5",
    prompt:
      "Brief ejecutivo: llama generar_briefing para datos agregados. Con los resultados, presenta: 1) pulso de sentimiento organizacional, 2) equipos con >30% negativo (revenue at risk), 3) revenue en riesgo por sentimiento declinando, 4) mega-deals activos con sentimiento reciente. Complementa con consultar_agenda para tu agenda del dia. Incluye recomendacion de accion. Formato WhatsApp.",
  },
];

export { BRIEFING_SEEDS };

export function seedBriefings(): void {
  const crmDb = getCrmDatabase(); // persona (CRM tables in data/store/crm.db)
  const engineDb = getEngineDatabase(); // registered_groups, scheduled_tasks (store/messages.db)

  // Get all active personas with group folders
  const personas = crmDb
    .prepare(
      "SELECT id, rol, whatsapp_group_folder FROM persona WHERE activo = 1 AND whatsapp_group_folder IS NOT NULL",
    )
    .all() as { id: string; rol: string; whatsapp_group_folder: string }[];

  // Resolve group folders to JIDs
  const groups = engineDb
    .prepare("SELECT jid, folder FROM registered_groups")
    .all() as { jid: string; folder: string }[];

  const jidByFolder = new Map<string, string>();
  for (const g of groups) {
    jidByFolder.set(g.folder, g.jid);
  }

  // Check existing active tasks to avoid duplicates
  const existingTasks = engineDb
    .prepare(
      "SELECT group_folder, schedule_value FROM scheduled_tasks WHERE status = 'active' AND schedule_type = 'cron'",
    )
    .all() as { group_folder: string; schedule_value: string }[];

  const existingSet = new Set(
    existingTasks.map((t) => `${t.group_folder}::${t.schedule_value}`),
  );

  let created = 0;

  for (const persona of personas) {
    const jid = jidByFolder.get(persona.whatsapp_group_folder);
    if (!jid) continue;

    const matchingSeeds = BRIEFING_SEEDS.filter((s) => s.rol === persona.rol);

    for (const seed of matchingSeeds) {
      const key = `${persona.whatsapp_group_folder}::${seed.cron}`;
      if (existingSet.has(key)) continue;

      const taskId = `brief-${persona.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const nextRun = CronExpressionParser.parse(seed.cron, { tz: TIMEZONE })
        .next()
        .toISOString();

      createTask({
        id: taskId,
        group_folder: persona.whatsapp_group_folder,
        chat_jid: jid,
        prompt: seed.prompt,
        schedule_type: "cron",
        schedule_value: seed.cron,
        context_mode: "group",
        next_run: nextRun,
        status: "active",
        created_at: new Date().toISOString(),
      });

      existingSet.add(key);
      created++;
    }
  }

  if (created > 0) {
    logger.info({ count: created }, "Briefing tasks seeded");
  }
}
