/**
 * Hindsight REST client — thin wrapper around native fetch.
 *
 * Covers the 5 Hindsight endpoints needed:
 * - retain (store observation)
 * - recall (semantic search)
 * - reflect (synthesize)
 * - bank CRUD (create/update)
 * - health check
 *
 * Ported verbatim from mission-control.
 */

const DEFAULT_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HindsightRetainRequest {
  observation: string;
  tags?: string[];
  metadata?: Record<string, string>;
  async?: boolean;
}

export interface HindsightRecallRequest {
  query: string;
  budget?: "low" | "mid" | "high";
  tags?: string[];
  max_results?: number;
}

export interface HindsightRecallResponse {
  results: Array<{
    text: string;
    id?: string;
    type?: string;
    mentioned_at?: string;
  }>;
}

export interface HindsightReflectRequest {
  query: string;
  budget?: "low" | "mid" | "high";
  tags?: string[];
}

export interface HindsightReflectResponse {
  reflection: string;
}

export interface HindsightBankConfig {
  mission?: string;
  disposition?: { skepticism: number; literalism: number; empathy: number };
  observationsMission?: string;
}

export interface HindsightHealthResponse {
  status: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class HindsightClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Hindsight ${method} ${path}: ${response.status} ${text}`,
        );
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Store an observation in a memory bank. */
  async retain(bankId: string, req: HindsightRetainRequest): Promise<void> {
    const item: Record<string, unknown> = { content: req.observation };
    if (req.tags && req.tags.length > 0) item.tags = req.tags;
    if (req.metadata && Object.keys(req.metadata).length > 0) {
      item.metadata = req.metadata;
    }
    await this.request("POST", `/v1/default/banks/${bankId}/memories`, {
      items: [item],
      async: req.async ?? true,
    });
  }

  /** Search memories by semantic similarity. */
  async recall(
    bankId: string,
    req: HindsightRecallRequest,
  ): Promise<HindsightRecallResponse> {
    return this.request<HindsightRecallResponse>(
      "POST",
      `/v1/default/banks/${bankId}/memories/recall`,
      req,
    );
  }

  /** Synthesize a reflection from stored memories. */
  async reflect(
    bankId: string,
    req: HindsightReflectRequest,
  ): Promise<HindsightReflectResponse> {
    return this.request<HindsightReflectResponse>(
      "POST",
      `/v1/default/banks/${bankId}/reflect`,
      req,
    );
  }

  /** Create or update a memory bank. */
  async upsertBank(bankId: string, config: HindsightBankConfig): Promise<void> {
    // Hindsight ≥ v0.4 deprecated `mission` (use retain_mission/reflect_mission)
    // and requires `disposition` as a {skepticism,literalism,empathy} object.
    const body: Record<string, unknown> = {};
    if (config.mission) {
      body.retain_mission = config.mission;
      body.reflect_mission = config.mission;
    }
    if (config.disposition) body.disposition = config.disposition;
    if (config.observationsMission) {
      body.observations_mission = config.observationsMission;
    }
    await this.request("PUT", `/v1/default/banks/${bankId}`, body);
  }

  /** Health check. */
  async health(): Promise<HindsightHealthResponse> {
    return this.request<HindsightHealthResponse>(
      "GET",
      "/health",
      undefined,
      1500,
    );
  }
}
