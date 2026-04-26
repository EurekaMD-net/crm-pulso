import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";

let testDb: InstanceType<typeof Database>;

// Mock db.js so budget.ts and inference-adapter.ts share the same in-memory DB.
vi.mock("../src/db.js", () => ({
  getDatabase: () => testDb,
}));

import { infer, _resetProviderBreakers } from "../src/inference-adapter.js";
import { _resetSchema } from "../src/budget.js";

/**
 * Regression coverage for the cost_ledger bug chain:
 *   1. SSE usage-capture: parser was hitting `if (!delta) continue;` on the
 *      final empty-choices usage chunk, so every streaming call recorded
 *      prompt_tokens=0/completion_tokens=0.
 *   2. Per-call billing: only inferWithTools wrote to the ledger, so direct
 *      callers of infer() (sentiment, summarizer) were invisible.
 *   3. Budget guard: nothing prevented runaway spend once monthly limit hit.
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
  testDb = new Database(":memory:");
  _resetSchema();
  _resetProviderBreakers();
  process.env = {
    ...ORIG_ENV,
    INFERENCE_PRIMARY_URL: "https://example.test/v1",
    INFERENCE_PRIMARY_KEY: "test-key",
    INFERENCE_PRIMARY_MODEL: "qwen3.6-plus",
    INFERENCE_FALLBACK_URL: "",
    INFERENCE_FALLBACK_MODEL: "",
    BUDGET_ENFORCE: "0",
  };
});

afterEach(() => {
  process.env = ORIG_ENV;
  vi.restoreAllMocks();
});

describe("inference-adapter SSE streaming", () => {
  it("captures usage from the final chunk that has empty choices", async () => {
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

describe("inference-adapter cost ledger", () => {
  it("records one row per successful infer() call", async () => {
    // mockImplementation returns a fresh Response each call — Response bodies
    // can only be read once, so a shared mockResolvedValue breaks on call #2.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await infer({ messages: [{ role: "user", content: "first" }] });
    await infer({ messages: [{ role: "user", content: "second" }] });

    const rows = testDb
      .prepare(
        "SELECT model, prompt_tokens, completion_tokens, provider FROM cost_ledger ORDER BY id",
      )
      .all() as Array<{
      model: string;
      prompt_tokens: number;
      completion_tokens: number;
      provider: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      model: "qwen3.6-plus",
      prompt_tokens: 100,
      completion_tokens: 50,
      provider: "primary",
    });
    expect(rows[1].prompt_tokens).toBe(100);
  });
});

describe("inference-adapter budget guard", () => {
  it("refuses inference when monthly window is exceeded and BUDGET_ENFORCE!=0", async () => {
    process.env.BUDGET_ENFORCE = "1";
    process.env.BUDGET_MONTHLY_LIMIT_USD = "0.0001";

    // Pre-populate ledger to push monthly spend past the tiny limit.
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS cost_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        provider TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    testDb
      .prepare(
        "INSERT INTO cost_ledger (model, prompt_tokens, completion_tokens, cost_usd) VALUES (?, ?, ?, ?)",
      )
      .run("qwen3.6-plus", 1000, 1000, 1.0);

    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      infer({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/Monthly budget exceeded/);

    // Guard must short-circuit before any HTTP call goes out.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows inference when BUDGET_ENFORCE=0 even if monthly window is over", async () => {
    process.env.BUDGET_ENFORCE = "0";
    process.env.BUDGET_MONTHLY_LIMIT_USD = "0.0001";

    testDb.exec(`
      CREATE TABLE IF NOT EXISTS cost_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        provider TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    testDb
      .prepare(
        "INSERT INTO cost_ledger (model, prompt_tokens, completion_tokens, cost_usd) VALUES (?, ?, ?, ?)",
      )
      .run("qwen3.6-plus", 1000, 1000, 1.0);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await infer({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.content).toBe("ok");
  });
});
