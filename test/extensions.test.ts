import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNpmSpec, npmCandidatePaths, normalizeGitSpec, gitCandidatePaths, installDestinationPreview, resolveExtensionPath } from "../src/extensions.js";
import { DELEGATE_EXTS, PI_AGENT_NPM, PI_AGENT_GIT } from "../src/paths.js";
import * as path from "node:path";

test("parses bare package name", () => {
  const r = parseNpmSpec("pkg");
  assert.deepEqual(r, { installSpec: "pkg", packageName: "pkg" });
});

test("parses versioned package (Bug B: install spec keeps version, path uses bare name)", () => {
  const r = parseNpmSpec("pkg@1.2.3");
  assert.deepEqual(r, { installSpec: "pkg@1.2.3", packageName: "pkg" });

  // Resolution path must use the bare name, not "pkg@1.2.3".
  const [local] = npmCandidatePaths(r!.packageName);
  assert.equal(local, path.join(DELEGATE_EXTS, "npm", "node_modules", "pkg"));
  assert.notEqual(local, path.join(DELEGATE_EXTS, "npm", "node_modules", "pkg@1.2.3"));
});

test("parses scoped package (Bug A: previously misclassified)", () => {
  const r = parseNpmSpec("@scope/pkg");
  assert.deepEqual(r, { installSpec: "@scope/pkg", packageName: "@scope/pkg" });

  const [local] = npmCandidatePaths(r!.packageName);
  assert.equal(local, path.join(DELEGATE_EXTS, "npm", "node_modules", "@scope/pkg"));
});

test("parses scoped package with tag", () => {
  const r = parseNpmSpec("@scope/pkg@latest");
  assert.deepEqual(r, { installSpec: "@scope/pkg@latest", packageName: "@scope/pkg" });
});

test("parses npm: scoped with version", () => {
  const r = parseNpmSpec("npm:@scope/pkg@1.2.3");
  assert.deepEqual(r, { installSpec: "@scope/pkg@1.2.3", packageName: "@scope/pkg" });
});

test("strips npm: prefix from bare package", () => {
  const r = parseNpmSpec("npm:pkg");
  assert.deepEqual(r, { installSpec: "pkg", packageName: "pkg" });
});

test("rejects git shorthand sources", () => {
  assert.equal(parseNpmSpec("git:github.com/user/repo"), null);
  assert.equal(parseNpmSpec("git:git@github.com:user/repo"), null);
});

test("rejects URL sources", () => {
  assert.equal(parseNpmSpec("https://github.com/user/repo"), null);
  assert.equal(parseNpmSpec("ssh://git@github.com/user/repo"), null);
});

test("rejects filesystem path sources", () => {
  assert.equal(parseNpmSpec("/abs/pkg"), null);
  assert.equal(parseNpmSpec("./pkg"), null);
  assert.equal(parseNpmSpec("../pkg"), null);
});

test("rejects empty and npm:-only input", () => {
  assert.equal(parseNpmSpec(""), null);
  assert.equal(parseNpmSpec("npm:"), null);
  assert.equal(parseNpmSpec("   "), null);
});

test("rejects malformed scoped specifiers", () => {
  assert.equal(parseNpmSpec("@invalidscope"), null);
  assert.equal(parseNpmSpec("@scope/"), null);
  assert.equal(parseNpmSpec("@/pkg"), null);
});

test("npmCandidatePaths includes delegate prefix and pi agent npm root", () => {
  const paths = npmCandidatePaths("pkg");
  assert.deepEqual(paths, [
    path.join(DELEGATE_EXTS, "npm", "node_modules", "pkg"),
    path.join(PI_AGENT_NPM, "pkg"),
  ]);
});

test("git: shorthand with ref extracts ref and keeps clean URL (Bug: no @v1.git)", () => {
  const r = normalizeGitSpec("git:github.com/user/repo@v1");
  assert.deepEqual(r, {
    repoUrl: "https://github.com/user/repo.git",
    repoName: "github.com/user/repo",
    ref: "v1",
  });
});

test("https URL with ref (userinfo @ not mistaken for ref)", () => {
  const r = normalizeGitSpec("https://github.com/user/repo@v1");
  assert.deepEqual(r, {
    repoUrl: "https://github.com/user/repo.git",
    repoName: "github.com/user/repo",
    ref: "v1",
  });
});

