import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeThreadId, sanitizeAgentName, isValidThreadId } from "../src/sanitize.js";

test("distinct inputs never collide onto the same session id (issue 19)", () => {
  const a = sanitizeThreadId("research/a");
  const b = sanitizeThreadId("research_a");
  assert.notEqual(a, b);
  // Both must still be safe, valid thread ids.
  assert.ok(isValidThreadId(a));
  assert.ok(isValidThreadId(b));
});

test("valid thread ids are returned unchanged (idempotent)", () => {
  for (const id of ["abc", "a.b-c_d", "X09.y", "thread-123"]) {
    assert.equal(sanitizeThreadId(id), id);
    assert.ok(isValidThreadId(id));
  }
});

test("arbitrary text gets a readable prefix plus a short hash", () => {
  const id = sanitizeThreadId("My Cool Thread! @2024");
  assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  // Re-sanitizing the produced id is stable (the hash form satisfies the pattern).
  assert.equal(sanitizeThreadId(id), id);
});

test("empty thread id falls back to a default", () => {
  assert.equal(sanitizeThreadId(""), "thread");
  assert.equal(sanitizeThreadId("   "), "thread");
});

test("sanitizeAgentName allows safe names and rejects unsafe ones", () => {
  assert.equal(sanitizeAgentName("researcher"), "researcher");
  assert.equal(sanitizeAgentName("my-agent_1"), "my-agent_1");
  for (const bad of ["", "a/b", "a b", "a.b", "a@b", "../x"]) {
    assert.throws(() => sanitizeAgentName(bad));
  }
});
