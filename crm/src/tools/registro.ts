/**
 * Registration Tools — AE write operations
 *
 * registrar_actividad, crear_propuesta, actualizar_propuesta,
 * cerrar_propuesta, actualizar_descarga
 */

import { getDatabase } from "../db.js";
import { classifyAndUpdate } from "../sentiment.js";
import type { ToolContext } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

/** Fuzzy match account name using LIKE with normalized comparison. */
function findCuenta(
  nombre: string,
): { id: string; nombre: string } | undefined {
  const db = getDatabase();
  // Try exact first, then LIKE
  const exact = db
    .prepare("SELECT id, nombre FROM cuenta WHERE nombre = ?")
    .get(nombre) as any;
  if (exact) return exact;
  const fuzzy = db
    .prepare("SELECT id, nombre FROM cuenta WHERE nombre LIKE ?")
    .get(`%${nombre}%`) as any;
  return fuzzy;
}

/** Fuzzy match propuesta by title, optionally scoped to a cuenta. */
function findPropuesta(
  titulo: string,
  cuentaId?: string,
): { id: string; titulo: string; ae_id: string; etapa: string } | undefined {
  const db = getDatabase();
  if (cuentaId) {
    const row = db
      .prepare(
        "SELECT id, titulo, ae_id, etapa FROM propuesta WHERE titulo LIKE ? AND cuenta_id = ?",
      )
      .get(`%${titulo}%`, cuentaId) as any;
    if (row) return row;
  }
  return db
    .prepare(
      "SELECT id, titulo, ae_id, etapa FROM propuesta WHERE titulo LIKE ?",
    )
    .get(`%${titulo}%`) as any;
}

function getCurrentWeek(): number {
  const d = new Date();
  const start = new Date(d.getFullYear(), 0, 1);
  const diff = d.getTime() - start.getTime();
  return Math.ceil((diff / 86400000 + start.getDay() + 1) / 7);
}

// ---------------------------------------------------------------------------
// registrar_actividad
// ---------------------------------------------------------------------------