test("ssh URL with user and ref", () => {
  const r = normalizeGitSpec("ssh://git@github.com/user/repo@v1");
  assert.deepEqual(r, {
    repoUrl: "ssh://git@github.com/user/repo.git",
    repoName: "github.com/user/repo",
    ref: "v1",
  });
});

test("ssh scp syntax with user and ref", () => {
  const r = normalizeGitSpec("git:git@github.com:user/repo@v1");
  assert.deepEqual(r, {
    repoUrl: "ssh://git@github.com/user/repo.git",
    repoName: "github.com/user/repo",
    ref: "v1",
  });
});

test("git source without ref has undefined ref", () => {
  const r = normalizeGitSpec("git:github.com/user/repo");
  assert.equal(r?.ref, undefined);
  assert.equal(r?.repoUrl, "https://github.com/user/repo.git");
  assert.equal(r?.repoName, "github.com/user/repo");
});

test("existing .git suffix is not duplicated", () => {
  const r = normalizeGitSpec("https://github.com/user/repo.git");
  assert.equal(r?.repoUrl, "https://github.com/user/repo.git");
  assert.equal(r?.ref, undefined);
});

test("ref with slash (branch) is preserved", () => {
  const r = normalizeGitSpec("git:github.com/user/repo@feature/my-branch");
  assert.equal(r?.ref, "feature/my-branch");
  assert.equal(r?.repoName, "github.com/user/repo");
});

test(".git suffix combined with ref does not double-append", () => {
  const r = normalizeGitSpec("git:github.com/user/repo.git@v1");
  assert.equal(r?.ref, "v1");
  assert.equal(r?.repoUrl, "https://github.com/user/repo.git");
});

test("distinct hosts with same basename do not collide (destination slug)", () => {
  const a = normalizeGitSpec("github.com/a/tools");
  const b = normalizeGitSpec("gitlab.com/b/tools");
  assert.notEqual(a?.repoName, b?.repoName);
  assert.equal(a?.repoName, "github.com/a/tools");
  assert.equal(b?.repoName, "gitlab.com/b/tools");
});

test("gitCandidatePaths uses host/path slug for both roots (Bug #7: no URL as path)", () => {
  const spec = normalizeGitSpec("git:github.com/user/repo@v1")!;
  const paths = gitCandidatePaths(spec);
  assert.deepEqual(paths, [
    path.join(DELEGATE_EXTS, "git", "github.com/user/repo"),
    path.join(PI_AGENT_GIT, "github.com/user/repo"),
  ]);
  // A URL string must never appear as a filesystem path component.
  assert.ok(!paths.some((p) => p.includes("://")));
});

test("same repo different ref shares destination", () => {
  const a = normalizeGitSpec("git:github.com/user/repo@v1");
  const b = normalizeGitSpec("git:github.com/user/repo@v2");
  assert.equal(a?.repoName, b?.repoName);
});

test("installDestinationPreview maps npm sources to the delegate npm root (issue 22)", () => {
  assert.equal(
    installDestinationPreview("pkg"),
    path.join(DELEGATE_EXTS, "npm", "node_modules", "pkg"),
  );
  assert.equal(
    installDestinationPreview("@scope/pkg"),
    path.join(DELEGATE_EXTS, "npm", "node_modules", "@scope/pkg"),
  );
  assert.equal(
    installDestinationPreview("npm:foo@1.2.3"),
    path.join(DELEGATE_EXTS, "npm", "node_modules", "foo"),
  );
});

test("installDestinationPreview maps git sources to the host/path slug (issue 22)", () => {
  assert.equal(
    installDestinationPreview("git:github.com/user/repo@v1"),
    path.join(DELEGATE_EXTS, "git", "github.com/user/repo"),
  );
});

test("installDestinationPreview returns the raw path for path sources (issue 22)", () => {
  assert.equal(installDestinationPreview("/abs/ext"), "/abs/ext");
  assert.equal(installDestinationPreview("./rel/ext"), "./rel/ext");
});

test("installDestinationPreview returns null for empty/whitespace input", () => {
  assert.equal(installDestinationPreview(""), null);
  assert.equal(installDestinationPreview("   "), null);
});

test("resolveExtensionPath returns null for a missing configured extension (issue 23)", () => {
  assert.equal(resolveExtensionPath("/no/such/extension/path"), null);
  assert.equal(resolveExtensionPath("npm:this-package-does-not-exist-xyz"), null);
});
