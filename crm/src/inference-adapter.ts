/**
 * Inference Adapter — OpenAI-compatible multi-provider LLM client
 *
 * Sends requests to configurable providers (Qwen, MiniMax, vLLM, etc.)
 * using the OpenAI chat completions API format. Supports:
 *   - Primary + fallback provider with automatic failover
 *   - OpenAI function-calling tool format
 *   - Multi-turn tool call execution loop
 *   - Latency and token usage logging
 */

import { logger as parentLogger } from "./logger.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { repairSession } from "./session-repair.js";
import {
  createDoomLoopState,
  updateDoomLoop,
  type DoomLoopSignal,
} from "./doom-loop.js";
import { maybeEvict } from "./tool-eviction.js";
import { compressContext } from "./context-compressor.js";
import {
  analyzeInjection,
  buildInjectionWarning,
  isUntrustedTool,
} from "./injection-guard.js";
import { toolMetrics } from "./tool-metrics.js";
import { checkPreflight } from "./preflight.js";
import { recordCost, getThreeWindowStatus } from "./budget.js";

const logger = parentLogger.child({ component: "inference" });

// ---------------------------------------------------------------------------
// Per-provider circuit breakers
// ---------------------------------------------------------------------------

const providerBreakers = new Map<string, CircuitBreaker>();

function getBreakerForProvider(name: string): CircuitBreaker {
  let breaker = providerBreakers.get(name);
  if (!breaker) {
    breaker = new CircuitBreaker({ name: `inference:${name}` });
    providerBreakers.set(name, breaker);
  }
  return breaker;
}

/** @internal — exposed for testing only */
export function _resetProviderBreakers(): void {
  providerBreakers.clear();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InferenceProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  priority: number;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Content can be a string or multimodal array (OpenAI vision format). */
export type ChatContent =
  | string
  | null
  | Array<{ type: string; [key: string]: unknown }>;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ChatContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface InferenceRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
}

export interface InferenceResponse {
  content: string | null;
  tool_calls?: ToolCall[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  provider: string;
  latency_ms: number;
}

export interface ToolExecutor {
  (name: string, args: Record<string, unknown>): Promise<string>;
}

// ---------------------------------------------------------------------------
// Provider configuration from env
// ---------------------------------------------------------------------------

function loadProviders(): InferenceProvider[] {
  const providers: InferenceProvider[] = [];

  const primaryUrl = process.env.INFERENCE_PRIMARY_URL;
  const primaryKey = process.env.INFERENCE_PRIMARY_KEY;
  const primaryModel = process.env.INFERENCE_PRIMARY_MODEL;

  if (primaryUrl && primaryModel) {
    providers.push({
      name: "primary",
      baseUrl: primaryUrl.replace(/\/+$/, ""),
      apiKey: primaryKey ?? "",
      model: primaryModel,
      priority: 0,
    });
  }

  const fallbackUrl = process.env.INFERENCE_FALLBACK_URL;
  const fallbackKey = process.env.INFERENCE_FALLBACK_KEY;
  const fallbackModel = process.env.INFERENCE_FALLBACK_MODEL;

  if (fallbackUrl && fallbackModel) {
    providers.push({
      name: "fallback",
      baseUrl: fallbackUrl.replace(/\/+$/, ""),
      apiKey: fallbackKey ?? "",
      model: fallbackModel,
      priority: 1,
    });
  }

  return providers.sort((a, b) => a.priority - b.priority);
}

// ---------------------------------------------------------------------------
// HTTP call to a single provider
// ---------------------------------------------------------------------------

// Read lazily so secrets injected via stdin (container) take effect
function getTimeoutMs(): number {
  return parseInt(process.env.INFERENCE_TIMEOUT_MS ?? "90000", 10);
}
function getMaxTokens(): number {
  return parseInt(process.env.INFERENCE_MAX_TOKENS ?? "2048", 10);
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export type OnTextChunk = (text: string) => void;

async function callProvider(
  provider: InferenceProvider,
  request: InferenceRequest,
  onTextChunk?: OnTextChunk,
): Promise<InferenceResponse> {
  const url = `${provider.baseUrl}/chat/completions`;
  const start = Date.now();
  const streaming = !!onTextChunk;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (provider.apiKey) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: provider.model,
    messages: request.messages,
    max_tokens: request.max_tokens ?? getMaxTokens(),
    stream: streaming,
    // Request usage stats in the final SSE chunk (OpenAI-compatible standard).
    // Without this, streaming responses report 0 prompt/completion tokens.
    ...(streaming && { stream_options: { include_usage: true } }),
  };
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = "auto";
  }
  // Disable reasoning/thinking mode for faster responses (Qwen 3.5+, GLM-5+)
  if (provider.model.startsWith("qwen3") || provider.model.startsWith("glm-")) {
    body.enable_thinking = false;
  }

