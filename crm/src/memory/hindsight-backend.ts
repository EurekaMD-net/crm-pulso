/**
 * Hindsight memory backend — semantic memory via Hindsight REST API.
 *
 * Features:
 * - Circuit breaker: reuses CircuitBreaker from crm/src/circuit-breaker.ts
 * - Lazy bank creation with CRM-specific missions/dispositions
 * - Async retain (non-blocking writes)
 * - Budget-aware recall/reflect
 */

import { HindsightClient } from "./hindsight-client.js";
import { CircuitBreaker } from "../circuit-breaker.js";
import type {
  MemoryService,
  MemoryItem,
  MemoryBank,
  RetainOptions,
  RecallOptions,
  ReflectOptions,
} from "./types.js";

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export class HindsightMemoryBackend implements MemoryService {
  readonly backend = "hindsight" as const;
  private readonly client: HindsightClient;
  private readonly breaker: CircuitBreaker;
  private readonly initializedBanks = new Set<string>();

  constructor(baseUrl: string, apiKey?: string) {
    this.client = new HindsightClient(baseUrl, apiKey);
    this.breaker = new CircuitBreaker({ name: "hindsight" });
  }

  async retain(content: string, options: RetainOptions): Promise<void> {
    if (this.breaker.isOpen()) return;

    try {
      await this.ensureBank(options.bank);
      await this.client.retain(options.bank, {
        observation: content,
        tags: options.tags,
        async: options.async ?? true,
      });
      this.breaker.recordSuccess();
    } catch (err) {
      this.breaker.recordFailure(err);
    }
  }

  async recall(query: string, options: RecallOptions): Promise<MemoryItem[]> {
    if (this.breaker.isOpen()) return [];

    try {
      await this.ensureBank(options.bank);
      const response = await this.client.recall(options.bank, {
        query,
        budget: "low",
        tags: options.tags,
        max_results: options.maxResults ?? 10,
      });
      this.breaker.recordSuccess();
      return response.memories.map((m) => ({
        content: m.content,
        relevance: m.relevance,
        createdAt: m.created_at,
      }));
    } catch (err) {
      this.breaker.recordFailure(err);
      return [];
    }
  }

  async reflect(query: string, options: ReflectOptions): Promise<string> {
    if (this.breaker.isOpen()) return "";

    try {
      await this.ensureBank(options.bank);
      const response = await this.client.reflect(options.bank, {
        query,
        budget: "mid",
        tags: options.tags,
      });
      this.breaker.recordSuccess();
      return response.reflection;
    } catch (err) {
      this.breaker.recordFailure(err);
      return "";
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const result = await this.client.health();
      return result.status === "ok" || result.status === "healthy";
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Lazy bank creation
  // -------------------------------------------------------------------------

  private async ensureBank(bankId: MemoryBank): Promise<void> {
    if (this.initializedBanks.has(bankId)) return;

    const config = BANK_CONFIGS[bankId];
    if (!config) return;

    try {
      await this.client.upsertBank(bankId, config);
      this.initializedBanks.add(bankId);
    } catch {
      // Non-fatal — bank may already exist
      this.initializedBanks.add(bankId); // Don't retry
    }
  }
}

// ---------------------------------------------------------------------------
// CRM-specific bank configurations
// ---------------------------------------------------------------------------

const BANK_CONFIGS: Record<
  MemoryBank,
  { mission: string; disposition: string }
> = {
  "crm-sales": {
    mission:
      "Almacenar y recuperar patrones de ejecucion de ventas: tecnicas de manejo de objeciones, " +
      "estrategias de cierre, preferencias de clientes, lecciones de propuestas ganadas y perdidas, " +
      "y patrones de negociacion efectiva en venta de medios publicitarios.",
    disposition:
      "Priorizar aprendizajes accionables y especificos sobre observaciones genericas. " +
      "Consolidar patrones de ventas similares. Descartar observaciones obsoletas cuando " +
      "las condiciones de mercado o inventario cambian.",
  },
  "crm-accounts": {
    mission:
      "Recordar inteligencia de cuentas: historial de relaciones con clientes y agencias, " +
      "preferencias de stakeholders, dinamicas politicas internas de las cuentas, " +
      "y contexto de la vertical (CPG, automotriz, telecomunicaciones, etc.).",
    disposition:
      "Priorizar preferencias de stakeholders y contexto de relacion. " +
      "Auto-refrescar cuando se consolidan observaciones. Mantener el contexto " +
      "de la cuenta relevante y oportuno — decaer temas viejos.",
  },
  "crm-team": {
    mission:
      "Rastrear patrones de rendimiento del equipo de ventas: observaciones de coaching, " +
      "fortalezas y areas de mejora por ejecutivo, patrones de actividad que predicen exito, " +
      "y lecciones de gestion para gerentes, directores y VP.",
    disposition:
      "Enfocarse en patrones y anomalias de rendimiento. Consolidar metricas rutinarias. " +
      "Retener observaciones de coaching y sus resultados a largo plazo.",
  },
};
