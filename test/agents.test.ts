import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeAgentConfig, type AgentConfig } from "../src/agents.js";

test("install preserves session:false (Bug #8)", () => {
  const base: AgentConfig = { name: "quick", model: "provider/model", session: false };
  const patched = mergeAgentConfig(base, {
    extensions: [...(base.extensions ?? []), "npm:foo"],
  });
  assert.equal(patched.session, false);
  assert.equal(patched.name, "quick");
  assert.equal(patched.model, "provider/model");
  assert.deepEqual(patched.extensions, ["npm:foo"]);
});

test("install preserves description, tools, model, and existing extensions", () => {
  const base: AgentConfig = {
    name: "quick",
    model: "provider/model",
    tools: ["x", "y"],
    description: "a fast agent",
    extensions: ["npm:a"],
  };
  const patched = mergeAgentConfig(base, {
    extensions: [...(base.extensions ?? []), "npm:b"],
  });
  assert.equal(patched.tools?.[0], "x");
  assert.equal(patched.description, "a fast agent");
  assert.equal(patched.model, "provider/model");
  assert.deepEqual(patched.extensions, ["npm:a", "npm:b"]);
});

test("install preserves explicit noAutoExtensions:false", () => {
  const base: AgentConfig = { name: "q", model: "m", noAutoExtensions: false };
  const patched = mergeAgentConfig(base, { extensions: ["npm:foo"] });
  assert.equal(patched.noAutoExtensions, false);
});

test("uninstall preserves session:false and other fields, drops only the extension", () => {
  const base: AgentConfig = {
    name: "quick",
    model: "m",
    session: false,
    extensions: ["a", "b"],
    tools: ["x"],
    description: "d",
    noAutoExtensions: false,
  };
  const updated = base.extensions!.filter((e) => e !== "a");
  const patched = mergeAgentConfig(base, {
    extensions: updated.length > 0 ? updated : undefined,
  });
  assert.equal(patched.session, false);
  assert.equal(patched.tools?.[0], "x");
  assert.equal(patched.description, "d");
  assert.equal(patched.noAutoExtensions, false);
  assert.deepEqual(patched.extensions, ["b"]);
});

test("uninstall to empty extensions leaves the field unset, keeps everything else", () => {
  const base: AgentConfig = {
    name: "q",
    model: "m",
    session: false,
    extensions: ["only"],
  };
  const updated = base.extensions!.filter((e) => e !== "only");
  const patched = mergeAgentConfig(base, {
    extensions: updated.length > 0 ? updated : undefined,
  });
  assert.equal(patched.session, false);
  assert.equal(patched.extensions, undefined);
  assert.equal(patched.name, "q");
});
