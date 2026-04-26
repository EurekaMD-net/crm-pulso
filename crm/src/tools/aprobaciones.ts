/**
 * Approval Workflow Tool Handlers
 *
 * 6 handlers for the record creation approval workflow:
 *   solicitar_cuenta    — Create new account (estado based on creator role)
 *   solicitar_contacto  — Create new contact on an account
 *   aprobar_registro    — Advance pending record to next state
 *   rechazar_registro   — Delete pending record + notify creator
 *   consultar_pendientes — List pending approvals for caller's scope
 *   impugnar_registro   — Challenge activo_en_revision record within 24h
 *
 * Approval chain (with cascading assignment):
 *   AE creates      → pendiente_gerente → Ger approves → pendiente_director → Dir approves → activo_en_revision → 24h → activo
 *   Gerente creates (assigns AE)  → pendiente_director → Dir approves → activo_en_revision → 24h → activo
 *   Director creates (assigns Ger) → pendiente_gerente → Ger approves+assigns AE → activo_en_revision → 24h → activo
 *   VP creates (assigns Dir)       → pendiente_director → Dir approves+assigns Ger → pendiente_gerente → Ger approves+assigns AE → activo_en_revision → 24h → activo
 */

import fs from "fs";
import path from "path";
import { getDatabase } from "../db.js";
import { getPersonById, getManager, getDirector } from "../hierarchy.js";
import type { ToolContext } from "./index.js";
import { findCuentaId, scopeFilter } from "./helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROLE_RANK: Record<string, number> = {
  ae: 0,
  gerente: 1,
  director: 2,
  vp: 3,
};

type EntidadTipo = "cuenta" | "contacto";

/**
 * Allowlist for table names embedded in approval-flow SQL via string
 * interpolation. SQLite cannot bind table names — only values — so the only
 * safe pattern is an explicit allowlist. Inline `entidadTipo === "cuenta"`
 * guards exist below as defense-in-depth, but every interpolation site must
 * resolve through this map. If you add a new approvable entity, add it here
 * AND extend the EntidadTipo union.
 */
const APPROVAL_TABLES = {
  cuenta: "cuenta",
  contacto: "contacto",
} as const satisfies Record<EntidadTipo, string>;

