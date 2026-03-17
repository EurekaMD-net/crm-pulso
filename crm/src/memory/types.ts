/**
 * Memory service abstraction — pluggable backend for agent memory.
 *
 * Supports retain (store), recall (search), and reflect (synthesize).
 * Backends: SQLite (fallback) and Hindsight (semantic).
 */

/** Memory bank identifiers for CRM domains. */
export type MemoryBank = "crm-sales" | "crm-accounts" | "crm-team" | "crm-user";

/** Options for storing a memory. */
export interface RetainOptions {
  bank: MemoryBank;
  personaId: string;
  tags?: string[];
  async?: boolean;
}

/** Options for searching memories. */
export interface RecallOptions {
  bank: MemoryBank;
  tags?: string[];
  maxResults?: number;
}

/** Options for synthesizing memories. */
export interface ReflectOptions {
  bank: MemoryBank;
  tags?: string[];
}

/** A retrieved memory item. */
export interface MemoryItem {
  content: string;
  relevance?: number;
  createdAt?: string;
}

/** Pluggable memory service interface. */
export interface MemoryService {
  /** Store a memory observation. */
  retain(content: string, options: RetainOptions): Promise<void>;

  /** Search memories by semantic similarity + keyword match. */
  recall(query: string, options: RecallOptions): Promise<MemoryItem[]>;

  /** Synthesize a reflection from stored memories. */
  reflect(query: string, options: ReflectOptions): Promise<string>;

  /** Check if the backend is operational. */
  isHealthy(): Promise<boolean>;

  /** Backend identifier. */
  readonly backend: "sqlite" | "hindsight";
}
