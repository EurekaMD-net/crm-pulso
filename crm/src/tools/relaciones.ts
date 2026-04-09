/**
 * Relationship Intelligence Tools — Dir/VP executive relationship management.
 *
 * 7 tools for tracking, logging, and analyzing executive relationships.
 * All scoped to Dir/VP roles only.
 */

import { getDatabase } from "../db.js";
import { computeWarmth, warmthLabel } from "../warmth.js";
import type { InteractionRow } from "../warmth.js";
import { dataFreshness, getMxDateStr } from "./helpers.js";
import type { ToolContext } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findContactoByName(
  nombre: string,
): { id: string; nombre: string; cuenta_id: string } | null {
  const db = getDatabase();
  return (
    (db
      .prepare("SELECT id, nombre, cuenta_id FROM contacto WHERE nombre LIKE ?")
      .get(`%${nombre}%`) as any) ?? null
  );
}

function getRelacion(personaId: string, contactoId: string) {
  const db = getDatabase();
  return (
    (db
      .prepare(
        "SELECT * FROM relacion_ejecutiva WHERE persona_id = ? AND contacto_id = ?",
      )
      .get(personaId, contactoId) as any) ?? null
  );
}

function recomputeWarmth(relacionId: string): number {
  const db = getDatabase();
  const interactions = db
    .prepare(
      "SELECT tipo, calidad, fecha FROM interaccion_ejecutiva WHERE relacion_id = ? ORDER BY fecha DESC",
    )
    .all(relacionId) as InteractionRow[];

  const score = computeWarmth(interactions);
  db.prepare(
    "UPDATE relacion_ejecutiva SET warmth_score = ?, warmth_updated = datetime('now') WHERE id = ?",
  ).run(score, relacionId);
  return score;
}

function roleCheck(ctx: ToolContext): string | null {
  if (ctx.rol !== "director" && ctx.rol !== "vp") {
    return JSON.stringify({
      error: "Solo directores y VP pueden gestionar relaciones ejecutivas.",
    });
  }
  return null;
}

/** Scope filter for relacion_ejecutiva — Dir sees own + team directors, VP sees all */
function relationScope(ctx: ToolContext): { where: string; params: string[] } {
  if (ctx.rol === "vp") return { where: "", params: [] };
  // Director sees own relationships
  return { where: "AND re.persona_id = ?", params: [ctx.persona_id] };
}

// ---------------------------------------------------------------------------
// registrar_relacion_ejecutiva
// ---------------------------------------------------------------------------

export async function registrar_relacion_ejecutiva(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const err = roleCheck(ctx);
  if (err) return err;

  const contactoNombre = args.contacto_nombre as string;
  if (!contactoNombre) {
    return JSON.stringify({ error: 'Se requiere "contacto_nombre".' });
  }

  const contacto = findContactoByName(contactoNombre);
  if (!contacto) {
    return JSON.stringify({
      error: `Contacto "${contactoNombre}" no encontrado.`,
    });
  }

  // Check if relationship already exists
  const existing = getRelacion(ctx.persona_id, contacto.id);
  if (existing) {
    return JSON.stringify({
      error: `Ya tienes una relacion rastreada con ${contacto.nombre}.`,
      relacion_id: existing.id,
      warmth_score: existing.warmth_score,
    });
  }

  const db = getDatabase();
  const id = `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tipo = (args.tipo as string) || "cliente";
  const importancia = (args.importancia as string) || "media";
  const notas = (args.notas_estrategicas as string) || null;

  db.prepare(
    "INSERT INTO relacion_ejecutiva (id, persona_id, contacto_id, tipo, importancia, notas_estrategicas) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, ctx.persona_id, contacto.id, tipo, importancia, notas);

  // Mark contact as executive
  db.prepare("UPDATE contacto SET es_ejecutivo = 1 WHERE id = ?").run(
    contacto.id,
  );

  // Auto-create birthday milestone if fecha_nacimiento exists
  const contact = db
    .prepare("SELECT fecha_nacimiento FROM contacto WHERE id = ?")
    .get(contacto.id) as any;
  if (contact?.fecha_nacimiento) {
    const existingHito = db
      .prepare(
        "SELECT id FROM hito_contacto WHERE contacto_id = ? AND tipo = 'cumpleanos'",
      )
      .get(contacto.id);
    if (!existingHito) {
      const hitoId = `hito-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(
        "INSERT INTO hito_contacto (id, contacto_id, tipo, titulo, fecha, recurrente) VALUES (?, ?, 'cumpleanos', ?, ?, 1)",
      ).run(
        hitoId,
        contacto.id,
        `Cumpleanos de ${contacto.nombre}`,
        contact.fecha_nacimiento,
      );
    }
  }

  return JSON.stringify({
    ok: true,
    relacion_id: id,
    contacto: contacto.nombre,
    tipo,
    importancia,
    warmth_score: 50,
    warmth_label: warmthLabel(50),
    mensaje: `Relacion ejecutiva registrada con ${contacto.nombre}.`,
  });
}

