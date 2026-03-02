/**
 * Follow-up / Reminder Tools
 *
 * establecer_recordatorio — creates a calendar event of type 'seguimiento'
 */

import type { ToolContext } from './index.js';
import { crear_evento_calendario } from './calendar.js';

// ---------------------------------------------------------------------------
// establecer_recordatorio
// ---------------------------------------------------------------------------

export function establecer_recordatorio(args: Record<string, unknown>, ctx: ToolContext): string {
  // A reminder is just a calendar event of type seguimiento
  return crear_evento_calendario({
    titulo: args.titulo,
    fecha_inicio: args.fecha,
    tipo: 'seguimiento',
    cuenta_id: args.cuenta_nombre ? undefined : undefined, // resolved by caller if needed
    propuesta_id: args.propuesta_titulo ? undefined : undefined,
    duracion_minutos: 15,
    descripcion: `Recordatorio: ${args.titulo as string}`,
  }, ctx);
}
