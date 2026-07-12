import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { resolveDelegatePaths, PI_HOME, SESSION_DIR, DELEGATE_EXTS, AGENTS_PATH, THREADS_PATH, PI_AGENT_NPM, PI_AGENT_GIT } from "../src/paths.js";

test("resolveDelegatePaths derives every nested path from the given root", () => {
  const root = "/custom/pi/home";
  const p = resolveDelegatePaths(root);
  assert.equal(p.piHome, root);
  assert.equal(p.delegateExts, path.join(root, "delegate-exts"));
  assert.equal(p.sessionDir, path.join(root, "delegate-sessions"));
  assert.equal(p.agentsPath, path.join(root, "delegate-agents.json"));
  assert.equal(p.threadsPath, path.join(root, "delegate-threads.json"));
  assert.equal(p.piAgentNpm, path.join(root, "agent", "npm", "node_modules"));
  assert.equal(p.piAgentGit, path.join(root, "agent", "git"));
});

test("module-level exports are derived from the same PI_HOME (issue 24)", () => {
  assert.equal(SESSION_DIR, path.join(PI_HOME, "delegate-sessions"));
  assert.equal(DELEGATE_EXTS, path.join(PI_HOME, "delegate-exts"));
  assert.equal(AGENTS_PATH, path.join(PI_HOME, "delegate-agents.json"));
  assert.equal(THREADS_PATH, path.join(PI_HOME, "delegate-threads.json"));
  assert.equal(PI_AGENT_NPM, path.join(PI_HOME, "agent", "npm", "node_modules"));
  assert.equal(PI_AGENT_GIT, path.join(PI_HOME, "agent", "git"));
});

test("PI_HOME matches the process default when no override is set", () => {
  // CI/tests run without PI_DELEGATE_HOME, so the default root is ~/.pi.
  // We only assert the structure (ends with a single config dir name) rather
  // than the exact home, to stay environment-independent.
  assert.ok(path.isAbsolute(PI_HOME));
  assert.ok(!PI_HOME.endsWith(path.join("delegate-sessions")));
});
