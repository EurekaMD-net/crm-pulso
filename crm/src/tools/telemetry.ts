/**
 * Tool usage telemetry — lightweight SQLite-backed tracking.
 *
 * Records which CRM tools are called, by whom, how long they take,
 * and whether they succeed. Non-fatal: never breaks tool execution.
 */

import { getDatabase } from "../../../engine/src/db.js";

let tableReady = false;

/** Ensure the telemetry table exists (idempotent). */
function ensureTable(): void {
  if (tableReady) return;
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_tool_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      persona_id TEXT,
      rol TEXT,
      duration_ms INTEGER NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tool_usage_name ON crm_tool_usage(tool_name)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tool_usage_created ON crm_tool_usage(created_at)`,
  );
  tableReady = true;
}

/** Record a tool invocation. Never throws. */
export function recordToolUsage(
  name: string,
  personaId: string,
  rol: string,
  durationMs: number,
  success: boolean,
): void {
  try {
    ensureTable();
    getDatabase()
      .prepare(
        `INSERT INTO crm_tool_usage (tool_name, persona_id, rol, duration_ms, success)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(name, personaId, rol, durationMs, success ? 1 : 0);
  } catch {
    // Non-fatal — telemetry should never break tool execution
  }
}

export interface ToolUsageSummary {
  tool: string;
  count: number;
  avgMs: number;
  successRate: number;
}

/** Query aggregated tool usage over the last N days. */
export function queryToolUsage(days = 14): ToolUsageSummary[] {
  try {
    ensureTable();
    return getDatabase()
      .prepare(
        `SELECT tool_name AS tool,
              COUNT(*) AS count,
              ROUND(AVG(duration_ms)) AS avgMs,
              ROUND(SUM(success) * 100.0 / COUNT(*)) AS successRate
       FROM crm_tool_usage
       WHERE created_at > datetime('now', '-' || ? || ' days')
       GROUP BY tool_name
       ORDER BY count DESC`,
      )
      .all(days) as ToolUsageSummary[];
  } catch {
    return [];
  }
}

/** Reset for testing. */
export function resetTelemetryTable(): void {
  tableReady = false;
}
