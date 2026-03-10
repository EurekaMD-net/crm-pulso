/**
 * Sentiment Classifier — LLM-based classification via inference adapter
 *
 * Provides zero-shot sentiment classification for activity summaries.
 * Uses the primary inference provider (Qwen 3.5) with low temperature
 * for consistent classification. ~30 tokens per call, negligible cost.
 *
 * classifySentiment — async classification returning { label, score }
 * classifyAndUpdate — fire-and-forget: classify and UPDATE actividad row
 */

import { infer } from "./inference-adapter.js";
import { getDatabase } from "./db.js";
import { logger as parentLogger } from "./logger.js";

const logger = parentLogger.child({ component: "sentiment" });

const SENTIMENT_SYSTEM_PROMPT = `Clasifica el sentimiento de esta actividad comercial de ventas de publicidad en medios.
Responde UNICAMENTE con JSON valido, sin texto adicional: {"label": "X", "score": N}

Categorias:
- "positivo": avance en deal, buena recepcion, cierre cercano, OC recibida, feedback favorable
- "neutral": seguimiento rutinario, informacion compartida, agenda confirmada, sin cambio de status
- "negativo": rechazo, objeciones fuertes, perdida de interes, presupuesto cancelado, sin respuesta prolongada
- "urgente": deadline inmediato, riesgo de perdida inminente, escalacion, competidor entrando

score: tu confianza en la clasificacion (0.0 = no se, 1.0 = muy seguro)`;

export async function classifySentiment(
  text: string,
): Promise<{ label: string; score: number }> {
  try {
    const response = await infer({
      messages: [
        { role: "system", content: SENTIMENT_SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      temperature: 0.1,
      max_tokens: 40,
    });

    const raw = (response.content || "").trim();
    // Extract JSON from response (handle markdown fences or extra text)
    const jsonMatch = raw.match(/\{[^}]+\}/);
    if (!jsonMatch) {
      logger.warn({ raw }, "Sentiment: no JSON found in response");
      return { label: "neutral", score: 0 };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const validLabels = ["positivo", "neutral", "negativo", "urgente"];
    const label = validLabels.includes(parsed.label) ? parsed.label : "neutral";
    const score =
      typeof parsed.score === "number"
        ? Math.max(0, Math.min(1, parsed.score))
        : 0.5;

    return { label, score };
  } catch (err) {
    logger.warn(
      { err },
      "Sentiment classification failed, defaulting to neutral",
    );
    return { label: "neutral", score: 0 };
  }
}

/**
 * Fire-and-forget: classify sentiment of an activity and update the DB row.
 * Does not throw — logs errors and moves on.
 */
export function classifyAndUpdate(activityId: string, resumen: string): void {
  classifySentiment(resumen)
    .then(({ label, score }) => {
      const db = getDatabase();
      db.prepare(
        "UPDATE actividad SET sentimiento = ?, sentimiento_score = ? WHERE id = ?",
      ).run(label, score, activityId);
      logger.debug({ activityId, label, score }, "Sentiment auto-classified");
    })
    .catch((err) => {
      logger.warn({ activityId, err }, "Sentiment classify-and-update failed");
    });
}