// ---------------------------------------------------------------------------
// registrar_interaccion_ejecutiva
// ---------------------------------------------------------------------------

export async function registrar_interaccion_ejecutiva(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const err = roleCheck(ctx);
  if (err) return err;

  const contactoNombre = args.contacto_nombre as string;
  if (!contactoNombre) {
    return JSON.stringify({ error: 'Se requiere "contacto_nombre".' });
  }
  const resumen = args.resumen as string;
  if (!resumen) {
    return JSON.stringify({ error: 'Se requiere "resumen".' });
  }

  const contacto = findContactoByName(contactoNombre);
  if (!contacto) {
    return JSON.stringify({
      error: `Contacto "${contactoNombre}" no encontrado.`,
    });
  }

  const relacion = getRelacion(ctx.persona_id, contacto.id);
  if (!relacion) {
    return JSON.stringify({
      error: `No tienes relacion rastreada con ${contacto.nombre}. Usa registrar_relacion_ejecutiva primero.`,
    });
  }

  const db = getDatabase();
  const id = `intej-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tipo = (args.tipo as string) || "otro";
  const calidad = (args.calidad as string) || "normal";
  const lugar = (args.lugar as string) || null;

  db.prepare(
    "INSERT INTO interaccion_ejecutiva (id, relacion_id, tipo, resumen, calidad, lugar) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, relacion.id, tipo, resumen, calidad, lugar);

  const newWarmth = recomputeWarmth(relacion.id);

  return JSON.stringify({
    ok: true,
    interaccion_id: id,
    contacto: contacto.nombre,
    tipo,
    calidad,
    warmth_score: newWarmth,
    warmth_label: warmthLabel(newWarmth),
  });
}

// ---------------------------------------------------------------------------
// consultar_salud_relaciones
// ---------------------------------------------------------------------------

export async function consultar_salud_relaciones(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const err = roleCheck(ctx);
  if (err) return err;

  const db = getDatabase();
  const scope = relationScope(ctx);
  const filtro = (args.filtro as string) || "todas";
  const cuentaNombre = args.cuenta_nombre as string;

  let warmthFilter = "";
  if (filtro === "frias") warmthFilter = "AND re.warmth_score < 40";
  else if (filtro === "calientes") warmthFilter = "AND re.warmth_score >= 70";

  let cuentaFilter = "";
  const params: unknown[] = [...scope.params];
  if (cuentaNombre) {
    cuentaFilter = "AND cu.nombre LIKE ?";
    params.push(`%${cuentaNombre}%`);
  }

  const rows = db
    .prepare(
      `
    SELECT re.id, re.warmth_score, re.importancia, re.tipo,
           c.nombre as contacto, cu.nombre as cuenta,
           (SELECT MAX(ie.fecha) FROM interaccion_ejecutiva ie WHERE ie.relacion_id = re.id) as ultimo_contacto,
           (SELECT COUNT(*) FROM interaccion_ejecutiva ie WHERE ie.relacion_id = re.id) as total_interacciones,
           (SELECT ie.tipo FROM interaccion_ejecutiva ie WHERE ie.relacion_id = re.id ORDER BY ie.fecha DESC LIMIT 1) as ultimo_tipo
    FROM relacion_ejecutiva re
    JOIN contacto c ON c.id = re.contacto_id
    LEFT JOIN cuenta cu ON cu.id = c.cuenta_id
    WHERE 1=1 ${scope.where} ${warmthFilter} ${cuentaFilter}
    ORDER BY re.warmth_score ASC
    LIMIT 30
  `,
    )
    .all(...params) as any[];

  if (rows.length === 0) {
    return JSON.stringify({
      mensaje: "No se encontraron relaciones con ese filtro.",
      relaciones: [],
    });
  }

  return JSON.stringify({
    total: rows.length,
    filtro,
    data_freshness: dataFreshness(rows, "ultimo_contacto"),
    relaciones: rows.map((r) => {
      const diasSinContacto = r.ultimo_contacto
        ? Math.floor(
            (Date.now() - new Date(r.ultimo_contacto).getTime()) / 86_400_000,
          )
        : null;
      return {
        contacto: r.contacto,
        cuenta: r.cuenta,
        tipo: r.tipo,
        importancia: r.importancia,
        warmth_score: r.warmth_score,
        warmth_label: warmthLabel(r.warmth_score),
        dias_sin_contacto: diasSinContacto,
        total_interacciones: r.total_interacciones,
        ultimo_tipo: r.ultimo_tipo,
      };
    }),
  });
}

// ---------------------------------------------------------------------------
// consultar_historial_relacion
// ---------------------------------------------------------------------------

export async function consultar_historial_relacion(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const err = roleCheck(ctx);
  if (err) return err;

  const contactoNombre = args.contacto_nombre as string;
  if (!contactoNombre) {
    return JSON.stringify({ error: 'Se requiere "contacto_nombre".' });
  }

  const contacto = findContactoByName(contactoNombre);
  if (!contacto) {
    return JSON.stringify({
      error: `Contacto "${contactoNombre}" no encontrado.`,
    });
  }

  const relacion = getRelacion(ctx.persona_id, contacto.id);
  if (!relacion) {
    return JSON.stringify({
      error: `No tienes relacion rastreada con ${contacto.nombre}.`,
    });
  }

  const db = getDatabase();

  const interactions = db
    .prepare(
      "SELECT tipo, resumen, calidad, lugar, fecha FROM interaccion_ejecutiva WHERE relacion_id = ? ORDER BY fecha DESC LIMIT 50",
    )
    .all(relacion.id) as any[];

  const milestones = db
    .prepare(
      "SELECT tipo, titulo, fecha, recurrente, notas FROM hito_contacto WHERE contacto_id = ? ORDER BY fecha ASC",
    )
    .all(contacto.id) as any[];

  const cuenta = db
    .prepare("SELECT nombre FROM cuenta WHERE id = ?")
    .get(contacto.cuenta_id) as any;

  return JSON.stringify({
    contacto: contacto.nombre,
    cuenta: cuenta?.nombre ?? null,
    tipo: relacion.tipo,
    importancia: relacion.importancia,
    notas_estrategicas: relacion.notas_estrategicas,
    warmth_score: relacion.warmth_score,
    warmth_label: warmthLabel(relacion.warmth_score),
    fecha_inicio: relacion.fecha_creacion,
    interacciones: interactions,
    hitos: milestones,
    total_interacciones: interactions.length,
  });
}

// ---------------------------------------------------------------------------
// registrar_hito
// ---------------------------------------------------------------------------

export async function registrar_hito(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const err = roleCheck(ctx);
  if (err) return err;

  const contactoNombre = args.contacto_nombre as string;
  if (!contactoNombre) {
    return JSON.stringify({ error: 'Se requiere "contacto_nombre".' });
  }
  const titulo = args.titulo as string;
  if (!titulo) {
    return JSON.stringify({ error: 'Se requiere "titulo".' });
  }
  const fecha = args.fecha as string;
  if (!fecha) {
    return JSON.stringify({ error: 'Se requiere "fecha".' });
  }

  const contacto = findContactoByName(contactoNombre);
  if (!contacto) {
    return JSON.stringify({
      error: `Contacto "${contactoNombre}" no encontrado.`,
    });
  }

  const db = getDatabase();
  const id = `hito-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tipo = (args.tipo as string) || "otro";
  const recurrente = args.recurrente ? 1 : 0;
  const notas = (args.notas as string) || null;

  db.prepare(
    "INSERT INTO hito_contacto (id, contacto_id, tipo, titulo, fecha, recurrente, notas) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, contacto.id, tipo, titulo, fecha, recurrente, notas);

  return JSON.stringify({
    ok: true,
    hito_id: id,
    contacto: contacto.nombre,
    tipo,
    titulo,
    fecha,
    recurrente: recurrente === 1,
  });
}

// ---------------------------------------------------------------------------
// consultar_hitos_proximos
// ---------------------------------------------------------------------------

export async function consultar_hitos_proximos(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const err = roleCheck(ctx);
  if (err) return err;

  const db = getDatabase();
  const diasAdelante = Math.min(
    Math.max(Number(args.dias_adelante) || 30, 1),
    180,
  );
  const scope = relationScope(ctx);

  const now = new Date();
  const cutoff = new Date(now.getTime() + diasAdelante * 86_400_000);

  // Non-recurring: direct date range
  const nonRecurring = db
    .prepare(
      `
    SELECT h.tipo, h.titulo, h.fecha, h.notas, c.nombre as contacto, cu.nombre as cuenta
    FROM hito_contacto h
    JOIN contacto c ON c.id = h.contacto_id
    LEFT JOIN cuenta cu ON cu.id = c.cuenta_id
    JOIN relacion_ejecutiva re ON re.contacto_id = c.id
    WHERE h.recurrente = 0 AND h.fecha >= ? AND h.fecha <= ?
    ${scope.where}
    ORDER BY h.fecha ASC
  `,
    )
    .all(getMxDateStr(now), getMxDateStr(cutoff), ...scope.params) as any[];

  // Recurring (birthdays etc): match month-day within window
  // Fetch all recurring milestones for tracked contacts, filter in JS
  const recurring = db
    .prepare(
      `
    SELECT h.tipo, h.titulo, h.fecha, h.notas, c.nombre as contacto, cu.nombre as cuenta
    FROM hito_contacto h
    JOIN contacto c ON c.id = h.contacto_id
    LEFT JOIN cuenta cu ON cu.id = c.cuenta_id
    JOIN relacion_ejecutiva re ON re.contacto_id = c.id
    WHERE h.recurrente = 1
    ${scope.where}
  `,
    )
    .all(...scope.params) as any[];

  const thisYear = now.getFullYear();
  const recurringFiltered = recurring
    .map((h) => {
      // Build this year's date from the milestone's month-day
      const [, mm, dd] = (h.fecha as string).split("-");
      const thisYearDate = `${thisYear}-${mm}-${dd}`;
      const d = new Date(thisYearDate);
      // If already passed this year, check next year
      const effectiveDate =
        d >= now ? thisYearDate : `${thisYear + 1}-${mm}-${dd}`;
      const effective = new Date(effectiveDate);
      if (effective > cutoff) return null;
      const diasRestantes = Math.ceil(
        (effective.getTime() - now.getTime()) / 86_400_000,
      );
      return {
        ...h,
        fecha_proxima: effectiveDate,
        dias_restantes: diasRestantes,
      };
    })
    .filter(Boolean) as any[];

  // Merge and sort
  const all = [
    ...nonRecurring.map((h) => ({
      contacto: h.contacto,
      cuenta: h.cuenta,
      tipo: h.tipo,
      titulo: h.titulo,
      fecha: h.fecha,
      dias_restantes: Math.ceil(
        (new Date(h.fecha).getTime() - now.getTime()) / 86_400_000,
      ),
    })),
    ...recurringFiltered.map((h) => ({
      contacto: h.contacto,
      cuenta: h.cuenta,
      tipo: h.tipo,
      titulo: h.titulo,
      fecha: h.fecha_proxima,
      dias_restantes: h.dias_restantes,
    })),
  ].sort((a, b) => a.dias_restantes - b.dias_restantes);

  if (all.length === 0) {
    return JSON.stringify({
      mensaje: `No hay hitos en los proximos ${diasAdelante} dias.`,
      hitos: [],
    });
  }

  return JSON.stringify({
    total: all.length,
    dias_adelante: diasAdelante,
    hitos: all,
  });
}

// ---------------------------------------------------------------------------
// actualizar_notas_estrategicas
// ---------------------------------------------------------------------------

export async function actualizar_notas_estrategicas(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const err = roleCheck(ctx);
  if (err) return err;

  const contactoNombre = args.contacto_nombre as string;
  if (!contactoNombre) {
    return JSON.stringify({ error: 'Se requiere "contacto_nombre".' });
  }
  const notas = args.notas as string;
  if (!notas) {
    return JSON.stringify({ error: 'Se requiere "notas".' });
  }

  const contacto = findContactoByName(contactoNombre);
  if (!contacto) {
    return JSON.stringify({
      error: `Contacto "${contactoNombre}" no encontrado.`,
    });
  }

  const relacion = getRelacion(ctx.persona_id, contacto.id);
  if (!relacion) {
    return JSON.stringify({
      error: `No tienes relacion rastreada con ${contacto.nombre}.`,
    });
  }

  const db = getDatabase();
  db.prepare(
    "UPDATE relacion_ejecutiva SET notas_estrategicas = ? WHERE id = ?",
  ).run(notas, relacion.id);

  return JSON.stringify({
    ok: true,
    contacto: contacto.nombre,
    notas_estrategicas: notas,
  });
}