  const controller = new AbortController();
  const timeoutMs = getTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    let result: InferenceResponse;

    if (streaming && response.body) {
      // Parse SSE stream, emit text deltas, accumulate full response
      result = await parseSSEStream(
        response.body,
        provider,
        start,
        onTextChunk,
      );
    } else {
      const data = (await response.json()) as OpenAIResponse;
      const choice = data.choices?.[0];
      if (!choice) throw new Error("Empty response: no choices returned");
      result = {
        content: choice.message.content,
        tool_calls: choice.message.tool_calls,
        usage: data.usage ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
        provider: provider.name,
        latency_ms: Date.now() - start,
      };
    }

    // Detect empty responses: HTTP 200 but no useful output.
    // Some providers (GLM-5) intermittently return empty SSE streams.
    // Treat as retriable error so fallback provider gets a chance.
    const hasContent = !!result.content;
    const hasToolCalls = (result.tool_calls?.length ?? 0) > 0;
    if (!hasContent && !hasToolCalls) {
      logger.warn(
        {
          provider: provider.name,
          model: provider.model,
          latency_ms: result.latency_ms,
          prompt_tokens: result.usage.prompt_tokens,
          completion_tokens: result.usage.completion_tokens,
        },
        "empty response from provider (no content, no tool_calls)",
      );
      throw new Error(
        `HTTP 500: Empty response from ${provider.name} (0 content, 0 tool_calls after ${result.latency_ms}ms)`,
      );
    }

    logger.info(
      {
        provider: provider.name,
        model: provider.model,
        latency_ms: result.latency_ms,
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: result.usage.completion_tokens,
        tool_calls: result.tool_calls?.length ?? 0,
      },
      "inference request completed",
    );

    return result;
  } finally {
    clearTimeout(timeout);
  }
}

