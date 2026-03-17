/**
 * User Profile Tools
 *
 * actualizar_perfil — updates structured profile fields for the current user
 * getUserProfile — retrieves profile for system prompt injection
 * formatProfileSection — formats profile as compact system prompt section
 */

import { getDatabase } from "../db.js";
import type Database from "better-sqlite3";
import type { ToolContext } from "./index.js";

// ---------------------------------------------------------------------------
// Profile fields
// ---------------------------------------------------------------------------

const VALID_CAMPOS = [
  "estilo_comunicacion",
  "preferencias_briefing",
  "horario_trabajo",
  "datos_personales",
  "motivadores",
  "notas",
] as const;

type ProfileField = (typeof VALID_CAMPOS)[number];

const CAMPO_LABELS: Record<ProfileField, string> = {
  estilo_comunicacion: "Estilo",
  preferencias_briefing: "Briefing",
  horario_trabajo: "Horario",
  datos_personales: "Personal",
  motivadores: "Motivadores",
  notas: "Notas",
};

// ---------------------------------------------------------------------------
// getUserProfile — for system prompt injection
// ---------------------------------------------------------------------------

export interface UserProfile {
  estilo_comunicacion?: string;
  preferencias_briefing?: string;
  horario_trabajo?: string;
  datos_personales?: string;
  motivadores?: string;
  notas?: string;
}

export function getUserProfile(
  db: Database.Database,
  personaId: string,
): UserProfile | null {
  const row = db
    .prepare("SELECT * FROM perfil_usuario WHERE persona_id = ?")
    .get(personaId) as any;

  if (!row) return null;

  const profile: UserProfile = {};
  let hasField = false;

  for (const campo of VALID_CAMPOS) {
    if (row[campo]) {
      (profile as any)[campo] = row[campo];
      hasField = true;
    }
  }

  return hasField ? profile : null;
}

// ---------------------------------------------------------------------------
// formatProfileSection — compact system prompt section
// ---------------------------------------------------------------------------

export function formatProfileSection(profile: UserProfile): string {
  const lines: string[] = ["## Tu Usuario"];

  for (const campo of VALID_CAMPOS) {
    const value = profile[campo];
    if (value) {
      lines.push(`${CAMPO_LABELS[campo]}: ${value}`);
    }
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

// ---------------------------------------------------------------------------
// actualizar_perfil — tool handler
// ---------------------------------------------------------------------------

export function actualizar_perfil(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const campo = args.campo as string;
  const valor = args.valor as string;

  if (!campo || !VALID_CAMPOS.includes(campo as ProfileField)) {
    return JSON.stringify({
      error: `Campo invalido. Campos validos: ${VALID_CAMPOS.join(", ")}`,
    });
  }

  if (!valor || typeof valor !== "string") {
    return JSON.stringify({ error: 'Se requiere el parametro "valor".' });
  }

  const db = getDatabase();

  // Upsert: create row if not exists, update single field + timestamp
  const existing = db
    .prepare("SELECT persona_id FROM perfil_usuario WHERE persona_id = ?")
    .get(ctx.persona_id);

  if (existing) {
    db.prepare(
      `UPDATE perfil_usuario SET ${campo} = ?, fecha_actualizacion = datetime('now') WHERE persona_id = ?`,
    ).run(valor, ctx.persona_id);
  } else {
    db.prepare(
      `INSERT INTO perfil_usuario (persona_id, ${campo}, fecha_actualizacion) VALUES (?, ?, datetime('now'))`,
    ).run(ctx.persona_id, valor);
  }

  return JSON.stringify({
    mensaje: `Perfil actualizado: ${CAMPO_LABELS[campo as ProfileField]} = "${valor}"`,
  });
}
