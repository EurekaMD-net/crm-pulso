/**
 * Alert Evaluators
 *
 * 5 pure-SQL alert evaluators that detect conditions requiring attention.
 * Each returns AlertResult[] with WhatsApp-formatted messages.
 * Deduplication via alerta_log prevents duplicate alerts within the same day.
 */

import { getDatabase } from '../../engine/src/db.js';
import { getPersonById, getManager, getDirector } from './hierarchy.js';
import type { Persona } from './hierarchy.js';

export interface AlertResult {
  alerta_tipo: string;
  entidad_id: string;
  grupo_destino_folder: string;
  mensaje: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Resolve persona -> whatsapp_group_folder, returns null if missing. */
function folderOf(personaId: string | null): string | null {
  if (!personaId) return null;
  const p = getPersonById(personaId);
  return p?.whatsapp_group_folder ?? null;
}

/** Find VP persona by walking up the hierarchy (max 5 levels). */
function findVp(personaId: string): Persona | null {
  let current = personaId;
  for (let i = 0; i < 5; i++) {
    const p = getPersonById(current);
    if (!p) return null;
    if (p.rol === 'vp') return p;
    if (!p.reporta_a) return null;
    current = p.reporta_a;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. Propuestas estancadas (>7 dias sin actividad)
// ---------------------------------------------------------------------------

export function alertPropuestasEstancadas(): AlertResult[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT p.id, p.titulo, p.dias_sin_actividad, p.valor_estimado, p.etapa, p.ae_id,
           c.nombre AS cuenta_nombre
    FROM propuesta p
    LEFT JOIN cuenta c ON p.cuenta_id = c.id
    WHERE p.dias_sin_actividad > 7
      AND p.etapa NOT IN ('completada', 'perdida', 'cancelada')
  `).all() as any[];

  const results: AlertResult[] = [];

  for (const row of rows) {
    const aeFolder = folderOf(row.ae_id);
    if (aeFolder) {
      const valor = row.valor_estimado
        ? `$${Number(row.valor_estimado).toLocaleString('es-MX')}`
        : 'sin valor';
      results.push({
        alerta_tipo: 'propuesta_estancada',
        entidad_id: row.id,
        grupo_destino_folder: aeFolder,
        mensaje: `*Alerta: Propuesta Estancada*\n\nPropuesta "${row.titulo}" lleva ${row.dias_sin_actividad} dias sin actividad.\n`
          + `\u2022 Cuenta: ${row.cuenta_nombre ?? 'N/A'}\n`
          + `\u2022 Etapa: ${row.etapa}\n`
          + `\u2022 Valor: ${valor}\n\n`
          + `Accion recomendada: registrar actividad o actualizar etapa.`,
      });
    }

    // Escalate to gerente if >14 days
    if (row.dias_sin_actividad > 14) {
      const managerId = getManager(row.ae_id);
      const mgrFolder = folderOf(managerId);
      if (mgrFolder) {
        results.push({
          alerta_tipo: 'propuesta_estancada_escalada',
          entidad_id: row.id,
          grupo_destino_folder: mgrFolder,
          mensaje: `*Alerta Escalada: Propuesta Estancada >14 dias*\n\nPropuesta "${row.titulo}" lleva ${row.dias_sin_actividad} dias sin actividad.\n`
            + `\u2022 Cuenta: ${row.cuenta_nombre ?? 'N/A'}\n`
            + `\u2022 AE: ${getPersonById(row.ae_id)?.nombre ?? 'N/A'}\n`
            + `\u2022 Etapa: ${row.etapa}\n\n`
            + `Accion recomendada: revisar con el AE.`,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// 2. Cuota baja (<80%)
// ---------------------------------------------------------------------------

export function alertCuotaBaja(): AlertResult[] {
  const db = getDatabase();
  const now = new Date();
  const year = now.getFullYear();
  // ISO week approximation
  const dayOfYear = Math.floor((now.getTime() - new Date(year, 0, 1).getTime()) / 86400000);
  const week = Math.max(1, Math.ceil((dayOfYear + 1) / 7));

  const rows = db.prepare(`
    SELECT q.persona_id, q.porcentaje, q.meta_total, q.logro,
           p.nombre AS persona_nombre, p.whatsapp_group_folder
    FROM cuota q
    JOIN persona p ON q.persona_id = p.id
    WHERE q.año = ? AND q.semana = ?
      AND q.porcentaje < 80
      AND p.activo = 1
  `).all(year, week) as any[];

  const results: AlertResult[] = [];

  for (const row of rows) {
    if (!row.whatsapp_group_folder) continue;
    results.push({
      alerta_tipo: 'cuota_baja',
      entidad_id: `${row.persona_id}-${year}-w${week}`,
      grupo_destino_folder: row.whatsapp_group_folder,
      mensaje: `*Alerta: Cuota por debajo del 80%*\n\n`
        + `Tu cuota esta semana (S${week}) va al ${Math.round(row.porcentaje)}%.\n`
        + `\u2022 Meta: $${Number(row.meta_total).toLocaleString('es-MX')}\n`
        + `\u2022 Logro: $${Number(row.logro).toLocaleString('es-MX')}\n\n`
        + `Accion recomendada: revisar propuestas activas y acelerar cierres.`,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 3. Descarga gap creciente (3+ semanas consecutivas)
// ---------------------------------------------------------------------------

export function alertDescargaGap(): AlertResult[] {
  const db = getDatabase();
  // Find cuentas where gap_acumulado has been growing for 3+ consecutive weeks
  const rows = db.prepare(`
    WITH recent AS (
      SELECT d.cuenta_id, d.semana, d.año, d.gap_acumulado,
             c.nombre AS cuenta_nombre, c.ae_id
      FROM descarga d
      JOIN cuenta c ON d.cuenta_id = c.id
      ORDER BY d.año DESC, d.semana DESC
    ),
    ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY cuenta_id ORDER BY año DESC, semana DESC) AS rn
      FROM recent
    )
    SELECT r1.cuenta_id, r1.cuenta_nombre, r1.ae_id,
           r1.gap_acumulado AS gap_w1, r2.gap_acumulado AS gap_w2, r3.gap_acumulado AS gap_w3
    FROM ranked r1
    JOIN ranked r2 ON r1.cuenta_id = r2.cuenta_id AND r2.rn = 2
    JOIN ranked r3 ON r1.cuenta_id = r3.cuenta_id AND r3.rn = 3
    WHERE r1.rn = 1
      AND r1.gap_acumulado > r2.gap_acumulado
      AND r2.gap_acumulado > r3.gap_acumulado
      AND r1.gap_acumulado > 0
  `).all() as any[];

  const results: AlertResult[] = [];

  for (const row of rows) {
    const aeFolder = folderOf(row.ae_id);
    if (aeFolder) {
      results.push({
        alerta_tipo: 'descarga_gap',
        entidad_id: row.cuenta_id,
        grupo_destino_folder: aeFolder,
        mensaje: `*Alerta: Gap de Descarga Creciente*\n\n`
          + `La cuenta "${row.cuenta_nombre}" tiene un gap acumulado creciente por 3+ semanas.\n`
          + `\u2022 Gap actual: $${Number(row.gap_w1).toLocaleString('es-MX')}\n\n`
          + `Accion recomendada: revisar plan de facturacion y hablar con el cliente.`,
      });
    }

    // Also notify gerente
    const managerId = getManager(row.ae_id);
    const mgrFolder = folderOf(managerId);
    if (mgrFolder) {
      results.push({
        alerta_tipo: 'descarga_gap',
        entidad_id: `${row.cuenta_id}-mgr`,
        grupo_destino_folder: mgrFolder,
        mensaje: `*Alerta: Gap de Descarga Creciente*\n\n`
          + `La cuenta "${row.cuenta_nombre}" (${getPersonById(row.ae_id)?.nombre ?? 'N/A'}) tiene gap creciente por 3+ semanas.\n`
          + `\u2022 Gap actual: $${Number(row.gap_w1).toLocaleString('es-MX')}\n\n`
          + `Accion recomendada: revisar con el AE.`,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// 4. Mega-deal movimiento (es_mega=1 con actividad reciente)
// ---------------------------------------------------------------------------

export function alertMegaDealMovimiento(): AlertResult[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT DISTINCT p.id, p.titulo, p.valor_estimado, p.etapa, p.ae_id,
           c.nombre AS cuenta_nombre, a.resumen AS ultima_actividad
    FROM propuesta p
    JOIN actividad a ON a.propuesta_id = p.id
    LEFT JOIN cuenta c ON p.cuenta_id = c.id
    WHERE p.es_mega = 1
      AND p.etapa NOT IN ('completada', 'perdida', 'cancelada')
      AND a.fecha >= datetime('now', '-24 hours')
    ORDER BY a.fecha DESC
  `).all() as any[];

