/**
 * Calendar Tools
 *
 * crear_evento_calendario — create calendar event (optional external sync)
 * consultar_agenda — query upcoming events from local DB
 */

import { getDatabase } from "../db.js";
import { isWorkspaceEnabled, getProvider } from "../workspace/provider.js";
import type { ToolContext } from "./index.js";

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isCalendarEnabled(): boolean {
  return process.env.GOOGLE_CALENDAR_ENABLED === "true";
}

// ---------------------------------------------------------------------------
// crear_evento_calendario
// ---------------------------------------------------------------------------

export async function crear_evento_calendario(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const db = getDatabase();
  const titulo = args.titulo as string;
  const fechaInicio = args.fecha_inicio as string;
  const duracionMin = (args.duracion_minutos as number) || 30;
  const descripcion = args.descripcion as string | undefined;
  const tipo = (args.tipo as string) || "seguimiento";
  const propuestaId = args.propuesta_id as string | undefined;
  const cuentaId = args.cuenta_id as string | undefined;

  const startDate = new Date(fechaInicio);
  const endDate = new Date(startDate.getTime() + duracionMin * 60000);
  const fechaFin = endDate.toISOString();

  const id = genId("evt");

  // External calendar sync (optional)
  let externalEventId: string | null = null;
  if (isCalendarEnabled() && isWorkspaceEnabled()) {
    const persona = db
      .prepare("SELECT email, calendar_id FROM persona WHERE id = ?")
      .get(ctx.persona_id) as any;
    if (persona?.email) {
      try {
        const result = await getProvider().createEvent(persona.email, {
          titulo,
          descripcion,
          fecha_inicio: fechaInicio,
          fecha_fin: fechaFin,
          calendar_id: persona.calendar_id || undefined,
        });
        externalEventId = result.external_event_id;
      } catch {
        // Fail gracefully — still store locally
      }
    }
  }

  db.prepare(
    `INSERT INTO evento_calendario (id, persona_id, external_event_id, titulo, descripcion, fecha_inicio, fecha_fin, tipo, propuesta_id, cuenta_id, creado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agente')`,
  ).run(
    id,
    ctx.persona_id,
    externalEventId,
    titulo,
    descripcion ?? null,
    fechaInicio,
    fechaFin,
    tipo,
    propuestaId ?? null,
    cuentaId ?? null,
  );

  const displayDate = startDate.toLocaleDateString("es-MX", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const calendarNote = externalEventId
    ? " (sincronizado con calendario)"
    : isCalendarEnabled()
      ? ""
      : " (registrado localmente — calendario externo no configurado)";

  return JSON.stringify({
    ok: true,
    id,
    mensaje: `Evento creado: "${titulo}" — ${displayDate}${calendarNote}`,
  });
}

// ---------------------------------------------------------------------------
// consultar_agenda (DB-only — no provider call)
// ---------------------------------------------------------------------------

export function consultar_agenda(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const db = getDatabase();
  const rango = (args.rango as string) || "hoy";

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let startStr: string;
  let endStr: string;

  switch (rango) {
    case "hoy":
      startStr = today.toISOString();
      endStr = new Date(today.getTime() + 86400000).toISOString();
      break;
    case "mañana": {
      const tomorrow = new Date(today.getTime() + 86400000);
      startStr = tomorrow.toISOString();
      endStr = new Date(tomorrow.getTime() + 86400000).toISOString();
      break;
    }
    case "esta_semana": {
      const dayOfWeek = today.getDay();
      const monday = new Date(
        today.getTime() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1) * 86400000,
      );
      startStr = monday.toISOString();
      endStr = new Date(monday.getTime() + 7 * 86400000).toISOString();
      break;
    }
    case "proxima_semana": {
      const dayOfWeek = today.getDay();
      const nextMonday = new Date(
        today.getTime() +
          (7 - (dayOfWeek === 0 ? 6 : dayOfWeek - 1)) * 86400000,
      );
      startStr = nextMonday.toISOString();
      endStr = new Date(nextMonday.getTime() + 7 * 86400000).toISOString();
      break;
    }
    default:
      startStr = today.toISOString();
      endStr = new Date(today.getTime() + 86400000).toISOString();
  }

  const rows = db
    .prepare(
      `SELECT e.titulo, e.fecha_inicio, e.fecha_fin, e.tipo, e.descripcion,
           c.nombre AS cuenta, pr.titulo AS propuesta
    FROM evento_calendario e
    LEFT JOIN cuenta c ON e.cuenta_id = c.id
    LEFT JOIN propuesta pr ON e.propuesta_id = pr.id
    WHERE e.persona_id = ? AND e.fecha_inicio >= ? AND e.fecha_inicio < ?
    ORDER BY e.fecha_inicio`,
    )
    .all(ctx.persona_id, startStr, endStr) as any[];

  if (rows.length === 0) {
    return JSON.stringify({ mensaje: `No hay eventos para ${rango}.` });
  }

  return JSON.stringify({
    rango,
    eventos: rows.map((r) => ({
      titulo: r.titulo,
      inicio: r.fecha_inicio,
      fin: r.fecha_fin,
      tipo: r.tipo,
      descripcion: r.descripcion,
      cuenta: r.cuenta,
      propuesta: r.propuesta,
    })),
  });
}
