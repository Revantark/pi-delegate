import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInstallArgs, parseAddArgs, tokenizeArgs } from "../src/args.js";

test("parseInstallArgs rejects when agent is missing", () => {
  assert.equal(parseInstallArgs("npm:foo"), null);
  assert.equal(parseInstallArgs(""), null);
});

test("parseInstallArgs rejects when source is missing", () => {
  assert.equal(parseInstallArgs("--agent researcher"), null);
});

test("parseInstallArgs parses source, agent, and flags", () => {
  const r = parseInstallArgs("npm:foo --agent researcher --no-extensions");
  assert.deepEqual(r, {
    source: "npm:foo",
    agent: "researcher",
    noAutoExtensions: true,
    yes: undefined,
  });
});

test("parseInstallArgs honors --yes opt-out of confirmation (issue 22)", () => {
  const r = parseInstallArgs("npm:foo --agent researcher --yes");
  assert.equal(r?.yes, true);

  const r2 = parseInstallArgs("npm:foo --agent researcher");
  assert.equal(r2?.yes, undefined);
});

test("tokenizer handles quotes, escapes, and flag=values", () => {
  assert.deepEqual(tokenizeArgs(`a b "c d" 'e f' g=h i\\ j`), [
    "a",
    "b",
    "c d",
    "e f",
    "g=h",
    "i j",
  ]);
});

test("parseAddArgs parses the full add invocation", () => {
  const r = parseAddArgs(
    `bob --model claude --tools a,b --extensions npm:x --no-session --description "a bot"`,
  );
  assert.deepEqual(r, {
    name: "bob",
    model: "claude",
    tools: ["a", "b"],
    description: "a bot",
    extensions: ["npm:x"],
    noAutoExtensions: undefined,
    session: false,
  });
});

test("parseAddArgs requires a model", () => {
  assert.equal(parseAddArgs("bob"), null);
});
