/**
 * Pre-flight validation — context-aware precondition checks before tool execution.
 *
 * Catches errors before burning an inference round. Returns an error string
 * if precondition fails, null if OK.
 *
 * Ported from mission-control's task-executor.ts preflight pattern.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Check preconditions before executing a tool.
 * Returns an error string if the check fails, null if OK.
 */
export function checkPreflight(
  name: string,
  args: Record<string, unknown>,
): string | null {
  switch (name) {
    case "enviar_email_seguimiento":
    case "enviar_email_briefing":
    case "crear_borrador_email": {
      const to = (args.destinatario ?? args.to ?? args.email) as
        | string
        | undefined;
      if (to && !EMAIL_RE.test(to)) {
        return `Pre-flight: dirección de email inválida "${to}"`;
      }
      const body = (args.cuerpo ?? args.body ?? args.contenido) as
        | string
        | undefined;
      if (body && body.length < 10) {
        return `Pre-flight: cuerpo del email demasiado corto (${body.length} chars). Probablemente truncado.`;
      }
      return null;
    }

    case "crear_propuesta": {
      const valor = args.valor_estimado as number | undefined;
      if (valor !== undefined && valor <= 0) {
        return `Pre-flight: valor_estimado debe ser positivo (recibido: ${valor})`;
      }
      return null;
    }

    case "actualizar_propuesta":
    case "cerrar_propuesta": {
      const id = args.propuesta_id as string | undefined;
      if (!id || id.trim().length === 0) {
        return "Pre-flight: propuesta_id es requerido";
      }
      return null;
    }

    case "registrar_actividad": {
      const desc = (args.descripcion ?? args.resumen) as string | undefined;
      if (desc && desc.length < 5) {
        return `Pre-flight: descripción demasiado corta (${desc.length} chars)`;
      }
      return null;
    }

    case "construir_paquete": {
      const cuenta = args.cuenta_id as string | undefined;
      if (!cuenta || cuenta.trim().length === 0) {
        return "Pre-flight: cuenta_id es requerido para construir_paquete";
      }
      return null;
    }

    default:
      return null;
  }
}
