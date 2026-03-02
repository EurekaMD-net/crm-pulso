/**
 * Hierarchy Helpers
 *
 * Utilities for querying the sales team hierarchy from the persona table.
 * Used by IPC handlers, tool functions, and access control checks.
 *
 * Prepared statements are lazily cached on first use for performance.
 */

import type Database from 'better-sqlite3';
import { getDatabase } from '../../engine/src/db.js';

export interface Persona {
  id: string;
  nombre: string;
  rol: 'ae' | 'gerente' | 'director' | 'vp';
  reporta_a: string | null;
  whatsapp_group_folder: string | null;
  email: string | null;
  google_calendar_id: string | null;
  telefono: string | null;
  activo: number;
}

// --- Lazy statement cache ---

let _stmts: ReturnType<typeof buildStatements> | null = null;

function stmts() {
  if (!_stmts) _stmts = buildStatements();
  return _stmts;
}

function buildStatements() {
  const db = getDatabase();
  return {
    getByGroupFolder: db.prepare(
      'SELECT * FROM persona WHERE whatsapp_group_folder = ? AND activo = 1',
    ),
    getById: db.prepare(
      'SELECT * FROM persona WHERE id = ?',
    ),
    directReports: db.prepare(
      'SELECT * FROM persona WHERE reporta_a = ? AND activo = 1',
    ),
    isManagerOf: db.prepare(
      'SELECT 1 AS ok FROM persona WHERE id = ? AND reporta_a = ?',
    ),
    isDirectorOf: db.prepare(`
      SELECT 1 AS ok FROM persona WHERE id = ? AND (
        reporta_a = ?
        OR EXISTS (
          SELECT 1 FROM persona AS mgr
          WHERE mgr.id = persona.reporta_a AND mgr.reporta_a = ?
        )
      )
    `),
    isVp: db.prepare(
      "SELECT 1 AS ok FROM persona WHERE id = ? AND rol = 'vp'",
    ),
    subtree: db.prepare(`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM persona WHERE reporta_a = ? AND activo = 1
        UNION ALL
        SELECT p.id FROM persona p
        JOIN subtree s ON p.reporta_a = s.id
        WHERE p.activo = 1
      )
      SELECT p.* FROM persona p
      JOIN subtree s ON p.id = s.id
    `),
    role: db.prepare(
      'SELECT rol FROM persona WHERE id = ?',
    ),
    manager: db.prepare(
      'SELECT reporta_a FROM persona WHERE id = ?',
    ),
    directorOf: db.prepare(`
      SELECT CASE
        WHEN p.rol = 'director' THEN p.id
        WHEN mgr.rol = 'director' THEN mgr.id
        WHEN dir.rol = 'director' THEN dir.id
        ELSE NULL
      END AS director_id
      FROM persona p
      LEFT JOIN persona mgr ON p.reporta_a = mgr.id
      LEFT JOIN persona dir ON mgr.reporta_a = dir.id
      WHERE p.id = ?
    `),
  };
}

/** @internal Reset cached statements when the database instance changes (tests only). */
export function _resetStatementCache(): void {
  _stmts = null;
}

/** Get a persona by their WhatsApp group folder. */
export function getPersonByGroupFolder(groupFolder: string): Persona | undefined {
  return stmts().getByGroupFolder.get(groupFolder) as Persona | undefined;
}

/** Get a persona by ID. */
export function getPersonById(id: string): Persona | undefined {
  return stmts().getById.get(id) as Persona | undefined;
}

/** Get direct report IDs for a manager/director/VP. */
export function getTeamIds(personaId: string): string[] {
  const reports = stmts().directReports.all(personaId) as Persona[];
  return reports.map(p => p.id);
}

/** Get all descendant IDs (recursive subtree). */
export function getFullTeamIds(personaId: string): string[] {
  const subtree = stmts().subtree.all(personaId) as Persona[];
  return subtree.map(p => p.id);
}

/** Get all direct reports as full Persona objects. */
export function getDirectReports(managerId: string): Persona[] {
  return stmts().directReports.all(managerId) as Persona[];
}

/** Get role for a persona. */
export function getRole(personaId: string): 'ae' | 'gerente' | 'director' | 'vp' | null {
  const row = stmts().role.get(personaId) as { rol: string } | undefined;
  return (row?.rol as Persona['rol']) ?? null;
}

/** Get direct manager ID. */
export function getManager(personaId: string): string | null {
  const row = stmts().manager.get(personaId) as { reporta_a: string | null } | undefined;
  return row?.reporta_a ?? null;
}

/** Get director ID (walks up to 3 levels). */
export function getDirector(personaId: string): string | null {
  const row = stmts().directorOf.get(personaId) as { director_id: string | null } | undefined;
  return row?.director_id ?? null;
}

/** Check if personA is the direct manager of personB. */
export function isManagerOf(managerId: string, reportId: string): boolean {
  const row = stmts().isManagerOf.get(reportId, managerId) as { ok: number } | undefined;
  return row !== undefined;
}

/** Check if personA is a director over personB (one or two levels up). */
export function isDirectorOf(directorId: string, personId: string): boolean {
  const row = stmts().isDirectorOf.get(personId, directorId, directorId) as { ok: number } | undefined;
  return row !== undefined;
}

/** Check if a persona is a VP. */
export function isVp(personId: string): boolean {
  const row = stmts().isVp.get(personId) as { ok: number } | undefined;
  return row !== undefined;
}

/** Get all people in a manager's subtree (recursive). */
export function getSubtree(rootId: string): Persona[] {
  return stmts().subtree.all(rootId) as Persona[];
}

/** Check if sourceGroup has access to data owned by targetPersonId. */
export function hasAccessTo(sourceGroupFolder: string, targetPersonId: string): boolean;
export function hasAccessTo(source: Persona, targetPersonId: string): boolean;
export function hasAccessTo(sourceOrFolder: string | Persona, targetPersonId: string): boolean {
  const source = typeof sourceOrFolder === 'string'
    ? getPersonByGroupFolder(sourceOrFolder)
    : sourceOrFolder;
  if (!source) return false;

  if (source.id === targetPersonId) return true;
  if (source.rol === 'gerente') return isManagerOf(source.id, targetPersonId);
  if (source.rol === 'director') return isDirectorOf(source.id, targetPersonId);
  if (source.rol === 'vp') return true;

  return false;
}
