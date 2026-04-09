import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  shouldCompress,
  truncateOldToolResults,
  pairDrain,
  sanitizeToolPairs,
  compressContext,
} from "../src/context-compressor.js";
import type { ChatMessage } from "../src/inference-adapter.js";

function msg(
  role: ChatMessage["role"],
  content: string,
  extras?: Partial<ChatMessage>,
): ChatMessage {
  return { role, content, ...extras };
}

function toolExchange(id: string, result: string): ChatMessage[] {
  return [
    msg("assistant", null as unknown as string, {
      tool_calls: [
        {
          id,
          type: "function",
          function: { name: "test_tool", arguments: "{}" },
        },
      ],
    }),
    msg("tool", result, { tool_call_id: id }),
  ];
}

describe("context-compressor", () => {
  describe("estimateTokens", () => {
    it("estimates tokens from string content", () => {
      const messages: ChatMessage[] = [msg("user", "A".repeat(400))];
      expect(estimateTokens(messages)).toBe(100);
    });

    it("includes tool_calls in estimate", () => {
      const messages: ChatMessage[] = [
        msg("assistant", "", {
          tool_calls: [
            {
              id: "1",
              type: "function",
              function: { name: "foo", arguments: '{"x":1}' },
            },
          ],
        }),
      ];
      expect(estimateTokens(messages)).toBeGreaterThan(0);
    });
  });

  describe("shouldCompress", () => {
    it("returns false when under threshold", () => {
      const messages: ChatMessage[] = [msg("user", "short")];
      expect(shouldCompress(messages, 10000, 0.8)).toBe(false);
    });

    it("returns true when over threshold", () => {
      const messages: ChatMessage[] = [msg("user", "X".repeat(40000))];
      expect(shouldCompress(messages, 10000, 0.8)).toBe(true);
    });
  });

  describe("truncateOldToolResults (L0)", () => {
    it("truncates old tool results beyond recent rounds", () => {
      const messages: ChatMessage[] = [
        msg("system", "prompt"),
        ...toolExchange("tc-old", "X".repeat(1000)),
        msg("assistant", "response 1"),
        ...toolExchange("tc-recent", "Y".repeat(1000)),
        msg("assistant", "response 2"),
      ];

      const truncated = truncateOldToolResults(messages, 2, 200);
      expect(truncated).toBe(1);

      const oldTool = messages.find(
        (m) => m.role === "tool" && m.tool_call_id === "tc-old",
      );
      expect(typeof oldTool?.content === "string").toBe(true);
      expect((oldTool?.content as string).length).toBeLessThan(500);
      expect(oldTool?.content as string).toContain("truncated");

      // Recent tool result should be untouched
      const recentTool = messages.find(
        (m) => m.role === "tool" && m.tool_call_id === "tc-recent",
      );
      expect(recentTool?.content).toBe("Y".repeat(1000));
    });

    it("does nothing when all results are recent", () => {
      const messages: ChatMessage[] = [
        msg("system", "prompt"),
        ...toolExchange("tc-1", "X".repeat(1000)),
        msg("assistant", "done"),
      ];
      const truncated = truncateOldToolResults(messages, 2, 200);
      expect(truncated).toBe(0);
    });
  });

  describe("pairDrain (L1)", () => {
    it("removes the oldest tool exchange pair", () => {
      const messages: ChatMessage[] = [
        msg("system", "prompt"),
        msg("user", "question"),
        ...toolExchange("tc-1", "result-1"),
        ...toolExchange("tc-2", "result-2"),
        msg("assistant", "final answer"),
      ];
      const before = messages.length;
      const removed = pairDrain(messages, 2, 2);
      expect(removed).toBeGreaterThan(0);
      expect(messages.length).toBe(before - removed);
      // tc-1 should be gone, tc-2 should remain
      expect(messages.some((m) => m.tool_call_id === "tc-1")).toBe(false);
      expect(messages.some((m) => m.tool_call_id === "tc-2")).toBe(true);
    });

    it("returns 0 when conversation is too short", () => {
      const messages: ChatMessage[] = [
        msg("system", "prompt"),
        msg("user", "hi"),
        msg("assistant", "hello"),
      ];
      expect(pairDrain(messages, 2, 2)).toBe(0);
    });
  });

  describe("sanitizeToolPairs", () => {
    it("removes orphaned tool results", () => {
      const messages: ChatMessage[] = [
        msg("tool", "orphan", { tool_call_id: "gone" }),
        msg("assistant", "text"),
      ];
      const removed = sanitizeToolPairs(messages);
      expect(removed).toBeGreaterThan(0);
      expect(messages.some((m) => m.role === "tool")).toBe(false);
    });

    it("inserts stubs for unmatched tool calls", () => {
      const messages: ChatMessage[] = [
        msg("assistant", null as unknown as string, {
          tool_calls: [
            {
              id: "tc-1",
              type: "function",
              function: { name: "foo", arguments: "{}" },
            },
          ],
        }),
      ];
      sanitizeToolPairs(messages);
      const stub = messages.find(
        (m) => m.role === "tool" && m.tool_call_id === "tc-1",
      );
      expect(stub).toBeDefined();
      expect(stub?.content).toContain("compressed");
    });
  });

  describe("compressContext (integration)", () => {
    it("returns no changes when under limit", () => {
      const messages: ChatMessage[] = [
        msg("system", "prompt"),
        msg("user", "hi"),
      ];
      const result = compressContext(messages, 100000);
      expect(result.level).toBe("none");
      expect(result.changes).toBe(0);
    });

    it("applies L0 then L1 when over limit", () => {
      // Build a conversation that exceeds the limit
      const messages: ChatMessage[] = [
        msg("system", "prompt"),
        msg("user", "question"),
      ];
      for (let i = 0; i < 10; i++) {
        messages.push(
          ...toolExchange(`tc-${i}`, "X".repeat(2000)),
          msg("assistant", `Response ${i}`),
        );
      }
      const before = messages.length;
      // Use a small limit to force compression
      const result = compressContext(messages, 500, 0.5);
      expect(result.changes).toBeGreaterThan(0);
      expect(messages.length).toBeLessThan(before);
    });
  });
});