/** Parse an OpenAI-compatible SSE stream, emitting text deltas via callback. */
async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  provider: InferenceProvider,
  startTime: number,
  onTextChunk: OnTextChunk,
): Promise<InferenceResponse> {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls: Map<number, ToolCall> = new Map();
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 2);

        for (const line of event.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const chunk = JSON.parse(data);

            // Capture usage first — final SSE chunk has `usage` but empty
            // `choices`, so it would be skipped by the `if (!delta) continue`
            // guard below. Must run before the early-return.
            if (chunk.usage) usage = chunk.usage;

            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // Accumulate text content and emit to callback
            if (delta.content) {
              content += delta.content;
              onTextChunk(delta.content);
            }

            // Accumulate tool calls
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const existing = toolCalls.get(idx);
                if (!existing) {
                  toolCalls.set(idx, {
                    id: tc.id ?? "",
                    type: "function",
                    function: {
                      name: tc.function?.name ?? "",
                      arguments: tc.function?.arguments ?? "",
                    },
                  });
                } else {
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name)
                    existing.function.name += tc.function.name;
                  if (tc.function?.arguments)
                    existing.function.arguments += tc.function.arguments;
                }
              }
            }
          } catch (err) {
            // Skip malformed chunks but surface them so stream corruption is
            // visible. Sample only the first 200 chars to bound log size.
            const sample = data.length > 200 ? data.slice(0, 200) + "…" : data;
            logger.warn(
              {
                err: err instanceof Error ? err.message : String(err),
                sample,
                bufferTail: buffer.length,
              },
              "SSE chunk parse failed",
            );
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const assembledToolCalls =
    toolCalls.size > 0 ? Array.from(toolCalls.values()) : undefined;

  return {
    content: content || null,
    tool_calls: assembledToolCalls,
    usage,
    provider: provider.name,
    latency_ms: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a single inference request with automatic failover.
 * Tries providers in priority order; falls back on timeout, network error, or 5xx.
 * Optional onTextChunk enables SSE streaming — text deltas are emitted as they arrive.
 */
export async function infer(
  request: InferenceRequest,
  onTextChunk?: OnTextChunk,
): Promise<InferenceResponse> {
  const providers = loadProviders();
  if (providers.length === 0) {
    throw new Error(
      "No inference providers configured. Set INFERENCE_PRIMARY_URL and INFERENCE_PRIMARY_MODEL.",
    );
  }

  // Hard budget guard: refuse new inference once the monthly window is
  // exceeded. Hourly/daily are intentionally NOT enforced — they spike under
  // legit bursty traffic and a hard fail mid-conversation is worse than the
  // overage. The monthly cap is the real cost-of-business ceiling.
  // Set BUDGET_ENFORCE=0 to disable (e.g. during incident response).
  if (process.env.BUDGET_ENFORCE !== "0") {
    let status: ReturnType<typeof getThreeWindowStatus> | null = null;
    try {
      status = getThreeWindowStatus();
    } catch (err) {
      // DB/schema errors (e.g. ledger table missing in test envs, or PG outage)
      // must not break inference. Surface them so ops can see the guard is
      // currently masked.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "budget guard: ledger lookup failed — guard inactive this call",
      );
    }
    if (status?.monthly.exceeded) {
      // Always rethrows — never swallowed by the catch above.
      throw new Error(
        `Monthly budget exceeded ($${status.monthly.spend.toFixed(2)} / $${status.monthly.limit.toFixed(2)}). Set BUDGET_ENFORCE=0 to override.`,
      );
    }
  }

  // Detect if request contains image content (multimodal)
  const hasImages = request.messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some(
        (b: { type: string }) => b.type === "image_url" || b.type === "image",
      ),
  );

  let lastError: Error | undefined;

  for (const provider of providers) {
    const breaker = getBreakerForProvider(provider.name);

    // Skip provider entirely if circuit is open
    if (breaker.isOpen()) {
      logger.warn(
        { provider: provider.name },
        "circuit open, skipping provider",
      );
      continue;
    }

    // Skip non-vision providers when request contains images.
    // Vision-capable: qwen3.6-plus, qwen3.5-plus, qwen-vl-*, gpt-4o*, claude-*
    // Non-vision: glm-5, glm-4-*, minimax-*
    if (hasImages) {
      const model = provider.model.toLowerCase();
      const isVisionCapable =
        model.includes("qwen3") ||
        model.includes("qwen-vl") ||
        model.includes("gpt-4o") ||
        model.includes("claude");
      if (!isVisionCapable) {
        logger.info(
          { provider: provider.name, model: provider.model },
          "skipping non-vision provider for image request",
        );
        continue;
      }
    }

    let providerSucceeded = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await callProvider(provider, request, onTextChunk);
        breaker.recordSuccess();
        providerSucceeded = true;
        // Record cost per successful call so every infer() path is billed —
        // not just inferWithTools (which used to be the only writer, leaving
        // sentiment.ts and map-reduce-summarizer.ts invisible to the ledger).
        try {
          recordCost({
            model: provider.model,
            promptTokens: result.usage.prompt_tokens,
            completionTokens: result.usage.completion_tokens,
            provider: provider.name,
          });
        } catch (err) {
          logger.warn(
            { error: err instanceof Error ? err.message : String(err) },
            "failed to record cost",
          );
        }
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const statusMatch = lastError.message.match(/HTTP (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
        const isAbort =
          lastError.name === "AbortError" ||
          lastError.message.includes("operation was aborted");
        if (status === 429 || (status >= 500 && status < 600) || isAbort) {
          // Abort = timeout, retry once then move to next provider
          if (isAbort && attempt >= 1) break;
          const delay = isAbort
            ? 2000
            : Math.min(1000 * Math.pow(2, attempt), 8000);
          logger.warn(
            { provider: provider.name, attempt, status, delay, isAbort },
            "retryable error, backing off",
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break; // non-retryable error, try next provider
      }
    }

    if (!providerSucceeded) {
      breaker.recordFailure(lastError);
      logger.warn(
        { provider: provider.name, error: lastError?.message },
        "provider failed, trying next",
      );
    }
  }

  throw new Error(
    `All inference providers failed. Last error: ${lastError?.message}`,
  );
}

/**
 * Run a full multi-turn conversation with tool execution.
 *
 * Sends messages to the LLM. If the LLM returns tool_calls, executes them
 * via the provided executor, appends results, and loops until the LLM
 * returns a text response (no more tool calls).
 *
 * @param messages - Conversation history
 * @param tools - Available tool definitions
 * @param executor - Function that executes a tool by name and returns the result string
 * @param maxRounds - Safety limit on tool call rounds (default 10)
 * @returns Final assistant text content and full conversation history
 */
export async function inferWithTools(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  executor: ToolExecutor,
  maxRounds = 10,
  onTextChunk?: OnTextChunk,
): Promise<{
  content: string;
  messages: ChatMessage[];
  totalUsage: { prompt_tokens: number; completion_tokens: number };
}> {
  const conversation = [...messages];
  let totalPrompt = 0;
  let totalCompletion = 0;
  const startTime = Date.now();
  const totalTimeoutMs = parseInt(
    process.env.INFERENCE_TOTAL_TIMEOUT_MS ?? "120000",
    10,
  );
  // Per-round prompt-size cap. NOT a cost cap — this is "how big can a single
  // round's input get before we abort the loop." Must be >= the compression
  // threshold (0.8 × contextLimit = 80k by default), otherwise the budget
  // trips before the compressor gets a chance to free space, and fresh
  // sessions with a large persona + 71 tool defs (~26k baseline) fail their
  // very first call. Was 25000 — too tight for Qwen3.6-plus-class contexts.
  const tokenBudget = parseInt(
    process.env.INFERENCE_TOKEN_BUDGET ?? "80000",
    10,
  );
  // Default sized for GLM-5 / Qwen3.6-plus (~128k tokens) with headroom for
  // completion and tool-call JSON. Compression triggers at 0.8 × this (80k).
  // Override with INFERENCE_CONTEXT_LIMIT env var if using a smaller model.
  const contextLimit = parseInt(
    process.env.INFERENCE_CONTEXT_LIMIT ?? "100000",
    10,
  );
  const TOOL_CHAIN_WARNING = 8;
  const MIN_REMAINING_MS = 15_000;

  // Track why the loop terminated so the fallback message is honest.
  // "max_rounds" is only true when we genuinely walked all maxRounds turns.
  let exitReason: "max_rounds" | "token_budget" | "timeout" = "max_rounds";

  // Per-call cost recording happens inside infer() now — every round writes
  // its own ledger row with the actual provider that served it. buildResult
  // only assembles the return value with the running totals.
  function buildResult(content: string, _lastProvider?: string) {
    return {
      content,
      messages: conversation,
      totalUsage: {
        prompt_tokens: totalPrompt,
        completion_tokens: totalCompletion,
      },
    };
  }

  // --- Session repair: fix structural anomalies before first call ---
  const repairStats = repairSession(conversation);
  if (
    repairStats.orphanedToolResults > 0 ||
    repairStats.syntheticErrors > 0 ||
    repairStats.dedupedResults > 0 ||
    repairStats.mergedMessages > 0
  ) {
    logger.info({ repairStats }, "session repaired before inference");
  }

  // --- Doom-loop detection state ---
  const doomState = createDoomLoopState();

  // --- Escalation level: nudge(0) → warn(1) → force-wrap(2) → abort(3) ---
  let escalationLevel = 0;

  for (let round = 0; round < maxRounds; round++) {
    const elapsed = Date.now() - startTime;
    const remaining = totalTimeoutMs - elapsed;

    // Time guard
    if (remaining < MIN_REMAINING_MS) {
      logger.warn(
        { round, elapsed, remaining, totalTimeoutMs },
        remaining <= 0
          ? "total tool-loop timeout reached, returning partial results"
          : "insufficient time for next round, returning partial results",
      );
      const lastAssistant = [...conversation]
        .reverse()
        .find((m) => m.role === "assistant");
      return {
        content:
          (typeof lastAssistant?.content === "string"
            ? lastAssistant.content
            : null) ??
          "[Tiempo limite alcanzado. Se devuelven los resultados parciales obtenidos.]",
        messages: conversation,
        totalUsage: {
          prompt_tokens: totalPrompt,
          completion_tokens: totalCompletion,
        },
      };
    }

    // --- Context compression: prevent context window overflow ---
    const compression = compressContext(conversation, contextLimit);
    if (compression.changes > 0) {
      logger.info(
        { level: compression.level, changes: compression.changes, round },
        "context compressed",
      );
    }

    // After 8 consecutive tool rounds, hint the LLM to summarize and respond
    if (round === TOOL_CHAIN_WARNING) {
      conversation.push({
        role: "system" as const,
        content:
          "AVISO DEL SISTEMA: Has hecho muchas llamadas de herramientas consecutivas. " +
          "Resume lo que has encontrado hasta ahora y responde al usuario con la informacion disponible. " +
          "No hagas mas llamadas de herramientas a menos que sea estrictamente necesario.",
      });
    }

    // --- Graduated escalation injection ---
    if (escalationLevel === 1) {
      conversation.push({
        role: "system" as const,
        content:
          "AVISO: Se detectó un patrón repetitivo en tus llamadas de herramientas. " +
          "Cambia de estrategia o responde con la información que ya tienes.",
      });
    } else if (escalationLevel >= 2) {
      // Force wrap-up: remove tools to prevent further calls
      logger.warn(
        { round, escalationLevel },
        "doom loop escalation: forcing wrap-up (no tools)",
      );
      const response = await infer({ messages: conversation }, onTextChunk);
      totalPrompt += response.usage.prompt_tokens;
      totalCompletion += response.usage.completion_tokens;
      const content =
        response.content ??
        "[El sistema detectó un bucle y detuvo las llamadas de herramientas.]";
      conversation.push({ role: "assistant", content });
      return buildResult(content, response.provider);
    }

    const response = await infer(
      { messages: conversation, tools },
      onTextChunk,
    );
    totalPrompt += response.usage.prompt_tokens;
    totalCompletion += response.usage.completion_tokens;

    // No tool calls — final text response
    if (!response.tool_calls || response.tool_calls.length === 0) {
      const content = response.content ?? "";
      conversation.push({ role: "assistant", content });
      return buildResult(content, response.provider);
    }

    // Execute tool calls in parallel, with preflight + eviction + injection scanning.
    // allSettled (not all): an unhandled throw in a sibling tool — e.g. from
    // maybeEvict/analyzeInjection/toolMetrics outside the inner try — must not
    // poison the whole round.
    const sanitizedToolCalls: typeof response.tool_calls = [];
    const settled = await Promise.allSettled(
      response.tool_calls.map(async (toolCall) => {
        let result: string;
        const toolName = toolCall.function.name;
        const rawArgs = toolCall.function.arguments;
        const toolStart = Date.now();
        let success = true;

        // Detect truncation
        const opens = (rawArgs.match(/[{[]/g) || []).length;
        const closes = (rawArgs.match(/[}\]]/g) || []).length;
        const truncated = opens > closes;

        sanitizedToolCalls.push(
          truncated
            ? {
                ...toolCall,
                function: { ...toolCall.function, arguments: "{}" },
              }
            : toolCall,
        );

        if (truncated) {
          result = JSON.stringify({
            error: "Tool call truncated (max_tokens hit). Try a simpler query.",
          });
          success = false;
          logger.warn(
            { tool: toolName, argsLen: rawArgs.length },
            "tool call JSON truncated",
          );
        } else {
          try {
            const args = JSON.parse(rawArgs) as Record<string, unknown>;

            // --- Pre-flight validation ---
            const preflightError = checkPreflight(toolName, args);
            if (preflightError) {
              result = JSON.stringify({ error: preflightError });
              success = false;
              logger.warn(
                { tool: toolName, error: preflightError },
                "preflight check failed",
              );
            } else {
              result = await executor(toolName, args);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            result = JSON.stringify({ error: message });
            success = false;
            logger.error(
              { tool: toolName, error: message },
              "tool execution failed",
            );
          }
        }

        // --- Injection scanning BEFORE eviction (scan full content, not truncated) ---
        if (isUntrustedTool(toolName)) {
          const injection = analyzeInjection(result, toolName);
          if (injection.risk === "high" || injection.risk === "medium") {
            const warning = buildInjectionWarning(injection);
            result = warning + result;
            logger.warn(
              {
                tool: toolName,
                risk: injection.risk,
                detections: injection.detections,
              },
              "injection detected in tool result",
            );
          }
        }

        // --- Tool result eviction (oversized results → temp file) ---
        result = await maybeEvict(result, toolName);

        // --- Record tool metrics ---
        toolMetrics.record(toolName, Date.now() - toolStart, success);

        return {
          role: "tool" as const,
          content: result,
          tool_call_id: toolCall.id,
        };
      }),
    );

    // Map settled results to tool messages; rejections become a synthetic
    // error tool_result so the conversation stays well-formed (every tool_call
    // gets exactly one corresponding tool message).
    const toolResults = settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      const toolCall = response.tool_calls![i];
      const message =
        s.reason instanceof Error ? s.reason.message : String(s.reason);
      logger.error(
        { tool: toolCall.function.name, error: message },
        "tool wrapper rejected (post-execution)",
      );
      return {
        role: "tool" as const,
        content: JSON.stringify({ error: `Tool wrapper failed: ${message}` }),
        tool_call_id: toolCall.id,
      };
    });

    // Append assistant message with sanitized tool calls + results
    conversation.push({
      role: "assistant",
      content: response.content,
      tool_calls: sanitizedToolCalls,
    });
    conversation.push(...toolResults);

    // --- Doom-loop detection ---
    const doomSignal: DoomLoopSignal | null = updateDoomLoop(doomState, {
      toolCalls: sanitizedToolCalls,
      toolResults: toolResults.map((r) => ({ content: r.content })),
      llmText: response.content ?? "",
    });

    if (doomSignal) {
      logger.warn(
        {
          round,
          layer: doomSignal.layer,
          severity: doomSignal.severity,
          description: doomSignal.description,
        },
        "doom loop detected",
      );
      // Graduated escalation
      if (doomSignal.severity === "high") {
        escalationLevel = Math.max(escalationLevel + 1, 2);
      } else {
        escalationLevel++;
      }
    }

    // Token budget check (per-round prompt size, not cumulative spend)
    if (response.usage.prompt_tokens >= tokenBudget) {
      logger.warn(
        {
          round,
          promptTokens: response.usage.prompt_tokens,
          tokenBudget,
          totalPrompt,
        },
        "token budget exceeded, forcing early exit",
      );
      exitReason = "token_budget";
      break;
    }
  }

  // Loop exited without a final text response. Use the last assistant text
  // if any, otherwise a Spanish-facing message that names the actual reason
  // — was misleadingly always "max tool rounds reached" before.
  const lastAssistant = [...conversation]
    .reverse()
    .find((m) => m.role === "assistant");
  const reasonMessage =
    exitReason === "token_budget"
      ? "[Conversacion demasiado larga. Inicia una nueva sesion para continuar.]"
      : "[Limite de pasos alcanzado. Reformula la pregunta o pide un alcance mas acotado.]";
  const fallbackContent =
    (typeof lastAssistant?.content === "string" && lastAssistant.content
      ? lastAssistant.content
      : null) ?? reasonMessage;
  return buildResult(fallbackContent);
}
