/**
 * Jarvis Pull — request strategic analysis from the Jarvis system.
 *
 * Trigger: "pregúntale/pídele a Jarvis", "consulta con Jarvis"
 * Flow: acknowledge → call Jarvis → create Google Doc → share link
 *
 * Response depth scales by role (ae/gerente/director/vp).
 */

import type { ToolContext } from "./index.js";
import { isWorkspaceEnabled, getProvider } from "../workspace/provider.js";
import { getPersonaEmail } from "./helpers.js";

const JARVIS_URL = process.env.JARVIS_API_URL ?? "http://localhost:8080";
const JARVIS_KEY = process.env.JARVIS_API_KEY ?? "";

export const TOOL_JARVIS_PULL = {
  type: "function" as const,
  function: {
    name: "jarvis_pull",
    description: `Solicitar análisis estratégico del sistema Jarvis (asistente de inteligencia del VP).

TRIGGER: Cuando el usuario dice "pregúntale a Jarvis", "pídele a Jarvis que...", "consulta con Jarvis", "que opina Jarvis", "Jarvis qué recomienda".

FLUJO:
1. Confirma al usuario: "Consultando con Jarvis..."
2. Envía la consulta a Jarvis
3. Crea un Google Doc con el análisis formateado
4. Comparte el enlace del documento

CUÁNDO USAR:
- El usuario pide explícitamente consultar a Jarvis
- Necesitas contexto de mercado, tendencias, o análisis que va más allá del CRM
- El usuario quiere una segunda opinión estratégica

NO USAR:
- Para datos que ya tienes en el CRM (pipeline, cuotas, actividades)
- Si el usuario no menciona a Jarvis explícitamente

La profundidad se ajusta automáticamente según tu rol.`,
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "La pregunta o solicitud de análisis para Jarvis. Sé específico.",
        },
        context: {
          type: "string",
          description:
            "Contexto del CRM relevante (datos de pipeline, cuenta, métricas). Mejora la calidad del análisis.",
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

  // Step 1: Call Jarvis
  let analysisText: string;
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
    analysisText = data.response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({
      error: `Error conectando con Jarvis: ${message}`,
    });
  }

  // Step 2: Create Google Doc with the analysis
  const now = new Date();
  const dateStr = now.toLocaleDateString("es-MX", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/Mexico_City",
  });
  const docTitle = `Análisis Jarvis — ${dateStr}`;

  const docContent =
    `# ${docTitle}\n\n` +
    `**Consulta:** ${query}\n` +
    `**Rol:** ${role}\n` +
    `**Fecha:** ${dateStr}\n\n` +
    `---\n\n` +
    `${analysisText}\n\n` +
    `---\n\n` +
    `*Generado por Jarvis Intelligence System*`;

  let docLink: string | undefined;

  if (isWorkspaceEnabled()) {
    const email = getPersonaEmail(ctx.persona_id);
    if (email) {
      try {
        const result = await getProvider().createDocument(
          email,
          docTitle,
          "documento",
          docContent,
        );
        docLink = result.enlace ?? undefined;
      } catch {
        // Doc creation failed — still return the analysis as text
      }
    }
  }

  return JSON.stringify({
    status: "Análisis de Jarvis completado",
    analisis: analysisText,
    ...(docLink && {
      documento: docLink,
      mensaje: `📄 Documento creado: ${docLink}`,
    }),
    ...(!docLink && {
      nota: "Análisis entregado como texto (Google Drive no disponible para crear documento).",
    }),
    fuente: "Jarvis Intelligence",
    rol_aplicado: role,
  });
}
