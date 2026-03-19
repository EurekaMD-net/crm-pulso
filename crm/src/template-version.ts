/**
 * Template version parsing and caching — maps role names to template versions.
 *
 * Reads persona template files once at first call and caches the mapping.
 * Used by IPC handlers (hot path, cached) and overnight analyzer.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { getDatabase } from "../../engine/src/db.js";

const VERSION_RE = /<!-- template_version: (\S+) -->/;

// Role → group file mapping
const ROLE_FILE_MAP: Record<string, string> = {
  ae: "ae.md",
  gerente: "manager.md",
  director: "director.md",
  vp: "vp.md",
};

let _cache: Map<string, string> | null = null;

/** Parse template version from a persona template file content. */
export function parseTemplateVersion(content: string): string | null {
  const match = content.match(VERSION_RE);
  return match?.[1] ?? null;
}

/** Get cached template versions for all roles. Reads files once. */
export function getTemplateVersions(): Map<string, string> {
  if (_cache) return _cache;
  _cache = new Map<string, string>();

  // Resolve from CRM groups directory
  const groupsDir = resolve(
    new URL(".", import.meta.url).pathname,
    "../groups",
  );

  for (const [role, filename] of Object.entries(ROLE_FILE_MAP)) {
    try {
      const content = readFileSync(resolve(groupsDir, filename), "utf-8");
      const version = parseTemplateVersion(content);
      if (version) {
        _cache.set(role, version);
      }
    } catch {
      // File not found or unreadable — skip
    }
  }

  return _cache;
}

/** Get the template version for a specific role. Cached. */
export function getTemplateVersionForRole(rol: string): string | null {
  return getTemplateVersions().get(rol) ?? null;
}

/** Clear cached versions (for testing or after template update). */
export function clearTemplateVersionCache(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// Template health summary (for dashboard / Phase C)
// ---------------------------------------------------------------------------

export interface TemplateHealth {
  version: string | null;
  total_scores: number;
  positive_count: number;
  negative_count: number;
  positive_rate: number;
  active_recommendations: number;
}

/** Get template health summary for a role (last 30 days). */
export function getTemplateHealthSummary(rol: string): TemplateHealth {
  const db = getDatabase();
  const version = getTemplateVersionForRole(rol);

  const scores = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN outcome_type IN ('actividad_positiva','propuesta_avanzada','feedback_aceptado') THEN sample_size ELSE 0 END) AS positive,
         SUM(CASE WHEN outcome_type IN ('actividad_negativa','propuesta_perdida','feedback_descartado') THEN sample_size ELSE 0 END) AS negative
       FROM template_score
       WHERE rol = ? AND fecha >= datetime('now', '-30 days')`,
    )
    .get(rol) as { total: number; positive: number; negative: number };

  const recsRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM insight_comercial
       WHERE tipo = 'recomendacion' AND estado IN ('nuevo','briefing')
         AND descripcion LIKE '%' || ? || '%'`,
    )
    .get(rol) as { cnt: number };

  const total = (scores.positive ?? 0) + (scores.negative ?? 0);
  return {
    version,
    total_scores: scores.total ?? 0,
    positive_count: scores.positive ?? 0,
    negative_count: scores.negative ?? 0,
    positive_rate:
      total > 0 ? Math.round(((scores.positive ?? 0) / total) * 100) : 0,
    active_recommendations: recsRow.cnt ?? 0,
  };
}
