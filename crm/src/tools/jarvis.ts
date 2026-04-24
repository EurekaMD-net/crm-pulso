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
import { logger as parentLogger } from "../logger.js";

const logger = parentLogger.child({ component: "jarvis-pull" });

// Read at call time, not import time — secrets are injected after module load.
function getJarvisConfig() {
  return {
    url: process.env.JARVIS_API_URL ?? "http://172.17.0.1:8080",
    key: process.env.JARVIS_API_KEY ?? "",
  };
}

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
  const { url: jarvisUrl, key: jarvisKey } = getJarvisConfig();
  logger.debug({ url: jarvisUrl, keySet: !!jarvisKey }, "jarvis pull starting");

  if (!jarvisKey) {
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
    const response = await fetch(`${jarvisUrl}/api/jarvis-pull`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": jarvisKey,
      },
      body: JSON.stringify({ query, role, context }),
      // 110s = primary budget. The agent-runner has a 120s per-tool cap
      // (TOOL_TIMEOUTS["jarvis_pull"] in agent-runner/index.ts) that
      // sits 10s above this — so the fetch's AbortSignal fires first
      // under every observed failure mode, giving us a clean
      // tool-result error instead of a runner-level guillotine.
      // The runner cap is the safety net for "mc hung past 110s".
      // Realistic mc cascade worst case (3 providers × 30s timeouts +
      // double-infer on near-empty response) is ~110s, so 110s leaves
      // zero headroom — a single retry-on-short pushes us past, which
      // is acceptable: that's exactly when we want to give up on this
      // turn and let the agent answer from its own knowledge.
      signal: AbortSignal.timeout(110_000),
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

  const wsEnabled = isWorkspaceEnabled();
  const email = getPersonaEmail(ctx.persona_id);
  logger.debug(
    { workspace: wsEnabled, email: email ?? null, persona: ctx.persona_id },
    "jarvis pull workspace resolved",
  );

  if (wsEnabled && email) {
    try {
      const result = await getProvider().createDocument(
        email,
        docTitle,
        "documento",
        docContent,
      );
      docLink = result.enlace ?? undefined;
      logger.info({ docLink: docLink ?? null }, "jarvis pull doc created");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "jarvis pull doc creation failed",
      );
    }
  }

  // Return PRE-FORMATTED text — not JSON. LLMs narrativize JSON but relay
  // pre-formatted text more faithfully (feedback_preformat_over_prompt pattern).
  if (docLink) {
    return (
      `📄 **Análisis de Jarvis:** ${docLink}\n` +
      `El documento está listo para compartir con tu equipo.\n\n` +
      `---\n` +
      `_Resumen: ${analysisText.slice(0, 300)}..._\n` +
      `📎 Fuente: Jarvis Intelligence (rol: ${role})`
    );
  }
  return (
    `📄 **Análisis de Jarvis** (rol: ${role})\n\n` +
    `---\n` +
    `${analysisText}\n` +
    `---\n\n` +
    `⚠️ INSTRUCCIÓN: El texto entre las líneas "---" es de Jarvis. ` +
    `Preséntalo TAL CUAL al usuario. Tus comentarios van DESPUÉS, ` +
    `separados con "---" y encabezado "Mi observación:".`
  );
}
