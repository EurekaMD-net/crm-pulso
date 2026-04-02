/**
 * Jarvis Pull — request strategic analysis from the Jarvis system.
 *
 * Calls mission-control's /api/jarvis-pull endpoint with role-based
 * depth control. VP gets full analysis, AE gets actionable bullets.
 */

import type { ToolContext } from "./index.js";

const JARVIS_URL = process.env.JARVIS_API_URL ?? "http://localhost:8080";
const JARVIS_KEY = process.env.JARVIS_API_KEY ?? "";

export const TOOL_JARVIS_PULL = {
  type: "function" as const,
  function: {
    name: "jarvis_pull",
    description: `Solicitar análisis estratégico del sistema Jarvis (asistente de inteligencia del VP).

CUÁNDO USAR:
- Necesitas contexto de mercado, tendencias de industria, o análisis competitivo
- Quieres una recomendación estratégica basada en datos externos al CRM
- Necesitas cruzar información del pipeline con inteligencia de negocio
- El usuario pregunta algo que va más allá de los datos del CRM

NO USAR:
- Para datos que ya tienes en el CRM (pipeline, cuotas, actividades)
- Para operaciones CRUD del CRM
- Para consultas simples de status

La profundidad de la respuesta se ajusta automáticamente según tu rol.`,
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "La pregunta o solicitud de análisis. Sé específico para obtener mejor respuesta.",
        },
        context: {
          type: "string",
          description:
            "Contexto adicional del CRM relevante para la consulta (ej: datos de pipeline, nombre de cuenta, métricas).",
        },
      },
      required: ["query"],
    },
  },
};

export async function handleJarvisPull(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  if (!JARVIS_KEY) {
    return JSON.stringify({
      error:
        "Integración con Jarvis no configurada. Contacta al administrador.",
    });
  }

  const query = args.query as string;
  const context = args.context as string | undefined;
  const role = ctx.rol ?? "ae";

  try {
    const response = await fetch(`${JARVIS_URL}/api/jarvis-pull`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": JARVIS_KEY,
      },
      body: JSON.stringify({ query, role, context }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return JSON.stringify({
        error: `Jarvis no disponible (${response.status}): ${body.slice(0, 200)}`,
      });
    }

    const data = (await response.json()) as {
      response: string;
      role: string;
      tokens: number;
    };
    return JSON.stringify({
      analisis: data.response,
      fuente: "Jarvis Intelligence",
      rol_aplicado: data.role,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({
      error: `Error conectando con Jarvis: ${message}`,
    });
  }
}
