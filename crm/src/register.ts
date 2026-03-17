/**
 * Batch Hierarchy Registration
 *
 * Registers sales team members from a CSV or JSON file.
 * Creates persona records and corresponding WhatsApp group folder templates.
 */

import fs from "fs";
import path from "path";
import { getDatabase } from "./db.js";
import { logger } from "./logger.js";

export interface TeamMember {
  name: string;
  role: "ae" | "gerente" | "director" | "vp";
  phone: string;
  email?: string;
  calendar_id?: string;
  manager_name?: string;
}

interface RegisteredMember extends TeamMember {
  id: string;
  folder: string;
}

const ROLE_ORDER: Record<string, number> = {
  vp: 0,
  director: 1,
  gerente: 2,
  ae: 3,
};

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Remove accents and normalize to ASCII lowercase. */
function normalize(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Generate group folder name: role-firstname-lastname */
export function generateGroupFolder(name: string, role: string): string {
  const parts = normalize(name).split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error(`Invalid name: "${name}"`);
  const firstName = parts[0];
  const lastName = parts[parts.length - 1];
  return `${role}-${firstName}-${lastName}`;
}

/** Parse a CSV string into TeamMember[]. Expects header row. */
export function parseCsv(content: string): TeamMember[] {
  const lines = content
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2)
    throw new Error("CSV must have a header row and at least one data row");

  const header = lines[0]
    .toLowerCase()
    .split(",")
    .map((h) => h.replace(/"/g, "").trim());
  const nameIdx = header.indexOf("name");
  const roleIdx = header.indexOf("role");
  const phoneIdx = header.indexOf("phone");
  const emailIdx = header.indexOf("email");
  const calendarIdx = header.indexOf("calendar_id");
  const managerIdx = header.indexOf("manager_name");

  if (nameIdx === -1 || roleIdx === -1 || phoneIdx === -1) {
    throw new Error("CSV must have name, role, and phone columns");
  }

  return lines.slice(1).map((line, i) => {
    // Simple CSV parse (handles quoted fields with commas)
    const fields = parseCsvLine(line);
    const role = fields[roleIdx]?.trim().toLowerCase();
    if (!["ae", "gerente", "director", "vp"].includes(role)) {
      throw new Error(`Invalid role "${role}" at row ${i + 2}`);
    }
    return {
      name: fields[nameIdx]?.trim(),
      role: role as TeamMember["role"],
      phone: fields[phoneIdx]?.trim(),
      email: emailIdx >= 0 ? fields[emailIdx]?.trim() || undefined : undefined,
      calendar_id:
        calendarIdx >= 0 ? fields[calendarIdx]?.trim() || undefined : undefined,
      manager_name:
        managerIdx >= 0 ? fields[managerIdx]?.trim() || undefined : undefined,
    };
  });
}

/** Parse a single CSV line handling quoted fields. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

/** Parse a JSON file into TeamMember[]. */
export function parseJson(content: string): TeamMember[] {
  const data = JSON.parse(content);
  if (!Array.isArray(data))
    throw new Error("JSON must be an array of team members");
  return data.map((m: any, i: number) => {
    if (!m.name || !m.role || !m.phone) {
      throw new Error(`Missing required fields at index ${i}`);
    }
    const role = m.role.toLowerCase();
    if (!["ae", "gerente", "director", "vp"].includes(role)) {
      throw new Error(`Invalid role "${m.role}" at index ${i}`);
    }
    return {
      name: m.name,
      role: role as TeamMember["role"],
      phone: m.phone,
      email: m.email || undefined,
      calendar_id: m.calendar_id || undefined,
      manager_name: m.manager_name || undefined,
    };
  });
}

/** Parse team file (CSV or JSON). */
export function parseTeamFile(filePath: string): TeamMember[] {
  const content = fs.readFileSync(filePath, "utf-8");
  if (filePath.endsWith(".json")) return parseJson(content);
  return parseCsv(content);
}

/** Sort members VP→Director→Gerente→AE for insertion order. */
export function resolveHierarchy(members: TeamMember[]): TeamMember[] {
  return [...members].sort(
    (a, b) => (ROLE_ORDER[a.role] ?? 99) - (ROLE_ORDER[b.role] ?? 99),
  );
}

/** Copy role template to group folder if template exists. */
export function copyRoleTemplate(
  groupDir: string,
  role: string,
  templatesDir: string,
): void {
  const templatePath = path.join(templatesDir, `${role}.md`);
  const globalPath = path.join(templatesDir, "global.md");
  const destClaude = path.join(groupDir, "CLAUDE.md");

  let content = "";
  if (fs.existsSync(globalPath)) {
    content += fs.readFileSync(globalPath, "utf-8") + "\n\n";
  }
  if (fs.existsSync(templatePath)) {
    content += fs.readFileSync(templatePath, "utf-8");
  }

  if (content) {
    fs.writeFileSync(destClaude, content);
  }
}

/** Register a full team from file. Returns registered members with IDs. */
export function registerTeamFromFile(
  filePath: string,
  groupsBaseDir?: string,
): RegisteredMember[] {
  const members = parseTeamFile(filePath);
  return registerTeam(members, groupsBaseDir);
}

/** Register a team from parsed members. */
export function registerTeam(
  members: TeamMember[],
  groupsBaseDir?: string,
): RegisteredMember[] {
  const db = getDatabase();
  const sorted = resolveHierarchy(members);
  const nameToId = new Map<string, string>();
  const registered: RegisteredMember[] = [];

  const insertPersona = db.prepare(`
    INSERT OR IGNORE INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, email, calendar_id, telefono, activo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const insertAll = db.transaction(() => {
    for (const member of sorted) {
      const id = genId(member.role);
      const folder = generateGroupFolder(member.name, member.role);
      const managerId = member.manager_name
        ? (nameToId.get(normalize(member.manager_name)) ?? null)
        : null;

      insertPersona.run(
        id,
        member.name,
        member.role,
        managerId,
        folder,
        member.email ?? null,
        member.calendar_id ?? null,
        member.phone,
      );

      nameToId.set(normalize(member.name), id);

      // Create group folder if base dir specified
      if (groupsBaseDir) {
        const groupDir = path.join(groupsBaseDir, folder);
        fs.mkdirSync(groupDir, { recursive: true });
        const templatesDir = path.join(
          path.dirname(groupsBaseDir),
          "crm",
          "groups",
        );
        if (fs.existsSync(templatesDir)) {
          copyRoleTemplate(groupDir, member.role, templatesDir);
        }
      }

      registered.push({ ...member, id, folder });
    }
  });

  insertAll();
  logger.info({ count: registered.length }, "Team registered");
  return registered;
}
