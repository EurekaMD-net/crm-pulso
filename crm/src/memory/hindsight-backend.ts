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
import { logger } from "../logger.js";
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
    if (this.breaker.isOpen()) {
      logger.warn(
        { bank: options.bank, op: "retain" },
        "hindsight circuit open — memory write skipped",
      );
      return;
    }

    try {
      await this.ensureBank(options.bank);
      await this.client.retain(options.bank, {
        observation: content,
        tags: options.tags,
        metadata: options.personaId
          ? { persona_id: options.personaId }
          : undefined,
        async: options.async ?? true,
      });
      this.breaker.recordSuccess();
    } catch (err) {
      this.breaker.recordFailure(err);
      logger.warn(
        {
          bank: options.bank,
          op: "retain",
          err: err instanceof Error ? err.message : String(err),
        },
        "hindsight retain failed",
      );
    }
  }

  async recall(query: string, options: RecallOptions): Promise<MemoryItem[]> {
    if (this.breaker.isOpen()) {
      logger.warn(
        { bank: options.bank, op: "recall" },
        "hindsight circuit open — memory recall returning empty",
      );
      return [];
    }

    try {
      await this.ensureBank(options.bank);
      const response = await this.client.recall(options.bank, {
        query,
        budget: "low",
        tags: options.tags,
        max_results: options.maxResults ?? 10,
      });
      this.breaker.recordSuccess();
      return (response.results ?? []).map((m) => ({
        content: m.text,
        createdAt: m.mentioned_at,
      }));
    } catch (err) {
      this.breaker.recordFailure(err);
      logger.warn(
        {
          bank: options.bank,
          op: "recall",
          err: err instanceof Error ? err.message : String(err),
        },
        "hindsight recall failed",
      );
      return [];
    }
  }

  async reflect(query: string, options: ReflectOptions): Promise<string> {
    if (this.breaker.isOpen()) {
      logger.warn(
        { bank: options.bank, op: "reflect" },
        "hindsight circuit open — reflection returning empty",
      );
      return "";
    }

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
      logger.warn(
        {
          bank: options.bank,
          op: "reflect",
          err: err instanceof Error ? err.message : String(err),
        },
        "hindsight reflect failed",
      );
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
    } catch (err) {
      // Non-fatal — retain/recall use server defaults if config push fails.
      // Log so genuine errors (auth, schema drift) surface instead of being silent.
      logger.warn(
        {
          bank: bankId,
          op: "upsertBank",
          err: err instanceof Error ? err.message : String(err),
        },
        "hindsight upsertBank failed; bank will use server defaults",
      );
      this.initializedBanks.add(bankId); // Don't retry this process
    }
  }
}

// ---------------------------------------------------------------------------
// CRM-specific bank configurations
// ---------------------------------------------------------------------------

const BANK_CONFIGS: Record<
  MemoryBank,
  {
    mission: string;
    disposition: { skepticism: number; literalism: number; empathy: number };
    observationsMission: string;
  }
> = {
  "crm-sales": {
    mission:
      "Almacenar y recuperar patrones de ejecucion de ventas: tecnicas de manejo de objeciones, " +
      "estrategias de cierre, preferencias de clientes, lecciones de propuestas ganadas y perdidas, " +
      "y patrones de negociacion efectiva en venta de medios publicitarios.",
    disposition: { skepticism: 4, literalism: 4, empathy: 2 },
    observationsMission:
      "Priorizar aprendizajes accionables y especificos sobre observaciones genericas. " +
      "Consolidar patrones de ventas similares. Descartar observaciones obsoletas cuando " +
      "las condiciones de mercado o inventario cambian.",
  },
  "crm-accounts": {
    mission:
      "Recordar inteligencia de cuentas: historial de relaciones con clientes y agencias, " +
      "preferencias de stakeholders, dinamicas politicas internas de las cuentas, " +
      "y contexto de la vertical (CPG, automotriz, telecomunicaciones, etc.).",
    disposition: { skepticism: 3, literalism: 4, empathy: 3 },
    observationsMission:
      "Priorizar preferencias de stakeholders y contexto de relacion. " +
      "Auto-refrescar cuando se consolidan observaciones. Mantener el contexto " +
      "de la cuenta relevante y oportuno — decaer temas viejos.",
  },
  "crm-team": {
    mission:
      "Rastrear patrones de rendimiento del equipo de ventas: observaciones de coaching, " +
      "fortalezas y areas de mejora por ejecutivo, patrones de actividad que predicen exito, " +
      "y lecciones de gestion para gerentes, directores y VP.",
    disposition: { skepticism: 3, literalism: 3, empathy: 4 },
    observationsMission:
      "Enfocarse en patrones y anomalias de rendimiento. Consolidar metricas rutinarias. " +
      "Retener observaciones de coaching y sus resultados a largo plazo.",
  },
  "crm-user": {
    mission:
      "Recordar preferencias, estilo de comunicacion, datos personales y patrones de " +
      "comportamiento del usuario (el vendedor que habla con el agente). Incluye: " +
      "como prefiere recibir informacion, horarios, familia, hobbies, fechas importantes, " +
      "y correcciones de estilo que ha hecho al agente.",
    disposition: { skepticism: 2, literalism: 3, empathy: 4 },
    observationsMission:
      "Priorizar preferencias de comunicacion y correcciones de estilo — estas afectan " +
      "cada interaccion. Consolidar datos personales redundantes. Mantener actualizado " +
      "cuando el usuario corrija informacion previa.",
  },
};
