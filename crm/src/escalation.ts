/**
 * Real-Time Escalation Evaluators
 *
 * Four escalation functions triggered on activity insertion. Each checks
 * a specific condition and sends an alert to the appropriate manager level.
 * Deduplication via alerta_log prevents duplicate alerts within the same day.
 *
 * Entry point: evaluateEscalation(aeId, deps) — calls all 4, deduplicates.
 */

import { getDatabase } from "./db.js";
import { getPersonById, getTeamIds, getFullTeamIds } from "./hierarchy.js";
import { logger } from "./logger.js";
import type { IpcDeps } from "../../engine/src/ipc.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentWeek(): { year: number; week: number } {
  const now = new Date();
  const year = now.getFullYear();
  const dayOfYear = Math.floor(
    (now.getTime() - new Date(year, 0, 1).getTime()) / 86400000,
  );
  const week = Math.max(1, Math.ceil((dayOfYear + 1) / 7));
  return { year, week };
}

function mondayOfCurrentWeek(): string {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(now.getTime() - diff * 86400000);
  return monday.toISOString().slice(0, 10);
}

/** Check if an alert of this type+entity was already sent today. */
function isDuplicate(alertType: string, entityId: string): boolean {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT 1 FROM alerta_log WHERE alerta_tipo = ? AND entidad_id = ? AND fecha_envio_date = ?`,
    )
    .get(alertType, entityId, today());
  return row !== undefined;
}

/** Record the alert in alerta_log for dedup. */
function recordAlert(
  alertType: string,
  entityId: string,
  grupoDestino: string,
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO alerta_log (id, alerta_tipo, entidad_id, grupo_destino, fecha_envio)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(genId("esc"), alertType, entityId, grupoDestino);
}

/** Find the JID for a persona's whatsapp_group_folder from registered groups. */
function findJid(folder: string, deps: IpcDeps): string | undefined {
  const groups = deps.registeredGroups();
  return Object.keys(groups).find((k) => groups[k].folder === folder);
}

// ---------------------------------------------------------------------------
// 1. Quota Emergency: cuota < 50% for current week
// ---------------------------------------------------------------------------

export async function escalateQuotaEmergency(
  aeId: string,
  deps: IpcDeps,
): Promise<void> {
  const db = getDatabase();
  const { year, week } = currentWeek();

  const row = db
    .prepare(
      `SELECT porcentaje FROM cuota WHERE persona_id = ? AND año = ? AND semana = ?`,
    )
    .get(aeId, year, week) as { porcentaje: number } | undefined;

  if (!row || row.porcentaje >= 50) return;

  const person = getPersonById(aeId);
  if (!person?.reporta_a) return;
  const manager = getPersonById(person.reporta_a);
  if (!manager?.whatsapp_group_folder) return;

  const alertType = "escalation_quota";
  const entityId = `${aeId}-${year}-w${week}`;
  if (isDuplicate(alertType, entityId)) return;

  const jid = findJid(manager.whatsapp_group_folder, deps);
  if (!jid) return;

  const msg =
    `*\u26a0\ufe0f Alerta: Cuota Critica*\n\n` +
    `\u2022 Ejecutivo: ${person.nombre}\n` +
    `\u2022 Cuota actual: ${Math.round(row.porcentaje)}%\n` +
    `\u2022 Meta: alcanzar 80% antes del viernes\n\n` +
    `_Recomendacion: programa 1:1 urgente_`;

  await deps.sendMessage(jid, msg);
  recordAlert(alertType, entityId, manager.whatsapp_group_folder);
  logger.info(
    { aeId, pct: row.porcentaje },
    "Escalation: quota emergency sent",
  );
}

// ---------------------------------------------------------------------------
// 2. Coaching Signal: 3+ negative sentiments this week
// ---------------------------------------------------------------------------

export async function escalateCoachingSignal(
  aeId: string,
  deps: IpcDeps,
): Promise<void> {
  const db = getDatabase();
  const monday = mondayOfCurrentWeek();

  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM actividad WHERE ae_id = ? AND sentimiento IN ('negativo', 'urgente') AND fecha >= ?`,
    )
    .get(aeId, monday) as { c: number };

  if (row.c < 3) return;

  const person = getPersonById(aeId);
  if (!person?.reporta_a) return;
  const manager = getPersonById(person.reporta_a);
  if (!manager?.whatsapp_group_folder) return;

  const alertType = "escalation_coaching";
  const entityId = `${aeId}-coaching-${today()}`;
  if (isDuplicate(alertType, entityId)) return;

  const jid = findJid(manager.whatsapp_group_folder, deps);
  if (!jid) return;

  const msg =
    `*\u26a0\ufe0f Alerta: Senal de Coaching*\n\n` +
    `\u2022 Ejecutivo: ${person.nombre}\n` +
    `\u2022 Sentimientos negativos esta semana: ${row.c}\n` +
    `\u2022 Patron detectado: posible desmotivacion o cuentas dificiles\n\n` +
    `_Recomendacion: agenda coaching 1:1 esta semana_`;

  await deps.sendMessage(jid, msg);
  recordAlert(alertType, entityId, manager.whatsapp_group_folder);
  logger.info({ aeId, negCount: row.c }, "Escalation: coaching signal sent");
}

