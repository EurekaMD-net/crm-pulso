/**
 * CRM IPC Handlers
 *
 * Handles CRM-specific IPC task types delegated from engine/src/ipc.ts.
 * The engine calls processCrmIpc() for any IPC type it doesn't recognize.
 */

import { getDatabase } from '../../engine/src/db.js';
import { getPersonByGroupFolder, hasAccessTo } from './hierarchy.js';
import type { IpcDeps } from '../../engine/src/ipc.js';

// TODO: Import logger from engine when available
const log = (msg: string) => console.log(`[crm-ipc] ${msg}`);

// --- Input validation helpers ---

const VALID_INTERACTION_TYPES = new Set(['call', 'meeting', 'email', 'whatsapp', 'event', 'other']);
const VALID_STAGES = new Set(['prospecting', 'qualification', 'proposal', 'negotiation', 'closed_won', 'closed_lost']);
const VALID_PRIORITIES = new Set(['low', 'medium', 'high']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/;

function validateEnum(value: unknown, allowed: Set<string>, fallback: string): string {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function validateDate(value: unknown): string | null {
  return typeof value === 'string' && ISO_DATE_RE.test(value) ? value : null;
}

function validateNumber(value: unknown, min: number, max = Infinity): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

export async function processCrmIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  _deps: IpcDeps,
): Promise<boolean> {
  const db = getDatabase();

  switch (data.type) {
    case 'crm_log_interaction': {
      const person = getPersonByGroupFolder(sourceGroup);
      if (!person) {
        log(`Unknown person for group ${sourceGroup}`);
        return true;
      }

      const id = `int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO crm_interactions (id, account_id, contact_id, opportunity_id, person_id, type, summary, outcome, follow_up_date, follow_up_action, logged_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        (data.account_id as string) || null,
        (data.contact_id as string) || null,
        (data.opportunity_id as string) || null,
        person.id,
        validateEnum(data.interaction_type, VALID_INTERACTION_TYPES, 'other'),
        (data.summary as string) || '',
        (data.outcome as string) || null,
        validateDate(data.follow_up_date),
        (data.follow_up_action as string) || null,
        now, // always use server-side timestamp — agents must not backdate records
        now,
      );

      log(`Interaction logged: ${id} by ${person.name}`);
      return true;
    }

    case 'crm_update_opportunity': {
      const person = getPersonByGroupFolder(sourceGroup);
      if (!person) return true;

      const oppId = data.opportunity_id as string;
      if (!oppId) return true;

      // Fetch opportunity to verify ownership before applying any changes
      const opp = db.prepare('SELECT owner_id FROM crm_opportunities WHERE id = ?')
        .get(oppId) as { owner_id: string } | undefined;
      if (!opp) return true;
      if (!hasAccessTo(sourceGroup, opp.owner_id)) {
        log(`Access denied: ${sourceGroup} cannot update opportunity ${oppId}`);
        return true;
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      // For UPDATE fields: null means "absent or invalid — skip this column"
      const stage = typeof data.stage === 'string' && VALID_STAGES.has(data.stage) ? data.stage : null;
      if (stage !== null) { updates.push('stage = ?'); values.push(stage); }

      const amount = validateNumber(data.amount, 0);
      if (amount !== null) { updates.push('amount = ?'); values.push(amount); }

      const probability = validateNumber(data.probability, 0, 100);
      if (probability !== null) { updates.push('probability = ?'); values.push(probability); }

      const closeDate = validateDate(data.close_date);
      if (closeDate !== null) { updates.push('close_date = ?'); values.push(closeDate); }

      if (data.notes) { updates.push('notes = ?'); values.push(data.notes); }

      if (updates.length > 0) {
        updates.push('updated_at = ?');
        values.push(new Date().toISOString());
        values.push(oppId);
        db.prepare(`UPDATE crm_opportunities SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        log(`Opportunity updated: ${oppId} by ${person.name}`);
      }

      return true;
    }

    case 'crm_create_task': {
      const person = getPersonByGroupFolder(sourceGroup);
      if (!person) return true;

      const id = `crmt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO crm_tasks_crm (id, person_id, account_id, opportunity_id, title, description, due_date, priority, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        id,
        person.id,
        (data.account_id as string) || null,
        (data.opportunity_id as string) || null,
        (data.title as string) || 'Follow up',
        (data.description as string) || null,
        validateDate(data.due_date),
        validateEnum(data.priority, VALID_PRIORITIES, 'medium'),
        now,
      );

      log(`CRM task created: ${id} by ${person.name}`);
      return true;
    }

    default:
      return false; // Not a CRM IPC type
  }
}
