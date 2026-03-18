import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 *
 * File content is cached for 60s to avoid re-reading disk on every
 * container spawn (~30+/day per group).
 */

let cachedContent: string | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000;

function getEnvContent(): string | null {
  const now = Date.now();
  if (cachedContent !== null && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedContent;
  }
  const envFile = path.join(process.cwd(), '.env');
  try {
    cachedContent = fs.readFileSync(envFile, 'utf-8');
    cacheTimestamp = now;
    return cachedContent;
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    cachedContent = null;
    return null;
  }
}

export function readEnvFile(keys: string[]): Record<string, string> {
  const content = getEnvContent();
  if (!content) return {};

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
