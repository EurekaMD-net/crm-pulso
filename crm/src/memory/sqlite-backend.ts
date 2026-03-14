/**
 * SQLite memory backend — fallback when Hindsight is unavailable.
 *
 * Uses crm_memories table for basic store/retrieve.
 * No semantic search — recall returns recent matches via LIKE.
 * Reflect is a no-op (no synthesis without LLM).
 */

import { getDatabase } from "../db.js";
import type {
  MemoryService,
  MemoryItem,
  RetainOptions,
  RecallOptions,
  ReflectOptions,
} from "./types.js";

export class SqliteMemoryBackend implements MemoryService {
  readonly backend = "sqlite" as const;

  async retain(content: string, options: RetainOptions): Promise<void> {
    try {
      const db = getDatabase();
      const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const etiquetas = options.tags?.length
        ? JSON.stringify(options.tags)
        : null;
      db.prepare(
        "INSERT INTO crm_memories (id, persona_id, banco, contenido, etiquetas) VALUES (?, ?, ?, ?, ?)",
      ).run(id, options.personaId, options.bank, content, etiquetas);
    } catch {
      // Best-effort — DB may not be initialized in tests
    }
  }

  async recall(query: string, options: RecallOptions): Promise<MemoryItem[]> {
    try {
      const db = getDatabase();
      const limit = options.maxResults ?? 10;
      // Simple keyword match + recency sort
      const rows = db
        .prepare(
          "SELECT contenido, fecha_creacion FROM crm_memories " +
            "WHERE banco = ? AND contenido LIKE ? " +
            "ORDER BY fecha_creacion DESC LIMIT ?",
        )
        .all(options.bank, `%${query}%`, limit) as Array<{
        contenido: string;
        fecha_creacion: string;
      }>;
      return rows.map((r) => ({
        content: r.contenido,
        createdAt: r.fecha_creacion,
      }));
    } catch {
      return [];
    }
  }

  async reflect(_query: string, _options: ReflectOptions): Promise<string> {
    // SQLite backend doesn't support synthesis
    return "";
  }

  async isHealthy(): Promise<boolean> {
    try {
      getDatabase();
      return true;
    } catch {
      return false;
    }
  }
}
