/**
 * Google Calendar Operations — Calendar API
 */

import { getCalendarClient } from "./auth.js";
import type { CalendarEventInput, CalendarEventResult } from "../types.js";

export async function createEvent(
  email: string,
  event: CalendarEventInput,
): Promise<CalendarEventResult> {
  const calendar = getCalendarClient(email);
  const calendarId = event.calendar_id || "primary";

  const result = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: event.titulo,
      description: event.descripcion,
      start: { dateTime: event.fecha_inicio },
      end: { dateTime: event.fecha_fin },
    },
  });

  return {
    external_event_id: result.data.id ?? null,
  };
}
