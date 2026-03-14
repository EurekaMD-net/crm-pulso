/**
 * Circuit Breaker — prevents cascading failures on external services.
 *
 * Tracks consecutive failures per named service. After threshold failures,
 * the circuit opens and calls are skipped for a cooldown period. After
 * cooldown, a half-open state allows one retry.
 *
 * Ported from mission-control's Hindsight backend (v2.8).
 */

import { logger as parentLogger } from "./logger.js";

const logger = parentLogger.child({ component: "circuit-breaker" });

// ---------------------------------------------------------------------------
// Defaults (overridable via env or constructor)
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD = parseInt(
  process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD ?? "3",
  10,
);
const DEFAULT_COOLDOWN_MS = parseInt(
  process.env.CIRCUIT_BREAKER_COOLDOWN_MS ?? "60000",
  10,
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  open: boolean;
}

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold?: number;
  cooldownMs?: number;
}

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

export class CircuitBreaker {
  readonly name: string;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private state: CircuitBreakerState;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.threshold = options.failureThreshold ?? DEFAULT_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.state = { failures: 0, lastFailure: 0, open: false };
  }

  /**
   * Returns true if the circuit is open (calls should be skipped).
   * Transitions OPEN → HALF-OPEN when cooldown elapses.
   */
  isOpen(): boolean {
    if (!this.state.open) return false;

    const elapsed = Date.now() - this.state.lastFailure;
    if (elapsed >= this.cooldownMs) {
      // Half-open: allow one attempt
      this.state.open = false;
      this.state.failures = 0;
      logger.info({ name: this.name }, "circuit breaker half-open, retrying");
      return false;
    }
    return true;
  }

  /** Record a successful call. Resets failure count, closes circuit. */
  recordSuccess(): void {
    if (this.state.failures > 0) {
      this.state.failures = 0;
      this.state.open = false;
    }
  }

  /** Record a failed call. Increments failure count, may open circuit. */
  recordFailure(err?: unknown): void {
    this.state.failures++;
    this.state.lastFailure = Date.now();

    if (this.state.failures >= this.threshold) {
      this.state.open = true;
      logger.warn(
        {
          name: this.name,
          failures: this.state.failures,
          cooldownMs: this.cooldownMs,
          error: err instanceof Error ? err.message : String(err ?? ""),
        },
        "circuit breaker OPEN",
      );
    }
  }

  /** Read-only snapshot for testing/monitoring. */
  getState(): Readonly<CircuitBreakerState> {
    return { ...this.state };
  }

  /** Force reset (for testing). */
  reset(): void {
    this.state = { failures: 0, lastFailure: 0, open: false };
  }
}