// ---------------------------------------------------------------------------
// 3. Pattern Detection: entire team <70% cuota
// ---------------------------------------------------------------------------

export async function escalatePatternDetection(
  gerenteId: string,
  deps: IpcDeps,
): Promise<void> {
  const db = getDatabase();
  const { year, week } = currentWeek();
  const teamIds = getTeamIds(gerenteId);

  if (teamIds.length === 0) return;

  // Check if ALL team members have cuota < 70%
  for (const aeId of teamIds) {
    const row = db
      .prepare(
        `SELECT porcentaje FROM cuota WHERE persona_id = ? AND año = ? AND semana = ?`,
      )
      .get(aeId, year, week) as { porcentaje: number } | undefined;
    // If no cuota record or >= 70%, condition not met
    if (!row || row.porcentaje >= 70) return;
  }

  const gerente = getPersonById(gerenteId);
  if (!gerente?.reporta_a) return;
  const director = getPersonById(gerente.reporta_a);
  if (!director?.whatsapp_group_folder) return;

  const alertType = "escalation_pattern";
  const entityId = `${gerenteId}-pattern-${year}-w${week}`;
  if (isDuplicate(alertType, entityId)) return;

  const jid = findJid(director.whatsapp_group_folder, deps);
  if (!jid) return;

  const msg =
    `*\u26a0\ufe0f Alerta: Patron de Equipo*\n\n` +
    `\u2022 Gerente: ${gerente.nombre}\n` +
    `\u2022 Equipo completo por debajo del 70% de cuota (S${week})\n` +
    `\u2022 Ejecutivos afectados: ${teamIds.length}\n\n` +
    `_Recomendacion: revisar estrategia del equipo con el gerente_`;

  await deps.sendMessage(jid, msg);
  recordAlert(alertType, entityId, director.whatsapp_group_folder);
  logger.info(
    { gerenteId, teamSize: teamIds.length },
    "Escalation: pattern detection sent",
  );
}

// ---------------------------------------------------------------------------
// 4. Systemic Risk: 3+ stalled mega-deals in region
// ---------------------------------------------------------------------------

export async function escalateSystemicRisk(
  directorId: string,
  deps: IpcDeps,
): Promise<void> {
  const db = getDatabase();
  const fullTeamIds = getFullTeamIds(directorId);

  if (fullTeamIds.length === 0) return;

  const placeholders = fullTeamIds.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM propuesta WHERE ae_id IN (${placeholders}) AND es_mega = 1 AND dias_sin_actividad > 14`,
    )
    .get(...fullTeamIds) as { c: number };

  if (row.c < 3) return;

  const director = getPersonById(directorId);
  if (!director?.reporta_a) return;
  const vp = getPersonById(director.reporta_a);
  if (!vp?.whatsapp_group_folder) return;

  const alertType = "escalation_systemic";
  const entityId = `${directorId}-systemic-${today()}`;
  if (isDuplicate(alertType, entityId)) return;

  const jid = findJid(vp.whatsapp_group_folder, deps);
  if (!jid) return;

  const msg =
    `*\u26a0\ufe0f Alerta: Riesgo Sistemico*\n\n` +
    `\u2022 Director: ${director.nombre}\n` +
    `\u2022 Mega-deals estancados (>14 dias): ${row.c}\n` +
    `\u2022 Impacto potencial: alto valor en riesgo\n\n` +
    `_Recomendacion: intervencion directa en deals prioritarios_`;

  await deps.sendMessage(jid, msg);
  recordAlert(alertType, entityId, vp.whatsapp_group_folder);
  logger.info(
    { directorId, stalledCount: row.c },
    "Escalation: systemic risk sent",
  );
}

// ---------------------------------------------------------------------------
// Entry Point: evaluate all escalation conditions for an AE
// ---------------------------------------------------------------------------

export async function evaluateEscalation(
  aeId: string,
  deps: IpcDeps,
): Promise<void> {
  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      logger.error(
        { aeId, escalation: name, err },
        "Escalation failed, continuing",
      );
    }
  };

  // 1 & 2: AE-level checks
  await run("quota", () => escalateQuotaEmergency(aeId, deps));
  await run("coaching", () => escalateCoachingSignal(aeId, deps));

  // 3: Team-level check (gerente)
  const person = getPersonById(aeId);
  if (person?.reporta_a) {
    await run("pattern", () =>
      escalatePatternDetection(person.reporta_a!, deps),
    );

    // 4: Region-level check (director)
    const gerente = getPersonById(person.reporta_a);
    if (gerente?.reporta_a) {
      await run("systemic", () =>
        escalateSystemicRisk(gerente.reporta_a!, deps),
      );
    }
  }
}
