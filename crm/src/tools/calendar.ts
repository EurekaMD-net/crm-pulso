/**
 * Calendar Tools
 *
 * crear_evento_calendario — create calendar event
 * consultar_agenda — query upcoming events
 *
 * MVP: If GOOGLE_CALENDAR_ENABLED=false, events are saved locally
 * in evento_calendario table without calling Google API.
 */

import { getDatabase } from '../db.js';
import { isGoogleEnabled, getCalendarClient } from '../google-auth.js';
import type { ToolContext } from './index.js';

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isCalendarEnabled(): boolean {
  return process.env.GOOGLE_CALENDAR_ENABLED === 'true';
}

// ---------------------------------------------------------------------------
// crear_evento_calendario
// ---------------------------------------------------------------------------

export async function crear_evento_calendario(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const db = getDatabase();
  const titulo = args.titulo as string;
  const fechaInicio = args.fecha_inicio as string;
  const duracionMin = (args.duracion_minutos as number) || 30;
  const descripcion = args.descripcion as string | undefined;
  const tipo = args.tipo as string || 'seguimiento';
  const propuestaId = args.propuesta_id as string | undefined;
  const cuentaId = args.cuenta_id as string | undefined;

  // Compute end time
  const startDate = new Date(fechaInicio);
  const endDate = new Date(startDate.getTime() + duracionMin * 60000);
  const fechaFin = endDate.toISOString();

  const id = genId('evt');

  // Google Calendar API
  let googleEventId: string | null = null;
  if (isCalendarEnabled() && isGoogleEnabled()) {
    const persona = db.prepare('SELECT email, google_calendar_id FROM persona WHERE id = ?').get(ctx.persona_id) as any;
    if (persona?.email) {
      try {
        const calendar = getCalendarClient(persona.email);
        const calendarId = persona.google_calendar_id || 'primary';
        const event = await calendar.events.insert({
          calendarId,
          requestBody: {
            summary: titulo,
            description: descripcion,
            start: { dateTime: fechaInicio },
            end: { dateTime: fechaFin },
          },
        });
        googleEventId = event.data.id ?? null;
      } catch {
        // Fail gracefully — still store locally
      }
    }
  }

  db.prepare(`
    INSERT INTO evento_calendario (id, persona_id, google_event_id, titulo, descripcion, fecha_inicio, fecha_fin, tipo, propuesta_id, cuenta_id, creado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agente')
  `).run(id, ctx.persona_id, googleEventId, titulo, descripcion ?? null, fechaInicio, fechaFin, tipo, propuestaId ?? null, cuentaId ?? null);

  // Format date for display
  const displayDate = startDate.toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const calendarNote = googleEventId
    ? ' (sincronizado con Google Calendar)'
    : isCalendarEnabled()
      ? ''
      : ' (registrado localmente — Google Calendar no configurado)';

  return JSON.stringify({
    ok: true,
    id,
    mensaje: `Evento creado: "${titulo}" — ${displayDate}${calendarNote}`,
  });
}

// ---------------------------------------------------------------------------
// consultar_agenda
// ---------------------------------------------------------------------------

export function consultar_agenda(args: Record<string, unknown>, ctx: ToolContext): string {
  const db = getDatabase();
  const rango = args.rango as string || 'hoy';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let startStr: string;
  let endStr: string;

  switch (rango) {
    case 'hoy':
      startStr = today.toISOString();
      endStr = new Date(today.getTime() + 86400000).toISOString();
      break;
    case 'mañana': {
      const tomorrow = new Date(today.getTime() + 86400000);
      startStr = tomorrow.toISOString();
      endStr = new Date(tomorrow.getTime() + 86400000).toISOString();
      break;
    }
    case 'esta_semana': {
      const dayOfWeek = today.getDay();
      const monday = new Date(today.getTime() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1) * 86400000);
      startStr = monday.toISOString();
      endStr = new Date(monday.getTime() + 7 * 86400000).toISOString();
      break;
    }
    case 'proxima_semana': {
      const dayOfWeek = today.getDay();
      const nextMonday = new Date(today.getTime() + (7 - (dayOfWeek === 0 ? 6 : dayOfWeek - 1)) * 86400000);
      startStr = nextMonday.toISOString();
      endStr = new Date(nextMonday.getTime() + 7 * 86400000).toISOString();
      break;
    }
    default:
      startStr = today.toISOString();
      endStr = new Date(today.getTime() + 86400000).toISOString();
  }

  const rows = db.prepare(`
    SELECT e.titulo, e.fecha_inicio, e.fecha_fin, e.tipo, e.descripcion,
           c.nombre AS cuenta, pr.titulo AS propuesta
    FROM evento_calendario e
    LEFT JOIN cuenta c ON e.cuenta_id = c.id
    LEFT JOIN propuesta pr ON e.propuesta_id = pr.id
    WHERE e.persona_id = ? AND e.fecha_inicio >= ? AND e.fecha_inicio < ?
    ORDER BY e.fecha_inicio
  `).all(ctx.persona_id, startStr, endStr) as any[];

  if (rows.length === 0) {
    return JSON.stringify({ mensaje: `No hay eventos para ${rango}.` });
  }

  return JSON.stringify({
    rango,
    eventos: rows.map(r => ({
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
