/**
 * Tool result eviction — writes oversized content to a temp file so the LLM
 * can access it via buscar_documentos instead of losing it to truncation.
 *
 * Ported from mission-control's eviction.ts. Adapted for CRM context:
 * - Uses /tmp/crm-tool-results/ (containers can't write to data/)
 * - Preview includes markdown TOC for large documents
 * - Probabilistic cleanup (10% of evictions) to avoid I/O on every call
 */

import {
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const EVICT_DIR = join("/tmp", "crm-tool-results");
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_PROBABILITY = 0.1;

/** Default threshold for eviction (chars). */
export const EVICTION_THRESHOLD = 8_000;

/**
 * Evict oversized content to a temp file. Returns a truncated preview with
 * a table of contents and a file path.
 *
 * On filesystem errors, falls back to simple head truncation (no file).
 */
export function evictToFile(
  content: string,
  filenamePrefix: string,
  maxPreviewChars = 2_000,
): { preview: string; filePath: string | undefined } {
  if (Math.random() < CLEANUP_PROBABILITY) {
    cleanupOldFiles();
  }

  let filePath: string | undefined;
  try {
    mkdirSync(EVICT_DIR, { recursive: true });
    const suffix = randomBytes(4).toString("hex");
    filePath = join(EVICT_DIR, `${filenamePrefix}-${Date.now()}-${suffix}.txt`);
    writeFileSync(filePath, content, "utf-8");
  } catch {
    return {
      preview:
        content.slice(0, maxPreviewChars) +
        `\n\n... (${content.length} chars total — truncated, file eviction failed)`,
      filePath: undefined,
    };
  }

  // Build table of contents from markdown headings
  const headings = content
    .split("\n")
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((h) => h.replace(/^#+\s*/, "").trim())
    .slice(0, 30);
  const toc =
    headings.length > 0
      ? `\n\nTABLE OF CONTENTS (${headings.length} sections):\n${headings.map((h) => `- ${h}`).join("\n")}`
      : "";

  const preview =
    content.slice(0, maxPreviewChars) +
    `\n\n--- DOCUMENT TRUNCATED (${content.length} chars total) ---` +
    `\nFull content saved to: ${filePath}` +
    toc;

  return { preview, filePath };
}

/**
 * Check if a tool result already contains a file eviction path.
 */
export function hasEvictedPath(result: string): boolean {
  return result.includes("crm-tool-results/");
}

/**
 * Conditionally evict a tool result if it exceeds the threshold.
 * Returns the original result if under threshold, or evicted preview if over.
 */
export function maybeEvict(
  result: string,
  toolName: string,
  threshold = EVICTION_THRESHOLD,
): string {
  if (result.length <= threshold || hasEvictedPath(result)) {
    return result;
  }
  const { preview } = evictToFile(result, toolName);
  return preview;
}

function cleanupOldFiles(): void {
  try {
    const files = readdirSync(EVICT_DIR);
    const now = Date.now();
    for (const file of files) {
      try {
        const fullPath = join(EVICT_DIR, file);
        const stat = statSync(fullPath);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          unlinkSync(fullPath);
        }
      } catch {
        /* ignore per-file errors */
      }
    }
  } catch {
    /* directory doesn't exist yet */
  }
}
