/**
 * Shared tool helpers
 *
 * scopeFilter — role-based SQL WHERE clause builder (canonical, single copy)
 * findCuentaId — fuzzy account lookup by name
 * getCurrentWeek — ISO week number
 * personaIdFromName — fuzzy persona lookup by name
 */

import { getDatabase } from "../db.js";
import type { ToolContext } from "./index.js";

// ---------------------------------------------------------------------------
// Role-based scope filter (single source of truth)
// ---------------------------------------------------------------------------

export function scopeFilter(
  ctx: ToolContext,
  alias = "ae_id",
): { where: string; params: string[] } {
  if (ctx.rol === "vp") return { where: "", params: [] };
  if (ctx.rol === "director") {
    const ids = [ctx.persona_id, ...ctx.full_team_ids];
    return {
      where: `AND ${alias} IN (${ids.map(() => "?").join(",")})`,
      params: ids,
    };
  }
  if (ctx.rol === "gerente") {
    const ids = [ctx.persona_id, ...ctx.team_ids];
    return {
      where: `AND ${alias} IN (${ids.map(() => "?").join(",")})`,
      params: ids,
    };
  }
  return { where: `AND ${alias} = ?`, params: [ctx.persona_id] };
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Estado filter for approval workflow.
 * Non-active records are hidden unless the caller created them.
 * Returns a SQL fragment and params to inject into WHERE clauses.
 */
export function estadoFilter(
  ctx: ToolContext,
  alias = "c",
): { where: string; params: string[] } {
  return {
    where: `AND (${alias}.estado IN ('activo','activo_en_revision') OR ${alias}.creado_por = ?)`,
    params: [ctx.persona_id],
  };
}

export function findCuentaId(nombre: string, ctx?: ToolContext): string | null {
  const db = getDatabase();
  if (ctx) {
    const ef = estadoFilter(ctx, "cuenta");
    const row = db
      .prepare(`SELECT id FROM cuenta WHERE nombre LIKE ? ${ef.where}`)
      .get(`%${nombre}%`, ...ef.params) as any;
    return row?.id ?? null;
  }
  const row = db
    .prepare("SELECT id FROM cuenta WHERE nombre LIKE ?")
    .get(`%${nombre}%`) as any;
  return row?.id ?? null;
}

export function personaIdFromName(nombre: string): string | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT id FROM persona WHERE nombre LIKE ?")
    .get(`%${nombre}%`) as any;
  return row?.id ?? null;
}

export function getCurrentWeek(): number {
  const mxDate = getMxDateStr();
  const [y, m, d] = mxDate.split("-").map(Number);
  const now = new Date(y, m - 1, d);
  const start = new Date(y, 0, 1);
  return Math.ceil(
    ((now.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7,
  );
}

export function getPersonaEmail(personaId: string): string | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT email FROM persona WHERE id = ?")
    .get(personaId) as any;
  return row?.email ?? null;
}

// ---------------------------------------------------------------------------
// Mexico City timezone helpers — ALL user-facing dates must use these
// ---------------------------------------------------------------------------

/** All user-facing dates MUST use America/Mexico_City. sv-SE locale = YYYY-MM-DD (ISO 8601). */
const MX_TZ = "America/Mexico_City";

/** YYYY-MM-DD in Mexico City timezone. Accepts optional Date for future/past dates. */
export function getMxDateStr(date?: Date): string {
  return (date ?? new Date()).toLocaleDateString("sv-SE", { timeZone: MX_TZ });
}

/** Current year in Mexico City timezone (avoids UTC year-boundary bug on Dec 31 evening). */
export function getMxYear(): number {
  return parseInt(getMxDateStr().split("-")[0], 10);
}

/**
 * Compute a date cutoff string for use as a SQL parameter.
 * Replaces template-interpolated `datetime('now', '-N days')` patterns.
 */
export function dateCutoff(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400000).toISOString();
}

/**
 * Compute data freshness metadata for a set of rows.
 * Tells the agent how old the most recent data point is so it can
 * express appropriate confidence (or uncertainty) to the user.
 */
export function dataFreshness(
  rows: any[],
  dateField: string,
): {
  latest: string | null;
  days_old: number;
  stale: boolean;
} {
  if (!rows.length) return { latest: null, days_old: -1, stale: true };
  const withDate = rows.filter((r) => r[dateField] != null);
  if (!withDate.length) return { latest: null, days_old: -1, stale: true };
  const latest = withDate.reduce(
    (max, r) => (r[dateField] > max ? r[dateField] : max),
    "",
  );
  const daysOld = Math.floor(
    (Date.now() - new Date(latest).getTime()) / 86400000,
  );
  return { latest, days_old: daysOld, stale: daysOld > 3 };
}