export function registrar_actividad(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();
  const cuentaNombre = args.cuenta_nombre as string | undefined;
  const tipo = (args.tipo as string) || "otro";
  const resumen = (args.resumen as string) || "";
  const sentimiento = (args.sentimiento as string) || "neutral";
  const propuestaTitulo = args.propuesta_titulo as string | undefined;
  const siguienteAccion = args.siguiente_accion as string | undefined;
  const fechaSiguienteAccion = args.fecha_siguiente_accion as
    | string
    | undefined;

  const cuenta = cuentaNombre ? findCuenta(cuentaNombre) : undefined;
  if (cuentaNombre && !cuenta) {
    return JSON.stringify({
      error: `No encontré la cuenta "${cuentaNombre}". Verifica el nombre.`,
    });
  }

  const propuesta = propuestaTitulo
    ? findPropuesta(propuestaTitulo, cuenta?.id)
    : undefined;

  const id = genId("act");
  const timestamp = now();

  const tx = db.transaction(() => {
    db.prepare(
      `
      INSERT INTO actividad (id, ae_id, cuenta_id, propuesta_id, tipo, resumen, sentimiento, siguiente_accion, fecha_siguiente_accion, fecha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      ctx.persona_id,
      cuenta?.id ?? null,
      propuesta?.id ?? null,
      tipo,
      resumen,
      sentimiento,
      siguienteAccion ?? null,
      fechaSiguienteAccion ?? null,
      timestamp,
    );

    // Update propuesta activity timestamp if linked
    if (propuesta) {
      db.prepare(
        "UPDATE propuesta SET fecha_ultima_actividad = ?, dias_sin_actividad = 0 WHERE id = ?",
      ).run(timestamp, propuesta.id);
    }
  });
  tx();

  // Fire-and-forget: auto-classify sentiment via LLM (overrides agent's guess with confidence score)
  if (resumen) {
    classifyAndUpdate(id, resumen);
  }

  const parts = [`Actividad registrada: ${tipo}`];
  if (cuenta) parts.push(`Cuenta: ${cuenta.nombre}`);
  if (propuesta) parts.push(`Propuesta: ${propuesta.titulo}`);
  if (siguienteAccion) parts.push(`Siguiente: ${siguienteAccion}`);
  if (fechaSiguienteAccion) parts.push(`Fecha: ${fechaSiguienteAccion}`);

  return JSON.stringify({ ok: true, id, mensaje: parts.join(" | ") });
}

// ---------------------------------------------------------------------------
// crear_propuesta
// ---------------------------------------------------------------------------

export function crear_propuesta(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();
  const cuentaNombre = args.cuenta_nombre as string;
  const titulo = args.titulo as string;
  const valorEstimado = args.valor_estimado as number | undefined;

  const cuenta = findCuenta(cuentaNombre);
  if (!cuenta) {
    return JSON.stringify({
      error: `No encontré la cuenta "${cuentaNombre}". Verifica el nombre.`,
    });
  }

  const id = genId("prop");
  const timestamp = now();

  db.prepare(
    `
    INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, medios, tipo_oportunidad, gancho_temporal, fecha_vuelo_inicio, fecha_vuelo_fin, etapa, fecha_creacion, fecha_ultima_actividad)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'en_preparacion', ?, ?)
  `,
  ).run(
    id,
    cuenta.id,
    ctx.persona_id,
    titulo,
    valorEstimado ?? null,
    (args.medios as string) ?? null,
    (args.tipo_oportunidad as string) ?? null,
    (args.gancho_temporal as string) ?? null,
    (args.fecha_vuelo_inicio as string) ?? null,
    (args.fecha_vuelo_fin as string) ?? null,
    timestamp,
    timestamp,
  );

  const valor = valorEstimado
    ? ` por $${(valorEstimado / 1_000_000).toFixed(1)}M`
    : "";
  return JSON.stringify({
    ok: true,
    id,
    mensaje: `Propuesta creada: "${titulo}" para ${cuenta.nombre}${valor}`,
  });
}

// ---------------------------------------------------------------------------
// actualizar_propuesta
// ---------------------------------------------------------------------------

export function actualizar_propuesta(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();
  const propuestaTitulo = args.propuesta_titulo as string;
  const cuentaNombre = args.cuenta_nombre as string | undefined;

  const cuenta = cuentaNombre ? findCuenta(cuentaNombre) : undefined;
  const propuesta = findPropuesta(propuestaTitulo, cuenta?.id);
  if (!propuesta) {
    return JSON.stringify({
      error: `No encontré la propuesta "${propuestaTitulo}".`,
    });
  }

  // Access check: AE can only update own, gerente+ can update team's
  if (
    propuesta.ae_id !== ctx.persona_id &&
    !ctx.full_team_ids.includes(propuesta.ae_id)
  ) {
    return JSON.stringify({ error: "No tienes acceso a esta propuesta." });
  }

  const etapa = args.etapa as string | undefined;
  const valorEstimado = args.valor_estimado as number | undefined;
  const notas = args.notas as string | undefined;
  const razonPerdida = args.razon_perdida as string | undefined;
  const timestamp = now();

  // Require razon_perdida for closing stages
  if ((etapa === "perdida" || etapa === "cancelada") && !razonPerdida) {
    return JSON.stringify({
      error: `Se requiere razon_perdida para marcar como ${etapa}.`,
    });
  }

  db.prepare(
    `
    UPDATE propuesta SET
      etapa = COALESCE(?, etapa),
      valor_estimado = COALESCE(?, valor_estimado),
      notas = COALESCE(?, notas),
      razon_perdida = COALESCE(?, razon_perdida),
      fecha_ultima_actividad = ?,
      dias_sin_actividad = 0
    WHERE id = ?
  `,
  ).run(
    etapa ?? null,
    valorEstimado ?? null,
    notas ?? null,
    razonPerdida ?? null,
    timestamp,
    propuesta.id,
  );

  const changes: string[] = [];
  if (etapa) changes.push(`Etapa: ${propuesta.etapa} → ${etapa}`);
  if (valorEstimado)
    changes.push(`Valor: $${(valorEstimado / 1_000_000).toFixed(1)}M`);

  return JSON.stringify({
    ok: true,
    id: propuesta.id,
    mensaje: `Propuesta "${propuesta.titulo}" actualizada. ${changes.join(", ")}`,
  });
}

// ---------------------------------------------------------------------------
// cerrar_propuesta
// ---------------------------------------------------------------------------

export function cerrar_propuesta(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const resultado = args.resultado as string;
  const razon = args.razon as string | undefined;

  if ((resultado === "perdida" || resultado === "cancelada") && !razon) {
    return JSON.stringify({
      error: `Se requiere razón para marcar como ${resultado}.`,
    });
  }

  return actualizar_propuesta(
    {
      propuesta_titulo: args.propuesta_titulo,
      cuenta_nombre: args.cuenta_nombre,
      etapa: resultado,
      razon_perdida: razon,
    },
    ctx,
  );
}

// ---------------------------------------------------------------------------
// actualizar_descarga
// ---------------------------------------------------------------------------

export function actualizar_descarga(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();
  const cuentaNombre = args.cuenta_nombre as string;
  const notasAe = args.notas_ae as string;
  const semana = (args.semana as number) || getCurrentWeek();
  const año = new Date().getFullYear();

  const cuenta = findCuenta(cuentaNombre);
  if (!cuenta) {
    return JSON.stringify({
      error: `No encontré la cuenta "${cuentaNombre}".`,
    });
  }

  // Try update existing, or insert new
  const existing = db
    .prepare(
      "SELECT id FROM descarga WHERE cuenta_id = ? AND semana = ? AND año = ?",
    )
    .get(cuenta.id, semana, año) as any;

  if (existing) {
    db.prepare("UPDATE descarga SET notas_ae = ? WHERE id = ?").run(
      notasAe,
      existing.id,
    );
    return JSON.stringify({
      ok: true,
      mensaje: `Notas de descarga actualizadas para ${cuenta.nombre} semana ${semana}.`,
    });
  }

  const id = genId("desc");
  db.prepare(
    "INSERT INTO descarga (id, cuenta_id, semana, año, notas_ae) VALUES (?, ?, ?, ?, ?)",
  ).run(id, cuenta.id, semana, año, notasAe);
  return JSON.stringify({
    ok: true,
    id,
    mensaje: `Descarga creada para ${cuenta.nombre} semana ${semana} con notas.`,
  });
}
