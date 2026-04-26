import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { infer, _resetProviderBreakers } from "../src/inference-adapter.js";

/**
 * Focused regression test for the SSE usage-capture bug.
 *
 * Bug: when an OpenAI-compatible provider sends the final stream_options
 * usage chunk with `choices: []` (no delta), the SSE parser was hitting
 * `if (!delta) continue;` before it could read `chunk.usage`. Result: every
 * streaming inference recorded prompt_tokens=0/completion_tokens=0, so the
 * cost ledger was effectively blind. Fix moves the usage capture above the
 * early-return guard.
 */

const ORIG_ENV = process.env;

function makeSSEStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const evt of events) {
        controller.enqueue(encoder.encode(`data: ${evt}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

beforeEach(() => {
  _resetProviderBreakers();
  process.env = {
    ...ORIG_ENV,
    INFERENCE_PRIMARY_URL: "https://example.test/v1",
    INFERENCE_PRIMARY_KEY: "test-key",
    INFERENCE_PRIMARY_MODEL: "qwen3.6-plus",
    INFERENCE_FALLBACK_URL: "",
    INFERENCE_FALLBACK_MODEL: "",
  };
});

afterEach(() => {
  process.env = ORIG_ENV;
  vi.restoreAllMocks();
});

describe("inference-adapter SSE streaming", () => {
  it("captures usage from the final chunk that has empty choices", async () => {
    // Real Qwen / OpenAI-compatible final chunk shape: choices is [], usage is set
    const events = [
      JSON.stringify({
        choices: [{ index: 0, delta: { role: "assistant", content: "Hola" } }],
      }),
      JSON.stringify({
        choices: [{ index: 0, delta: { content: " mundo" } }],
      }),
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
      }),
    ];

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(makeSSEStream(events), { status: 200 }));

    const collected: string[] = [];
    const result = await infer(
      { messages: [{ role: "user", content: "hi" }] },
      (text) => collected.push(text),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.content).toBe("Hola mundo");
    expect(result.usage.prompt_tokens).toBe(42);
    expect(result.usage.completion_tokens).toBe(7);
    expect(result.usage.total_tokens).toBe(49);
    expect(collected.join("")).toBe("Hola mundo");
  });

  it("requests stream_options.include_usage when streaming", async () => {
    const events = [
      JSON.stringify({
        choices: [{ index: 0, delta: { content: "ok" } }],
      }),
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    ];

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(makeSSEStream(events), { status: 200 }));

    await infer({ messages: [{ role: "user", content: "hi" }] }, () => {});

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("non-streaming path uses data.usage from JSON response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await infer({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.usage.prompt_tokens).toBe(11);
    expect(result.usage.completion_tokens).toBe(3);
  });
});
