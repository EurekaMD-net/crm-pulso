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

import { logger as parentLogger } from './logger.js';

const logger = parentLogger.child({ component: 'inference' });

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
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
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
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
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
      name: 'primary',
      baseUrl: primaryUrl.replace(/\/+$/, ''),
      apiKey: primaryKey ?? '',
      model: primaryModel,
      priority: 0,
    });
  }

  const fallbackUrl = process.env.INFERENCE_FALLBACK_URL;
  const fallbackKey = process.env.INFERENCE_FALLBACK_KEY;
  const fallbackModel = process.env.INFERENCE_FALLBACK_MODEL;

  if (fallbackUrl && fallbackModel) {
    providers.push({
      name: 'fallback',
      baseUrl: fallbackUrl.replace(/\/+$/, ''),
      apiKey: fallbackKey ?? '',
      model: fallbackModel,
      priority: 1,
    });
  }

  return providers.sort((a, b) => a.priority - b.priority);
}

// ---------------------------------------------------------------------------
// HTTP call to a single provider
// ---------------------------------------------------------------------------

const TIMEOUT_MS = parseInt(process.env.INFERENCE_TIMEOUT_MS ?? '30000', 10);
const MAX_TOKENS = parseInt(process.env.INFERENCE_MAX_TOKENS ?? '4096', 10);

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

async function callProvider(
  provider: InferenceProvider,
  request: InferenceRequest,
): Promise<InferenceResponse> {
  const url = `${provider.baseUrl}/chat/completions`;
  const start = Date.now();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: provider.model,
    messages: request.messages,
    max_tokens: request.max_tokens ?? MAX_TOKENS,
  };
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as OpenAIResponse;
    const latency = Date.now() - start;

    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error('Empty response: no choices returned');
    }

    const result: InferenceResponse = {
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
      usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      provider: provider.name,
      latency_ms: latency,
    };

    logger.info({
      provider: provider.name,
      model: provider.model,
      latency_ms: latency,
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
      tool_calls: result.tool_calls?.length ?? 0,
    }, 'inference request completed');

    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a single inference request with automatic failover.
 * Tries providers in priority order; falls back on timeout, network error, or 5xx.
 */
export async function infer(request: InferenceRequest): Promise<InferenceResponse> {
  const providers = loadProviders();
  if (providers.length === 0) {
    throw new Error('No inference providers configured. Set INFERENCE_PRIMARY_URL and INFERENCE_PRIMARY_MODEL.');
  }

  let lastError: Error | undefined;

  for (const provider of providers) {
    try {
      return await callProvider(provider, request);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.warn({ provider: provider.name, error: lastError.message }, 'provider failed, trying next');
    }
  }

  throw new Error(`All inference providers failed. Last error: ${lastError?.message}`);
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
): Promise<{ content: string; messages: ChatMessage[]; totalUsage: { prompt_tokens: number; completion_tokens: number } }> {
  const conversation = [...messages];
  let totalPrompt = 0;
  let totalCompletion = 0;

  for (let round = 0; round < maxRounds; round++) {
    const response = await infer({ messages: conversation, tools });
    totalPrompt += response.usage.prompt_tokens;
    totalCompletion += response.usage.completion_tokens;

    // No tool calls — final text response
    if (!response.tool_calls || response.tool_calls.length === 0) {
      const content = response.content ?? '';
      conversation.push({ role: 'assistant', content });
      return {
        content,
        messages: conversation,
        totalUsage: { prompt_tokens: totalPrompt, completion_tokens: totalCompletion },
      };
    }

    // Append assistant message with tool calls
    conversation.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.tool_calls,
    });

    // Execute each tool call and append results
    for (const toolCall of response.tool_calls) {
      let result: string;
      try {
        const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        result = await executor(toolCall.function.name, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = JSON.stringify({ error: message });
        logger.error({ tool: toolCall.function.name, error: message }, 'tool execution failed');
      }

      conversation.push({
        role: 'tool',
        content: result,
        tool_call_id: toolCall.id,
      });
    }
  }

  // Safety: hit max rounds — return last content or empty
  const lastAssistant = [...conversation].reverse().find(m => m.role === 'assistant');
  return {
    content: lastAssistant?.content ?? '[max tool rounds reached]',
    messages: conversation,
    totalUsage: { prompt_tokens: totalPrompt, completion_tokens: totalCompletion },
  };
}
