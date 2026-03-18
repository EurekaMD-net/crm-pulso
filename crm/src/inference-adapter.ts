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

const TIMEOUT_MS = parseInt(process.env.INFERENCE_TIMEOUT_MS ?? "30000", 10);
const MAX_TOKENS = parseInt(process.env.INFERENCE_MAX_TOKENS ?? "2048", 10);

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
    max_tokens: request.max_tokens ?? MAX_TOKENS,
    stream: streaming,
  };
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = "auto";
  }
  // Disable reasoning/thinking mode for faster responses (Qwen 3.5+ only)
  if (provider.model.startsWith("qwen3")) {
    body.enable_thinking = false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

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

            // Capture usage from final chunk
            if (chunk.usage) usage = chunk.usage;
          } catch {
            /* skip malformed chunks */
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

    let providerSucceeded = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await callProvider(provider, request, onTextChunk);
        breaker.recordSuccess();
        providerSucceeded = true;
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const statusMatch = lastError.message.match(/HTTP (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
        if (status === 429 || (status >= 500 && status < 600)) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          logger.warn(
            { provider: provider.name, attempt, status, delay },
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
  const TOOL_CHAIN_WARNING = 8;

  for (let round = 0; round < maxRounds; round++) {
    // Fix #1: Check total elapsed time before each round — return partial results instead of crashing
    if (Date.now() - startTime > totalTimeoutMs) {
      logger.warn(
        { round, elapsed: Date.now() - startTime, totalTimeoutMs },
        "total tool-loop timeout reached, returning partial results",
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

    // Fix #2: After 8 consecutive tool rounds, hint the LLM to summarize and respond
    if (round === TOOL_CHAIN_WARNING) {
      conversation.push({
        role: "system" as const,
        content:
          "AVISO DEL SISTEMA: Has hecho muchas llamadas de herramientas consecutivas. " +
          "Resume lo que has encontrado hasta ahora y responde al usuario con la informacion disponible. " +
          "No hagas mas llamadas de herramientas a menos que sea estrictamente necesario.",
      });
    }

    // Stream text on every call — Qwen returns content: null with tool_calls,
    // so text chunks only arrive on the final (non-tool) response.
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
      return {
        content,
        messages: conversation,
        totalUsage: {
          prompt_tokens: totalPrompt,
          completion_tokens: totalCompletion,
        },
      };
    }

    // Execute tool calls in parallel, sanitizing truncated arguments
    const sanitizedToolCalls: typeof response.tool_calls = [];
    const toolResults = await Promise.all(
      response.tool_calls.map(async (toolCall) => {
        let result: string;
        const rawArgs = toolCall.function.arguments;
        // Detect likely truncation: unclosed braces/brackets
        const opens = (rawArgs.match(/[{[]/g) || []).length;
        const closes = (rawArgs.match(/[}\]]/g) || []).length;
        const truncated = opens > closes;

        // Sanitize: replace truncated arguments with valid JSON so the
        // conversation history stays valid for the next provider call
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
          logger.warn(
            { tool: toolCall.function.name, argsLen: rawArgs.length },
            "tool call JSON truncated",
          );
        } else {
          try {
            const args = JSON.parse(rawArgs) as Record<string, unknown>;
            result = await executor(toolCall.function.name, args);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            result = JSON.stringify({ error: message });
            logger.error(
              { tool: toolCall.function.name, error: message },
              "tool execution failed",
            );
          }
        }

        return {
          role: "tool" as const,
          content: result,
          tool_call_id: toolCall.id,
        };
      }),
    );

    // Append assistant message with sanitized tool calls + results
    conversation.push({
      role: "assistant",
      content: response.content,
      tool_calls: sanitizedToolCalls,
    });
    conversation.push(...toolResults);
  }

  // Safety: hit max rounds — return last content or empty
  const lastAssistant = [...conversation]
    .reverse()
    .find((m) => m.role === "assistant");
  return {
    content:
      (typeof lastAssistant?.content === "string"
        ? lastAssistant.content
        : null) ?? "[max tool rounds reached]",
    messages: conversation,
    totalUsage: {
      prompt_tokens: totalPrompt,
      completion_tokens: totalCompletion,
    },
  };
}
