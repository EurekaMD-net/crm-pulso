/**
 * Peer Comparison Analysis — Shared Module
 *
 * Compares an account's purchase history against peers in the same vertical.
 * Used by: recomendar_crosssell (on-demand), overnight engine (batch).
 */

import type Database from "better-sqlite3";

export interface PeerTipoMetric {
  tipo_oportunidad: string;
  count: number;
  avg_val: number;
  total_val: number;
  num_cuentas: number;
}

export interface AccountPropHistory {
  tipos_comprados: Set<string>;
  tipos_en_vuelo: Set<string>;
  valor_total_ganado: number;
  propuestas_por_tipo: Array<{
    tipo_oportunidad: string;
    count: number;
    val: number;
  }>;
}

export interface PeerComparison {
  account: AccountPropHistory;
  peer_tipos: PeerTipoMetric[];
  peer_avg_total_value: number | null;
  tipo_gaps: PeerTipoMetric[]; // tipos that peers use but this account doesn't
  value_gap: number | null; // peer avg total - account total (positive = upsell opportunity)
}

/**
 * Get an account's completed and active proposal history.
 */
export function getAccountPropHistory(
  db: Database.Database,
  cuentaId: string,
): AccountPropHistory {
  const completedProps = db
    .prepare(
      `SELECT tipo_oportunidad, COUNT(*) as c, SUM(valor_estimado) as val
       FROM propuesta
       WHERE cuenta_id = ? AND etapa = 'completada'
       GROUP BY tipo_oportunidad`,
    )
    .all(cuentaId) as any[];

  const activeProps = db
    .prepare(
      `SELECT tipo_oportunidad, COUNT(*) as c
       FROM propuesta
       WHERE cuenta_id = ? AND etapa NOT IN ('completada','perdida','cancelada')
       GROUP BY tipo_oportunidad`,
    )
    .all(cuentaId) as any[];

  return {
    tipos_comprados: new Set(
      completedProps.map((r: any) => r.tipo_oportunidad).filter(Boolean),
    ),
    tipos_en_vuelo: new Set(
      activeProps.map((r: any) => r.tipo_oportunidad).filter(Boolean),
    ),
    valor_total_ganado: completedProps.reduce(
      (s: number, r: any) => s + (r.val || 0),
      0,
    ),
    propuestas_por_tipo: completedProps,
  };
}

/**
 * Get peer (same vertical) proposal metrics.
 */
export function getPeerMetrics(
  db: Database.Database,
  vertical: string | null,
  excludeCuentaId: string,
): { tipos: PeerTipoMetric[]; avgTotalValue: number | null } {
  if (!vertical) return { tipos: [], avgTotalValue: null };

  const tipos = db
    .prepare(
      `SELECT p.tipo_oportunidad, COUNT(*) as c, AVG(p.valor_estimado) as avg_val,
              SUM(p.valor_estimado) as total_val, COUNT(DISTINCT p.cuenta_id) as num_cuentas
       FROM propuesta p
       JOIN cuenta c ON p.cuenta_id = c.id
       WHERE c.vertical = ? AND c.id != ? AND p.etapa = 'completada'
       GROUP BY p.tipo_oportunidad`,
    )
    .all(vertical, excludeCuentaId) as PeerTipoMetric[];

  const avgRow = db
    .prepare(
      `SELECT AVG(total) as avg_total FROM (
         SELECT SUM(p.valor_estimado) as total
         FROM propuesta p
         JOIN cuenta c ON p.cuenta_id = c.id
         WHERE c.vertical = ? AND c.id != ? AND p.etapa = 'completada'
         GROUP BY p.cuenta_id
       )`,
    )
    .get(vertical, excludeCuentaId) as any;

  return {
    tipos,
    avgTotalValue: avgRow?.avg_total ?? null,
  };
}

/**
 * Run full peer comparison for an account.
 */
export function comparePeers(
  db: Database.Database,
  cuentaId: string,
  vertical: string | null,
): PeerComparison {
  const account = getAccountPropHistory(db, cuentaId);
  const peers = getPeerMetrics(db, vertical, cuentaId);

  // Tipo gaps: tipos peers use that this account hasn't bought or has in flight
  const tipoGaps = peers.tipos.filter(
    (p) =>
      p.tipo_oportunidad &&
      !account.tipos_comprados.has(p.tipo_oportunidad) &&
      !account.tipos_en_vuelo.has(p.tipo_oportunidad),
  );

  // Value gap
  const valueGap =
    peers.avgTotalValue && account.valor_total_ganado > 0
      ? peers.avgTotalValue - account.valor_total_ganado
      : null;

  return {
    account,
    peer_tipos: peers.tipos,
    peer_avg_total_value: peers.avgTotalValue,
    tipo_gaps: tipoGaps,
    value_gap: valueGap,
  };
}
