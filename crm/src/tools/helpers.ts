/**
 * Shared tool helpers
 */

import { getDatabase } from '../db.js';

export function getPersonaEmail(personaId: string): string | null {
  const db = getDatabase();
  const row = db.prepare('SELECT email FROM persona WHERE id = ?').get(personaId) as any;
  return row?.email ?? null;
}