  const results: AlertResult[] = [];
  // Deduplicate by propuesta (DISTINCT may not catch all due to ORDER BY)
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);

    const valor = `$${Number(row.valor_estimado).toLocaleString('es-MX')}`;

    // Notify director
    const directorId = getDirector(row.ae_id);
    const dirFolder = folderOf(directorId);
    if (dirFolder) {
      results.push({
        alerta_tipo: 'mega_deal_movimiento',
        entidad_id: row.id,
        grupo_destino_folder: dirFolder,
        mensaje: `*Alerta: Movimiento en Mega-Deal*\n\n`
          + `"${row.titulo}" (${valor}) tiene actividad reciente.\n`
          + `\u2022 Cuenta: ${row.cuenta_nombre ?? 'N/A'}\n`
          + `\u2022 Etapa: ${row.etapa}\n`
          + `\u2022 Ultima actividad: ${row.ultima_actividad?.slice(0, 100) ?? 'N/A'}\n`,
      });
    }

    // Notify VP
    const vp = findVp(row.ae_id);
    const vpFolder = vp?.whatsapp_group_folder ?? null;
    if (vpFolder && vpFolder !== dirFolder) {
      results.push({
        alerta_tipo: 'mega_deal_movimiento',
        entidad_id: `${row.id}-vp`,
        grupo_destino_folder: vpFolder,
        mensaje: `*Alerta: Movimiento en Mega-Deal*\n\n`
          + `"${row.titulo}" (${valor}) tiene actividad reciente.\n`
          + `\u2022 Cuenta: ${row.cuenta_nombre ?? 'N/A'}\n`
          + `\u2022 Etapa: ${row.etapa}\n`,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// 5. Inactividad AE (5+ dias sin actividad)
// ---------------------------------------------------------------------------

export function alertInactividadAe(): AlertResult[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT p.id, p.nombre, p.reporta_a,
           MAX(a.fecha) AS ultima_actividad,
           CAST(julianday('now') - julianday(COALESCE(MAX(a.fecha), '2000-01-01')) AS INTEGER) AS dias_inactivo
    FROM persona p
    LEFT JOIN actividad a ON a.ae_id = p.id
    WHERE p.rol = 'ae' AND p.activo = 1
    GROUP BY p.id
    HAVING dias_inactivo >= 5
  `).all() as any[];

  const results: AlertResult[] = [];

  for (const row of rows) {
    const mgrFolder = folderOf(row.reporta_a);
    if (!mgrFolder) continue;

    results.push({
      alerta_tipo: 'inactividad_ae',
      entidad_id: row.id,
      grupo_destino_folder: mgrFolder,
      mensaje: `*Alerta: AE sin actividad*\n\n`
        + `${row.nombre} lleva ${row.dias_inactivo} dias sin registrar actividad.\n\n`
        + `Accion recomendada: revisar con el AE.`,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Orchestrator: evaluate all + dedup
// ---------------------------------------------------------------------------

export function evaluateAlerts(): AlertResult[] {
  const db = getDatabase();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const allAlerts = [
    ...alertPropuestasEstancadas(),
    ...alertCuotaBaja(),
    ...alertDescargaGap(),
    ...alertMegaDealMovimiento(),
    ...alertInactividadAe(),
  ];

  // Filter out already-sent alerts (same type + entity + group + date)
  const checkStmt = db.prepare(
    `SELECT 1 FROM alerta_log
     WHERE alerta_tipo = ? AND entidad_id = ? AND grupo_destino = ? AND fecha_envio_date = ?`,
  );

  return allAlerts.filter(a => {
    const exists = checkStmt.get(a.alerta_tipo, a.entidad_id, a.grupo_destino_folder, today);
    return !exists;
  });
}

export function logAlerts(results: AlertResult[]): void {
  const db = getDatabase();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO alerta_log (id, alerta_tipo, entidad_id, grupo_destino, fecha_envio)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  );

  const insertAll = db.transaction(() => {
    for (const a of results) {
      stmt.run(genId('alrt'), a.alerta_tipo, a.entidad_id, a.grupo_destino_folder);
    }
  });

  insertAll();
}