function resolveApprovalTable(tipo: unknown): string | null {
  if (typeof tipo !== "string") return null;
  return (APPROVAL_TABLES as Record<string, string>)[tipo] ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Determine initial estado based on creator role.
 *  Director/VP now start in pending states because they must cascade
 *  assignment down (gerente→AE / director→gerente→AE). */
function initialEstado(rol: string): string {
  switch (rol) {
    case "ae":
      return "pendiente_gerente";
    case "gerente":
      return "pendiente_director";
    case "director":
      return "pendiente_gerente"; // gerente must assign AE
    case "vp":
      return "pendiente_director"; // director must assign gerente, then gerente assigns AE
    default:
      return "pendiente_gerente";
  }
}

/** Resolve a persona by fuzzy name + expected role. Returns {id, nombre} or null. */
function resolvePersona(
  nombre: string,
  rolEsperado: string,
): { id: string; nombre: string } | null {
  const db = getDatabase();
  const row = db
    .prepare(
      "SELECT id, nombre FROM persona WHERE nombre LIKE ? AND rol = ? AND activo = 1",
    )
    .get(`%${nombre}%`, rolEsperado) as any;
  return row ?? null;
}

/** Determine next estado after approval. */
function nextEstado(currentEstado: string): string | null {
  switch (currentEstado) {
    case "pendiente_gerente":
      return "pendiente_director";
    case "pendiente_director":
      return "activo_en_revision";
    case "disputado":
      return "activo";
    default:
      return null;
  }
}

/** Check if the approver has sufficient rank to approve from a given estado. */
function canApprove(approverRol: string, estado: string): boolean {
  const rank = ROLE_RANK[approverRol] ?? -1;
  switch (estado) {
    case "pendiente_gerente":
      return rank >= ROLE_RANK.gerente;
    case "pendiente_director":
      return rank >= ROLE_RANK.director;
    case "disputado":
      return rank >= ROLE_RANK.director;
    default:
      return false;
  }
}

/** Write an IPC task file for approval notifications. */
function writeApprovalNotification(
  targets: string[] | "__ALL__",
  text: string,
): void {
  const ipcDir = path.resolve("data/ipc/main/tasks");
  fs.mkdirSync(ipcDir, { recursive: true });
  const filename = `aprob-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  const payload = {
    type: "crm_approval_notification",
    target_folders: targets,
    text,
  };
  fs.writeFileSync(path.join(ipcDir, filename), JSON.stringify(payload));
}

/** Log an approval action. */
function logAprobacion(
  db: ReturnType<typeof getDatabase>,
  entidadTipo: EntidadTipo,
  entidadId: string,
  accion: string,
  actorId: string,
  actorRol: string,
  estadoAnterior: string | null,
  estadoNuevo: string,
  motivo?: string,
): void {
  db.prepare(
    `INSERT INTO aprobacion_registro (id, entidad_tipo, entidad_id, accion, actor_id, actor_rol, estado_anterior, estado_nuevo, motivo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    genId("apr"),
    entidadTipo,
    entidadId,
    accion,
    actorId,
    actorRol,
    estadoAnterior,
    estadoNuevo,
    motivo ?? null,
  );
}

/** Get the group folder for a persona. */
function folderOf(personaId: string | null): string | null {
  if (!personaId) return null;
  const p = getPersonById(personaId);
  return p?.whatsapp_group_folder ?? null;
}

/** Resolve notification targets based on estado transition. */
function getNotificationTargets(
  estadoNuevo: string,
  creadorId: string,
): string[] | "__ALL__" {
  if (estadoNuevo === "activo_en_revision" || estadoNuevo === "activo") {
    return "__ALL__";
  }
  if (estadoNuevo === "pendiente_gerente") {
    const mgrId = getManager(creadorId);
    const folder = folderOf(mgrId);
    return folder ? [folder] : [];
  }
  if (estadoNuevo === "pendiente_director") {
    const dirId = getDirector(creadorId);
    const folder = folderOf(dirId);
    return folder ? [folder] : [];
  }
  if (estadoNuevo === "disputado") {
    // Notify director of the creator
    const dirId = getDirector(creadorId);
    const folder = folderOf(dirId);
    return folder ? [folder] : [];
  }
  return [];
}

// ---------------------------------------------------------------------------
// solicitar_cuenta
// ---------------------------------------------------------------------------

export function solicitar_cuenta(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();
  const nombre = (args.nombre as string)?.trim();
  if (!nombre) {
    return JSON.stringify({ error: "El nombre de la cuenta es requerido." });
  }

  const tipo = args.tipo === "agencia" ? "agencia" : "directo";
  const vertical = (args.vertical as string) ?? null;
  const holdingAgencia = (args.holding_agencia as string) ?? null;
  const agenciaMedias = (args.agencia_medios as string) ?? null;
  const notas = (args.notas as string) ?? null;

  // Check for duplicates (active or pending)
  const existing = db
    .prepare("SELECT id, nombre, estado FROM cuenta WHERE nombre LIKE ?")
    .get(`%${nombre}%`) as any;
  if (existing) {
    return JSON.stringify({
      error: `Ya existe una cuenta similar: "${existing.nombre}" (estado: ${existing.estado}). No se puede crear duplicado.`,
    });
  }

  // --- Cascading assignment: each level assigns the next level down ---
  let aeId: string | null = null;
  let gerenteId: string | null = null;
  let directorId: string | null = null;
  let assignedNotifyFolder: string | null = null; // direct target for notification

  if (ctx.rol === "ae") {
    aeId = ctx.persona_id;
  } else if (ctx.rol === "gerente") {
    const ejNombre = (args.ejecutivo_nombre as string)?.trim();
    if (!ejNombre) {
      return JSON.stringify({
        error:
          "Como gerente, debes especificar ejecutivo_nombre (el Ejecutivo que manejara la cuenta).",
      });
    }
    const resolved = resolvePersona(ejNombre, "ae");
    if (!resolved) {
      return JSON.stringify({
        error: `No encontre un Ejecutivo activo con nombre "${ejNombre}".`,
      });
    }
    aeId = resolved.id;
    gerenteId = ctx.persona_id;
  } else if (ctx.rol === "director") {
    const gerNombre = (args.gerente_nombre as string)?.trim();
    if (!gerNombre) {
      return JSON.stringify({
        error:
          "Como director, debes especificar gerente_nombre (el Gerente que supervisara la cuenta). El Gerente asignara al Ejecutivo.",
      });
    }
    const resolved = resolvePersona(gerNombre, "gerente");
    if (!resolved) {
      return JSON.stringify({
        error: `No encontre un Gerente activo con nombre "${gerNombre}".`,
      });
    }
    gerenteId = resolved.id;
    directorId = ctx.persona_id;
    assignedNotifyFolder = folderOf(resolved.id);
  } else if (ctx.rol === "vp") {
    const dirNombre = (args.director_nombre as string)?.trim();
    if (!dirNombre) {
      return JSON.stringify({
        error:
          "Como VP, debes especificar director_nombre (el Director que supervisara la cuenta). El asignara Gerente y Ejecutivo.",
      });
    }
    const resolved = resolvePersona(dirNombre, "director");
    if (!resolved) {
      return JSON.stringify({
        error: `No encontre un Director activo con nombre "${dirNombre}".`,
      });
    }
    directorId = resolved.id;
    assignedNotifyFolder = folderOf(resolved.id);
  }

  const id = genId("cta");
  const estado = initialEstado(ctx.rol);
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO cuenta (id, nombre, tipo, vertical, holding_agencia, agencia_medios, ae_id, gerente_id, director_id, creado_por, estado, notas, fecha_creacion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    nombre,
    tipo,
    vertical,
    holdingAgencia,
    agenciaMedias,
    aeId,
    gerenteId,
    directorId,
    ctx.persona_id,
    estado,
    notas,
    now,
  );

  logAprobacion(
    db,
    "cuenta",
    id,
    "creado",
    ctx.persona_id,
    ctx.rol,
    null,
    estado,
  );

  // Notify — target the assigned person for Director/VP cases
  const creatorName = getPersonById(ctx.persona_id)?.nombre ?? "Desconocido";
  const msg =
    `*Nueva cuenta solicitada*\n\n` +
    `\u2022 Cuenta: ${nombre}\n` +
    `\u2022 Tipo: ${tipo}\n` +
    `\u2022 Creada por: ${creatorName} (${ctx.rol})\n` +
    `\u2022 Estado: ${estado}\n` +
    `\nRequiere aprobacion y asignacion de Ejecutivo.`;

  const targets: string[] | "__ALL__" = assignedNotifyFolder
    ? [assignedNotifyFolder]
    : getNotificationTargets(estado, ctx.persona_id);
  if (targets === "__ALL__" || (Array.isArray(targets) && targets.length > 0)) {
    writeApprovalNotification(targets, msg);
  }

  return JSON.stringify({
    mensaje: `Cuenta "${nombre}" creada con estado "${estado}". Pendiente de aprobacion.`,
    cuenta_id: id,
    estado,
  });
}

// ---------------------------------------------------------------------------
// solicitar_contacto
// ---------------------------------------------------------------------------

export function solicitar_contacto(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();
  const nombre = (args.nombre as string)?.trim();
  if (!nombre) {
    return JSON.stringify({ error: "El nombre del contacto es requerido." });
  }

  // Resolve cuenta
  const cuentaNombre = args.cuenta_nombre as string;
  const cuentaId = cuentaNombre ? findCuentaId(cuentaNombre) : null;
  if (cuentaNombre && !cuentaId) {
    return JSON.stringify({
      error: `No encontre la cuenta "${cuentaNombre}".`,
    });
  }

  const rol = (args.rol as string) ?? null;
  const seniority = (args.seniority as string) ?? null;
  const telefono = (args.telefono as string) ?? null;
  const email = (args.email as string) ?? null;
  const esAgencia = args.es_agencia ? 1 : 0;
  const notas = (args.notas as string) ?? null;

  // Check for duplicates on the same account
  if (cuentaId) {
    const existing = db
      .prepare(
        "SELECT id, nombre, estado FROM contacto WHERE cuenta_id = ? AND nombre LIKE ?",
      )
      .get(cuentaId, `%${nombre}%`) as any;
    if (existing) {
      return JSON.stringify({
        error: `Ya existe un contacto similar en esta cuenta: "${existing.nombre}" (estado: ${existing.estado}).`,
      });
    }
  }

  const id = genId("cont");
  const estado = initialEstado(ctx.rol);

  db.prepare(
    `INSERT INTO contacto (id, nombre, cuenta_id, es_agencia, rol, seniority, telefono, email, notas, creado_por, estado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    nombre,
    cuentaId,
    esAgencia,
    rol,
    seniority,
    telefono,
    email,
    notas,
    ctx.persona_id,
    estado,
  );

  if (estado === "activo" || estado === "activo_en_revision") {
    const now = new Date().toISOString();
    db.prepare("UPDATE contacto SET fecha_activacion = ? WHERE id = ?").run(
      now,
      id,
    );
  }

  logAprobacion(
    db,
    "contacto",
    id,
    "creado",
    ctx.persona_id,
    ctx.rol,
    null,
    estado,
  );

  // Notify
  const creatorName = getPersonById(ctx.persona_id)?.nombre ?? "Desconocido";
  const cuentaLabel = cuentaNombre ?? "sin cuenta";
  const msg =
    `*Nuevo contacto solicitado*\n\n` +
    `\u2022 Contacto: ${nombre}\n` +
    `\u2022 Cuenta: ${cuentaLabel}\n` +
    `\u2022 Creado por: ${creatorName} (${ctx.rol})\n` +
    `\u2022 Estado: ${estado}\n` +
    (estado !== "activo"
      ? `\nRequiere aprobacion.`
      : `\nActivado directamente.`);

  const targets = getNotificationTargets(estado, ctx.persona_id);
  if (targets === "__ALL__" || (Array.isArray(targets) && targets.length > 0)) {
    writeApprovalNotification(targets, msg);
  }

  return JSON.stringify({
    mensaje:
      estado === "activo"
        ? `Contacto "${nombre}" creado y activado directamente.`
        : `Contacto "${nombre}" creado con estado "${estado}". Pendiente de aprobacion.`,
    contacto_id: id,
    estado,
  });
}

// ---------------------------------------------------------------------------
// aprobar_registro
// ---------------------------------------------------------------------------

export function aprobar_registro(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();
  const entidadTipo = args.entidad_tipo as EntidadTipo;
  const entidadId = args.entidad_id as string;

  if (!entidadTipo || !entidadId) {
    return JSON.stringify({
      error:
        "entidad_tipo ('cuenta' o 'contacto') y entidad_id son requeridos.",
    });
  }
  const table = resolveApprovalTable(entidadTipo);
  if (!table) {
    return JSON.stringify({
      error: "entidad_tipo debe ser 'cuenta' o 'contacto'.",
    });
  }

  const row = db
    .prepare(`SELECT id, nombre, estado, creado_por FROM ${table} WHERE id = ?`)
    .get(entidadId) as any;

  if (!row) {
    return JSON.stringify({
      error: `No encontre ${entidadTipo} con id "${entidadId}".`,
    });
  }
  if (!canApprove(ctx.rol, row.estado)) {
    return JSON.stringify({
      error: `No puedes aprobar desde estado "${row.estado}" con rol "${ctx.rol}".`,
    });
  }

  // --- Determine next estado + handle cascading assignment for cuentas ---
  let next: string | null;
  let assignmentSql = "";
  const assignmentParams: unknown[] = [];
  let assignedNotifyFolder: string | null = null;

  if (entidadTipo === "cuenta" && row.estado === "pendiente_gerente") {
    const cuenta = db
      .prepare("SELECT ae_id FROM cuenta WHERE id = ?")
      .get(entidadId) as any;
    if (!cuenta.ae_id) {
      // Cuenta created by director+ → gerente must assign AE now
      const ejNombre = (args.ejecutivo_nombre as string)?.trim();
      if (!ejNombre) {
        return JSON.stringify({
          error:
            "Esta cuenta requiere asignacion de Ejecutivo. Proporciona ejecutivo_nombre.",
        });
      }
      const resolved = resolvePersona(ejNombre, "ae");
      if (!resolved) {
        return JSON.stringify({
          error: `No encontre un Ejecutivo activo con nombre "${ejNombre}".`,
        });
      }
      assignmentSql = ", ae_id = ?";
      assignmentParams.push(resolved.id);
      next = "activo_en_revision"; // skip pendiente_director (creator was director+)
    } else {
      next = "pendiente_director"; // standard AE/Gerente flow
    }
  } else if (entidadTipo === "cuenta" && row.estado === "pendiente_director") {
    const cuenta = db
      .prepare("SELECT gerente_id, director_id FROM cuenta WHERE id = ?")
      .get(entidadId) as any;
    if (!cuenta.gerente_id && cuenta.director_id) {
      // VP-created (director_id set at creation, gerente_id not) → director must assign Gerente now
      const gerNombre = (args.gerente_nombre as string)?.trim();
      if (!gerNombre) {
        return JSON.stringify({
          error:
            "Esta cuenta requiere asignacion de Gerente. Proporciona gerente_nombre.",
        });
      }
      const resolved = resolvePersona(gerNombre, "gerente");
      if (!resolved) {
        return JSON.stringify({
          error: `No encontre un Gerente activo con nombre "${gerNombre}".`,
        });
      }
      assignmentSql = ", gerente_id = ?, director_id = ?";
      assignmentParams.push(resolved.id, ctx.persona_id);
      assignedNotifyFolder = folderOf(resolved.id);
      next = "pendiente_gerente"; // cascade down: gerente must assign AE
    } else {
      next = "activo_en_revision"; // standard
    }
  } else {
    // Contactos + disputado: standard transitions
    next = nextEstado(row.estado);
  }

  if (!next) {
    return JSON.stringify({
      error: `Estado "${row.estado}" no tiene transicion de aprobacion.`,
    });
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE ${table} SET estado = ?${assignmentSql} WHERE id = ?`).run(
    next,
    ...assignmentParams,
    entidadId,
  );

  if (next === "activo_en_revision") {
    db.prepare(`UPDATE ${table} SET fecha_activacion = ? WHERE id = ?`).run(
      now,
      entidadId,
    );
  }

  logAprobacion(
    db,
    entidadTipo,
    entidadId,
    "aprobado",
    ctx.persona_id,
    ctx.rol,
    row.estado,
    next,
  );

  // Notify
  const approverName = getPersonById(ctx.persona_id)?.nombre ?? "Desconocido";
  const label = entidadTipo === "cuenta" ? "Cuenta" : "Contacto";
  const msg =
    `*Registro aprobado*\n\n` +
    `\u2022 ${label}: ${row.nombre}\n` +
    `\u2022 Aprobado por: ${approverName} (${ctx.rol})\n` +
    `\u2022 Nuevo estado: ${next}\n` +
    (next === "activo_en_revision" ? `\nVentana de impugnacion: 24h.` : "");

  const targets: string[] | "__ALL__" = assignedNotifyFolder
    ? [assignedNotifyFolder]
    : getNotificationTargets(next, row.creado_por ?? ctx.persona_id);
  if (targets === "__ALL__" || (Array.isArray(targets) && targets.length > 0)) {
    writeApprovalNotification(targets, msg);
  }

  return JSON.stringify({
    mensaje: `${label} "${row.nombre}" aprobada. Nuevo estado: ${next}.`,
    entidad_id: entidadId,
    estado_nuevo: next,
  });
}

// ---------------------------------------------------------------------------
// rechazar_registro
// ---------------------------------------------------------------------------

export function rechazar_registro(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();
  const entidadTipo = args.entidad_tipo as EntidadTipo;
  const entidadId = args.entidad_id as string;
  const motivo = (args.motivo as string) ?? null;

  if (!entidadTipo || !entidadId) {
    return JSON.stringify({
      error:
        "entidad_tipo ('cuenta' o 'contacto') y entidad_id son requeridos.",
    });
  }
  const table = resolveApprovalTable(entidadTipo);
  if (!table) {
    return JSON.stringify({
      error: "entidad_tipo debe ser 'cuenta' o 'contacto'.",
    });
  }

  const row = db
    .prepare(`SELECT id, nombre, estado, creado_por FROM ${table} WHERE id = ?`)
    .get(entidadId) as any;

  if (!row) {
    return JSON.stringify({
      error: `No encontre ${entidadTipo} con id "${entidadId}".`,
    });
  }

  // Can only reject pending or disputed records
  if (!row.estado.startsWith("pendiente_") && row.estado !== "disputado") {
    return JSON.stringify({
      error: `Solo se pueden rechazar registros pendientes o disputados. Estado actual: "${row.estado}".`,
    });
  }
  if (!canApprove(ctx.rol, row.estado)) {
    return JSON.stringify({
      error: `No puedes rechazar desde estado "${row.estado}" con rol "${ctx.rol}".`,
    });
  }

  logAprobacion(
    db,
    entidadTipo,
    entidadId,
    "rechazado",
    ctx.persona_id,
    ctx.rol,
    row.estado,
    "eliminado",
    motivo ?? undefined,
  );

  // Delete the record
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(entidadId);

  // Notify creator
  const rejecterName = getPersonById(ctx.persona_id)?.nombre ?? "Desconocido";
  const creatorFolder = folderOf(row.creado_por);
  if (creatorFolder) {
    const msg =
      `*Registro rechazado*\n\n` +
      `\u2022 ${entidadTipo === "cuenta" ? "Cuenta" : "Contacto"}: ${row.nombre}\n` +
      `\u2022 Rechazado por: ${rejecterName} (${ctx.rol})\n` +
      (motivo ? `\u2022 Motivo: ${motivo}\n` : "") +
      `\nEl registro ha sido eliminado.`;
    writeApprovalNotification([creatorFolder], msg);
  }

  return JSON.stringify({
    mensaje: `${entidadTipo === "cuenta" ? "Cuenta" : "Contacto"} "${row.nombre}" rechazada y eliminada.`,
    entidad_id: entidadId,
  });
}

// ---------------------------------------------------------------------------
// consultar_pendientes
// ---------------------------------------------------------------------------

export function consultar_pendientes(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();

  // Determine which estados this role can see
  let estadoFilter: string[];
  if (ctx.rol === "gerente") {
    estadoFilter = ["pendiente_gerente"];
  } else if (ctx.rol === "director") {
    estadoFilter = ["pendiente_director", "disputado"];
  } else if (ctx.rol === "vp") {
    estadoFilter = ["pendiente_gerente", "pendiente_director", "disputado"];
  } else {
    return JSON.stringify({
      error: "Solo gerentes, directores y VP pueden consultar pendientes.",
    });
  }

  const placeholders = estadoFilter.map(() => "?").join(",");

  // Scope: for gerentes, only show records created by their team
  const scope = scopeFilter(ctx, "c.creado_por");

  const cuentas = db
    .prepare(
      `SELECT c.id, c.nombre, c.tipo, c.estado, c.creado_por, c.fecha_creacion,
              p.nombre AS creador_nombre
       FROM cuenta c
       LEFT JOIN persona p ON c.creado_por = p.id
       WHERE c.estado IN (${placeholders}) ${scope.where}
       ORDER BY c.fecha_creacion ASC`,
    )
    .all(...estadoFilter, ...scope.params) as any[];

  const scopeContacto = scopeFilter(ctx, "co.creado_por");

  const contactos = db
    .prepare(
      `SELECT co.id, co.nombre, co.estado, co.creado_por,
              cu.nombre AS cuenta_nombre,
              p.nombre AS creador_nombre
       FROM contacto co
       LEFT JOIN cuenta cu ON co.cuenta_id = cu.id
       LEFT JOIN persona p ON co.creado_por = p.id
       WHERE co.estado IN (${placeholders}) ${scopeContacto.where}
       ORDER BY co.rowid ASC`,
    )
    .all(...estadoFilter, ...scopeContacto.params) as any[];

  return JSON.stringify({
    pendientes_cuentas: cuentas.map((c: any) => ({
      id: c.id,
      nombre: c.nombre,
      tipo: c.tipo,
      estado: c.estado,
      creador: c.creador_nombre,
      fecha: c.fecha_creacion,
    })),
    pendientes_contactos: contactos.map((co: any) => ({
      id: co.id,
      nombre: co.nombre,
      cuenta: co.cuenta_nombre,
      estado: co.estado,
      creador: co.creador_nombre,
    })),
    total: cuentas.length + contactos.length,
  });
}

// ---------------------------------------------------------------------------
// impugnar_registro
// ---------------------------------------------------------------------------

export function impugnar_registro(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();
  const entidadTipo = args.entidad_tipo as EntidadTipo;
  const entidadId = args.entidad_id as string;
  const motivo = (args.motivo as string)?.trim();

  if (!entidadTipo || !entidadId) {
    return JSON.stringify({
      error:
        "entidad_tipo ('cuenta' o 'contacto') y entidad_id son requeridos.",
    });
  }
  if (!motivo) {
    return JSON.stringify({
      error: "El motivo de la impugnacion es requerido.",
    });
  }
  const table = resolveApprovalTable(entidadTipo);
  if (!table) {
    return JSON.stringify({
      error: "entidad_tipo debe ser 'cuenta' o 'contacto'.",
    });
  }

  const row = db
    .prepare(
      `SELECT id, nombre, estado, creado_por, fecha_activacion FROM ${table} WHERE id = ?`,
    )
    .get(entidadId) as any;

  if (!row) {
    return JSON.stringify({
      error: `No encontre ${entidadTipo} con id "${entidadId}".`,
    });
  }
  if (row.estado !== "activo_en_revision") {
    return JSON.stringify({
      error: `Solo se pueden impugnar registros en "activo_en_revision". Estado actual: "${row.estado}".`,
    });
  }

  // Check 24h window
  if (row.fecha_activacion) {
    const activatedAt = new Date(row.fecha_activacion).getTime();
    const elapsed = Date.now() - activatedAt;
    if (elapsed > 24 * 60 * 60 * 1000) {
      return JSON.stringify({
        error:
          "La ventana de impugnacion de 24h ha expirado. El registro ya es definitivo.",
      });
    }
  }

  db.prepare(`UPDATE ${table} SET estado = 'disputado' WHERE id = ?`).run(
    entidadId,
  );

  logAprobacion(
    db,
    entidadTipo,
    entidadId,
    "impugnado",
    ctx.persona_id,
    ctx.rol,
    "activo_en_revision",
    "disputado",
    motivo,
  );

  // Notify director
  const challengerName = getPersonById(ctx.persona_id)?.nombre ?? "Desconocido";
  const msg =
    `*Registro impugnado*\n\n` +
    `\u2022 ${entidadTipo === "cuenta" ? "Cuenta" : "Contacto"}: ${row.nombre}\n` +
    `\u2022 Impugnado por: ${challengerName} (${ctx.rol})\n` +
    `\u2022 Motivo: ${motivo}\n` +
    `\nRequiere resolucion del Director.`;

  const targets = getNotificationTargets(
    "disputado",
    row.creado_por ?? ctx.persona_id,
  );
  if (Array.isArray(targets) && targets.length > 0) {
    writeApprovalNotification(targets, msg);
  }

  return JSON.stringify({
    mensaje: `${entidadTipo === "cuenta" ? "Cuenta" : "Contacto"} "${row.nombre}" impugnada. Un Director debe resolver.`,
    entidad_id: entidadId,
    estado_nuevo: "disputado",
  });
}
