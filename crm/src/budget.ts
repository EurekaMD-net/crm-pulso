/**
 * Budget tracking — per-inference cost recording with 3-window monitoring.
 *
 * Records cost per inference call and tracks hourly/daily/monthly spend.
 * Uses the CRM SQLite database with a new cost_ledger table.
 *
 * Ported from mission-control's budget/service.ts.
 */

import { getDatabase } from "./db.js";

// ---------------------------------------------------------------------------
// Schema (created lazily on first use)
// ---------------------------------------------------------------------------

let schemaReady = false;

function ensureSchema(): void {
  if (schemaReady) return;
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      provider TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cost_ledger_created
      ON cost_ledger(created_at);
  `);
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Pricing (per million tokens, USD)
// ---------------------------------------------------------------------------

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "qwen3.5-plus": { input: 0.8, output: 2.0 },
  "qwen3-235b-a22b": { input: 0.8, output: 2.0 },
  "glm-5": { input: 0.5, output: 1.5 },
  "kimi-k2.5": { input: 1.0, output: 3.0 },
  "MiniMax-M1": { input: 1.0, output: 3.0 },
  _default: { input: 1.0, output: 3.0 },
};

export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING._default;
  return (
    (promptTokens / 1_000_000) * pricing.input +
    (completionTokens / 1_000_000) * pricing.output
  );
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface CostRecord {
  model: string;
  promptTokens: number;
  completionTokens: number;
  provider?: string;
}

export function recordCost(record: CostRecord): void {
  ensureSchema();
  const costUsd = calculateCost(
    record.model,
    record.promptTokens,
    record.completionTokens,
  );
  const db = getDatabase();
  db.prepare(
    `INSERT INTO cost_ledger (model, prompt_tokens, completion_tokens, cost_usd, provider)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    record.model,
    record.promptTokens,
    record.completionTokens,
    costUsd,
    record.provider ?? null,
  );
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getHourlySpend(): number {
  ensureSchema();
  const db = getDatabase();
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_ledger WHERE created_at >= strftime('%Y-%m-%d %H:00:00', 'now')",
    )
    .get() as { total: number };
  return row.total;
}

export function getDailySpend(): number {
  ensureSchema();
  const db = getDatabase();
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_ledger WHERE created_at >= datetime('now', '-1 day')",
    )
    .get() as { total: number };
  return row.total;
}

export function getMonthlySpend(): number {
  ensureSchema();
  const db = getDatabase();
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_ledger WHERE created_at >= strftime('%Y-%m-01', 'now')",
    )
    .get() as { total: number };
  return row.total;
}

export interface WindowStatus {
  spend: number;
  limit: number;
  remaining: number;
  exceeded: boolean;
}

export interface ThreeWindowStatus {
  hourly: WindowStatus;
  daily: WindowStatus;
  monthly: WindowStatus;
}

function windowStatus(spend: number, limit: number): WindowStatus {
  return {
    spend: Math.round(spend * 10000) / 10000,
    limit,
    remaining: Math.max(0, Math.round((limit - spend) * 10000) / 10000),
    exceeded: spend >= limit,
  };
}

export function getThreeWindowStatus(): ThreeWindowStatus {
  const hourlyLimit = parseFloat(process.env.BUDGET_HOURLY_LIMIT_USD ?? "1.00");
  const dailyLimit = parseFloat(process.env.BUDGET_DAILY_LIMIT_USD ?? "10.00");
  const monthlyLimit = parseFloat(
    process.env.BUDGET_MONTHLY_LIMIT_USD ?? "200.00",
  );

  return {
    hourly: windowStatus(getHourlySpend(), hourlyLimit),
    daily: windowStatus(getDailySpend(), dailyLimit),
    monthly: windowStatus(getMonthlySpend(), monthlyLimit),
  };
}

/** @internal — exposed for testing only */
export function _resetSchema(): void {
  schemaReady = false;
}
