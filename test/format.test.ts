import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import {
  getFinalOutput,
  getTextContent,
  formatUsageStats,
} from "../src/format.js";
import type { UsageStats } from "../src/types.js";

function assistant(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as unknown as Message;
}

test("getFinalOutput joins ALL text blocks of the last assistant message (issue 14)", () => {
  const messages: Message[] = [
    assistant("first"),
    {
      role: "assistant",
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
        { type: "tool_call", id: "t", name: "x", input: {} },
      ],
    } as unknown as Message,
  ];
  assert.equal(getFinalOutput(messages), "hello world");
});

test("getFinalOutput ignores non-assistant and empty content", () => {
  const messages: Message[] = [
    { role: "user", content: "hi" } as unknown as Message,
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "t", name: "x", input: {} }],
    } as unknown as Message,
    assistant("answer"),
  ];
  assert.equal(getFinalOutput(messages), "answer");
});

test("getTextContent handles string and array content", () => {
  assert.equal(
    getTextContent({ role: "toolResult", content: "raw string" } as unknown as Message),
    "raw string",
  );
  assert.equal(
    getTextContent({
      role: "toolResult",
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
        { type: "image" },
      ],
    } as unknown as Message),
    "ab",
  );
});

test("formatUsageStats includes turns, tokens, cache, and cost", () => {
  const usage: UsageStats = {
    input: 1234,
    output: 567,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.0123,
    contextTokens: 0,
    turns: 2,
  };
  const out = formatUsageStats(usage, "claude");
  assert.match(out, /2 turns/);
  assert.match(out, /↑/); // input arrow
  assert.match(out, /↓/); // output arrow
  assert.match(out, /\$0\.0123/);
  assert.match(out, /claude/);
});

test("formatUsageStats omits zero fields", () => {
  const usage: UsageStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
  assert.equal(formatUsageStats(usage), "");
});
