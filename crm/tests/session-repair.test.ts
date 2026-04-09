import { describe, it, expect } from "vitest";
import { repairSession } from "../src/session-repair.js";
import type { ChatMessage } from "../src/inference-adapter.js";

function msg(
  role: ChatMessage["role"],
  content: string,
  extras?: Partial<ChatMessage>,
): ChatMessage {
  return { role, content, ...extras };
}

describe("repairSession", () => {
  it("returns zero stats for clean conversation", () => {
    const messages: ChatMessage[] = [
      msg("system", "You are an assistant"),
      msg("user", "Hello"),
      msg("assistant", "Hi there!"),
    ];
    const stats = repairSession(messages);
    expect(stats.orphanedToolResults).toBe(0);
    expect(stats.syntheticErrors).toBe(0);
    expect(stats.dedupedResults).toBe(0);
    expect(stats.mergedMessages).toBe(0);
    expect(messages).toHaveLength(3);
  });

  it("removes orphaned tool results", () => {
    const messages: ChatMessage[] = [
      msg("system", "You are an assistant"),
      msg("user", "Do something"),
      msg("tool", '{"result":"ok"}', { tool_call_id: "orphan-123" }),
      msg("assistant", "Done"),
    ];
    const stats = repairSession(messages);
    expect(stats.orphanedToolResults).toBe(1);
    expect(messages).toHaveLength(3);
    expect(messages.every((m) => m.role !== "tool")).toBe(true);
  });

  it("deduplicates tool results (keeps last)", () => {
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
      msg("tool", "first result", { tool_call_id: "tc-1" }),
      msg("tool", "second result", { tool_call_id: "tc-1" }),
    ];
    const stats = repairSession(messages);
    expect(stats.dedupedResults).toBe(1);
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(messages.find((m) => m.role === "tool")?.content).toBe(
      "second result",
    );
  });

  it("inserts synthetic errors for unmatched tool calls", () => {
    const messages: ChatMessage[] = [
      msg("assistant", null as unknown as string, {
        tool_calls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "foo", arguments: "{}" },
          },
          {
            id: "tc-2",
            type: "function",
            function: { name: "bar", arguments: "{}" },
          },
        ],
      }),
      msg("tool", "result for tc-1", { tool_call_id: "tc-1" }),
      // tc-2 has no result
    ];
    const stats = repairSession(messages);
    expect(stats.syntheticErrors).toBe(1);
    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    const synthetic = toolMsgs.find((m) => m.tool_call_id === "tc-2");
    expect(synthetic?.content).toContain("missing");
  });

  it("merges consecutive same-role messages", () => {
    const messages: ChatMessage[] = [
      msg("user", "First message"),
      msg("user", "Second message"),
      msg("assistant", "Response"),
    ];
    const stats = repairSession(messages);
    expect(stats.mergedMessages).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("First message");
    expect(messages[0].content).toContain("Second message");
  });

  it("does not merge assistant messages with tool_calls", () => {
    const messages: ChatMessage[] = [
      msg("assistant", "thinking...", {
        tool_calls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "foo", arguments: "{}" },
          },
        ],
      }),
      msg("tool", "result", { tool_call_id: "tc-1" }),
      msg("assistant", "done"),
    ];
    const stats = repairSession(messages);
    expect(stats.mergedMessages).toBe(0);
    expect(messages).toHaveLength(3);
  });

  it("does not merge tool results", () => {
    const messages: ChatMessage[] = [
      msg("assistant", null as unknown as string, {
        tool_calls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "a", arguments: "{}" },
          },
          {
            id: "tc-2",
            type: "function",
            function: { name: "b", arguments: "{}" },
          },
        ],
      }),
      msg("tool", "r1", { tool_call_id: "tc-1" }),
      msg("tool", "r2", { tool_call_id: "tc-2" }),
    ];
    const stats = repairSession(messages);
    expect(stats.mergedMessages).toBe(0);
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  it("handles all repairs in one pass", () => {
    const messages: ChatMessage[] = [
      msg("system", "prompt"),
      msg("tool", "orphan", { tool_call_id: "gone" }),
      msg("user", "part 1"),
      msg("user", "part 2"),
      msg("assistant", null as unknown as string, {
        tool_calls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "x", arguments: "{}" },
          },
        ],
      }),
      // no result for tc-1
    ];
    const stats = repairSession(messages);
    expect(stats.orphanedToolResults).toBe(1);
    expect(stats.mergedMessages).toBe(1);
    expect(stats.syntheticErrors).toBe(1);
  });
});
