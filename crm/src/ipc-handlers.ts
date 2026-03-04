/**
 * CRM IPC Handlers
 *
 * Handles CRM-specific IPC task types delegated from engine/src/ipc.ts.
 * The engine calls processCrmIpc() for any IPC type it doesn't recognize.
 *
 * Tables referenced: actividad, propuesta, cuenta, persona
 */

import { getDatabase } from './db.js';
import { getPersonByGroupFolder, hasAccessTo } from './hierarchy.js';
import { evaluateAlerts, logAlerts } from './alerts.js';
import { logger } from './logger.js';
import type { IpcDeps } from '../../engine/src/ipc.js';

// --- Input validation helpers ---

const VALID_ACTIVIDAD_TIPOS = new Set([
  'llamada', 'whatsapp', 'comida', 'email', 'reunion', 'visita', 'envio_propuesta', 'otro',
]);
const VALID_SENTIMIENTOS = new Set(['positivo', 'neutral', 'negativo', 'urgente']);
const VALID_ETAPAS = new Set([
  'en_preparacion', 'enviada', 'en_discusion', 'en_negociacion',
  'confirmada_verbal', 'orden_recibida', 'en_ejecucion',
  'completada', 'perdida', 'cancelada',
]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/;

function validateEnum(value: unknown, allowed: Set<string>, fallback: string): string {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function validateDate(value: unknown): string | null {
  return typeof value === 'string' && ISO_DATE_RE.test(value) ? value : null;
}

function validateNumber(value: unknown, min: number, max = Infinity): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

const MAX_TEXT_LENGTH = 10_000;

function asString(value: unknown, maxLength = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

// --- Lazy prepared statement cache ---

let _stmts: ReturnType<typeof buildStatements> | null = null;

function stmts() {
  if (!_stmts) _stmts = buildStatements();
  return _stmts;
}

function buildStatements() {
  const db = getDatabase();
  return {
    insertActividad: db.prepare(`
      INSERT INTO actividad (id, ae_id, cuenta_id, propuesta_id, contrato_id, tipo, resumen, sentimiento, siguiente_accion, fecha_siguiente_accion, fecha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updatePropuestaActividad: db.prepare(`
      UPDATE propuesta SET fecha_ultima_actividad = ?, dias_sin_actividad = 0
      WHERE id = ?
    `),
    getPropuestaAe: db.prepare(
      'SELECT ae_id FROM propuesta WHERE id = ?',
    ),
    updatePropuesta: db.prepare(`
      UPDATE propuesta SET
        etapa = COALESCE(?, etapa),
        valor_estimado = COALESCE(?, valor_estimado),
        notas = COALESCE(?, notas),
        razon_perdida = COALESCE(?, razon_perdida),
        fecha_ultima_actividad = ?
      WHERE id = ?
    `),
    insertPropuesta: db.prepare(`
      INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, medios, tipo_oportunidad, gancho_temporal, fecha_vuelo_inicio, fecha_vuelo_fin, etapa, fecha_creacion, fecha_ultima_actividad)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'en_preparacion', ?, ?)
    `),
  };
}

/** @internal Reset cached statements when the database instance changes (tests only). */
export function _resetStatementCache(): void {
  _stmts = null;
}

function handleIpcError(err: unknown, sourceGroup: string, type: unknown): true {
  const code = (err as any)?.code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    logger.error({ err, sourceGroup, type }, 'CRM IPC transient DB error (message lost)');
  } else if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
    logger.warn({ err, sourceGroup, type }, 'CRM IPC constraint violation');
  } else {
    logger.error({ err, sourceGroup, type }, 'CRM IPC handler error');
  }
  return true;
}

export async function processCrmIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  _isMain: boolean,
  deps: IpcDeps,
): Promise<boolean> {
  const db = getDatabase();

  switch (data.type) {
    case 'crm_evaluate_alerts': {
      try {
        const alerts = evaluateAlerts();
        if (alerts.length === 0) {
          logger.info('Alert evaluation: no new alerts');
          return true;
        }

        const groups = deps.registeredGroups();
        for (const alert of alerts) {
          const jid = Object.keys(groups).find(
            k => groups[k].folder === alert.grupo_destino_folder,
          );
          if (jid) {
            await deps.sendMessage(jid, alert.mensaje);
          }
        }
        logAlerts(alerts);
        logger.info({ count: alerts.length }, 'Alerts evaluated and sent');
        return true;
      } catch (err) {
        return handleIpcError(err, sourceGroup, data.type);
      }
    }

    case 'crm_registrar_actividad': {
      try {
        const person = getPersonByGroupFolder(sourceGroup);
        if (!person) {
          logger.warn({ sourceGroup }, 'Unknown persona for group');
          return true;
        }

        const id = `act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date().toISOString();
        const propuestaId = asString(data.propuesta_id) ?? null;

        stmts().insertActividad.run(
          id,
          person.id,
          asString(data.cuenta_id) ?? null,
          propuestaId,
          asString(data.contrato_id) ?? null,
          validateEnum(data.tipo, VALID_ACTIVIDAD_TIPOS, 'otro'),
          asString(data.resumen) ?? '',
          validateEnum(data.sentimiento, VALID_SENTIMIENTOS, 'neutral'),
          asString(data.siguiente_accion) ?? null,
          validateDate(data.fecha_siguiente_accion),
          now,
        );

        // Update propuesta.fecha_ultima_actividad if linked
        if (propuestaId) {
          stmts().updatePropuestaActividad.run(now, propuestaId);
        }

        logger.info({ id, persona: person.nombre }, 'Actividad registered');

        // Non-blocking escalation check
        try {
          const { evaluateEscalation } = await import('./escalation.js');
          await evaluateEscalation(person.id, deps);
        } catch {
          // Never let escalation failure break activity registration
        }

        return true;
      } catch (err) {
        return handleIpcError(err, sourceGroup, data.type);
      }
    }

    case 'crm_actualizar_propuesta': {
      try {
        const person = getPersonByGroupFolder(sourceGroup);
        if (!person) {
          logger.warn({ sourceGroup }, 'Unknown persona for group');
          return true;
        }

        const propuestaId = asString(data.propuesta_id);
        if (!propuestaId) {
          logger.warn({ sourceGroup }, 'Missing propuesta_id in crm_actualizar_propuesta');
          return true;
        }

        const prop = stmts().getPropuestaAe.get(propuestaId) as { ae_id: string } | undefined;
        if (!prop) {
          logger.warn({ propuestaId, sourceGroup }, 'Propuesta not found');
          return true;
        }
        if (!hasAccessTo(person, prop.ae_id)) {
          logger.warn({ sourceGroup, propuestaId }, 'Access denied: cannot update propuesta');
          return true;
        }

        const etapa = typeof data.etapa === 'string' && VALID_ETAPAS.has(data.etapa) ? data.etapa : null;
        const valor = validateNumber(data.valor_estimado, 0);
        const notas = asString(data.notas);
        const razon = asString(data.razon_perdida);
        const now = new Date().toISOString();

        if (etapa === null && valor === null && notas === undefined && razon === undefined) {
          return true;
        }

        const updateFn = db.transaction(() => {
          stmts().updatePropuesta.run(
            etapa, valor, notas ?? null, razon ?? null, now, propuestaId,
          );
        });
        updateFn();
        logger.info({ propuestaId, persona: person.nombre }, 'Propuesta updated');

        return true;
      } catch (err) {
        return handleIpcError(err, sourceGroup, data.type);
      }
    }

    case 'crm_crear_propuesta': {
      try {
        const person = getPersonByGroupFolder(sourceGroup);
        if (!person) {
          logger.warn({ sourceGroup }, 'Unknown persona for group');
          return true;
        }

        const id = `prop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date().toISOString();

        stmts().insertPropuesta.run(
          id,
          asString(data.cuenta_id) ?? null,
          person.id,
          asString(data.titulo) ?? 'Nueva propuesta',
          validateNumber(data.valor_estimado, 0),
          asString(data.medios) ?? null,
          asString(data.tipo_oportunidad) ?? null,
          asString(data.gancho_temporal) ?? null,
          validateDate(data.fecha_vuelo_inicio),
          validateDate(data.fecha_vuelo_fin),
          now,
          now,
        );

        logger.info({ id, persona: person.nombre }, 'Propuesta created');
        return true;
      } catch (err) {
        return handleIpcError(err, sourceGroup, data.type);
      }
    }

    case 'crm_check_followups': {
      try {
        const now = new Date();
        const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
        const nowStr = now.toISOString();

        // Find activities with upcoming follow-ups (within next 2 hours)
        const rows = db.prepare(`
          SELECT a.id, a.ae_id, a.siguiente_accion, a.fecha_siguiente_accion,
                 c.nombre AS cuenta_nombre,
                 per.whatsapp_group_folder
          FROM actividad a
          LEFT JOIN cuenta c ON a.cuenta_id = c.id
          LEFT JOIN persona per ON a.ae_id = per.id
          WHERE a.fecha_siguiente_accion IS NOT NULL
            AND a.fecha_siguiente_accion >= ?
            AND a.fecha_siguiente_accion <= ?
            AND per.whatsapp_group_folder IS NOT NULL
            AND per.activo = 1
        `).all(nowStr, twoHoursLater) as any[];

        if (rows.length === 0) {
          logger.info('Follow-up check: no pending follow-ups');
          return true;
        }

        // Dedup via alerta_log
        const today = now.toISOString().slice(0, 10);
        const checkDedup = db.prepare(
          `SELECT 1 FROM alerta_log WHERE alerta_tipo = 'followup_reminder' AND entidad_id = ? AND grupo_destino = ? AND fecha_envio_date = ?`,
        );
        const insertLog = db.prepare(
          `INSERT OR IGNORE INTO alerta_log (id, alerta_tipo, entidad_id, grupo_destino, fecha_envio) VALUES (?, 'followup_reminder', ?, ?, datetime('now'))`,
        );

        const groups = deps.registeredGroups();
        let sent = 0;

        for (const row of rows) {
          if (checkDedup.get(row.id, row.whatsapp_group_folder, today)) continue;

          const jid = Object.keys(groups).find(
            k => groups[k].folder === row.whatsapp_group_folder,
          );
          if (!jid) continue;

          const fechaDisplay = new Date(row.fecha_siguiente_accion).toLocaleString('es-MX', {
            hour: '2-digit', minute: '2-digit', hour12: true,
          });
          const msg = `*Recordatorio: Accion Pendiente*\n\n`
            + `\u2022 ${row.siguiente_accion}\n`
            + (row.cuenta_nombre ? `\u2022 Cuenta: ${row.cuenta_nombre}\n` : '')
            + `\u2022 Hora: ${fechaDisplay}\n`;

          await deps.sendMessage(jid, msg);
          insertLog.run(`fup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, row.id, row.whatsapp_group_folder);
          sent++;
        }

        logger.info({ sent }, 'Follow-up reminders sent');
        return true;
      } catch (err) {
        return handleIpcError(err, sourceGroup, data.type);
      }
    }

    case 'crm_doc_sync': {
      try {
        const { syncDocuments } = await import('./doc-sync.js');
        const count = await syncDocuments();
        logger.info({ count }, 'Document sync completed');
        return true;
      } catch (err) {
        return handleIpcError(err, sourceGroup, data.type);
      }
    }

    default:
      return false;
  }
}
