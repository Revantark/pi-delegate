import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DELEGATE_EXTS, PI_AGENT_GIT, PI_AGENT_NPM } from "./paths.js";

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, { stdio: "ignore" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} ${args.join(" ")} failed (exit ${code})`));
    });
    proc.on("error", (err) => reject(err));
  });
}

function ensureNpmPrefix(): string {
  const prefix = path.join(DELEGATE_EXTS, "npm");
  if (!fs.existsSync(prefix)) fs.mkdirSync(prefix, { recursive: true });
  return prefix;
}

function ensureGitParent(repoName: string): string {
  const dest = path.join(DELEGATE_EXTS, "git", repoName);
  const parent = path.dirname(dest);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  return dest;
}

/**
 * Extract an npm package name from sources like "npm:foo" or bare "foo".
 */
function getNpmPackageName(source: string): string | null {
  if (source.startsWith("npm:")) return source.slice(4).trim();
  if (
    !source.startsWith("git:") &&
    !source.startsWith("/") &&
    !source.startsWith(".") &&
    !source.includes("/") &&
    !source.includes(":")
  ) {
    return source.trim();
  }
  return null;
}

interface GitSpec {
  repoUrl: string;
  repoName: string;
}

/**
 * Normalize git-like sources (git: shorthand or URL-ish strings).
 * Ensures a scheme and trailing ".git", then derives the local repo name.
 */
function normalizeGitSpec(source: string): GitSpec | null {
  let repo = source.startsWith("git:") ? source.slice(4).trim() : source.trim();
  if (!repo) return null;

  if (
    !repo.startsWith("http") &&
    !repo.startsWith("git@") &&
    !repo.startsWith("ssh://")
  ) {
    repo = `https://${repo}`;
  }
  if (!repo.endsWith(".git")) repo = `${repo}.git`;
  const repoName = path.basename(repo, ".git");
  return { repoUrl: repo, repoName };
}

function isPathSource(source: string): boolean {
  return (
    source.startsWith("/") || source.startsWith(".") || source.startsWith("../")
  );
}

function npmCandidatePaths(name: string): string[] {
  return [
    path.join(DELEGATE_EXTS, "npm", "node_modules", name),
    path.join(PI_AGENT_NPM, name),
  ];
}

function gitCandidatePaths(repoUrl: string, repoName: string): string[] {
  return [
    path.join(DELEGATE_EXTS, "git", repoName),
    path.join(PI_AGENT_GIT, repoUrl),
  ];
}

/**
 * Resolve an extension source string to an absolute filesystem path.
 * Supports paths, npm: shorthand, git: shorthand, and bare npm package names.
 */
export function resolveExtensionPath(ext: string): string | null {
  if (isPathSource(ext)) {
    return fs.existsSync(ext) ? ext : null;
  }

  const npmName = getNpmPackageName(ext);
  if (npmName) {
    for (const candidate of npmCandidatePaths(npmName)) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  const gitSpec = normalizeGitSpec(ext);
  if (gitSpec) {
    for (const candidate of gitCandidatePaths(gitSpec.repoUrl, gitSpec.repoName)) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  return null;
}

export async function installExtensionSource(
  source: string,
): Promise<string | null> {
  const npmName = getNpmPackageName(source);
  if (npmName) {
    const prefix = ensureNpmPrefix();
    await runCommand("npm", ["install", npmName, "--prefix", prefix]);
    return path.join(prefix, "node_modules", npmName);
  }

  const gitSpec = normalizeGitSpec(source);
  if (gitSpec) {
    const dest = ensureGitParent(gitSpec.repoName);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    await runCommand("git", ["clone", gitSpec.repoUrl, dest]);
    return dest;
  }

  return null;
}

export async function updateExtensionSource(
  source: string,
): Promise<string | null> {
  const npmName = getNpmPackageName(source);
  if (npmName) {
    const prefix = path.join(DELEGATE_EXTS, "npm");
    if (!fs.existsSync(prefix)) return null;
    await runCommand("npm", ["update", npmName, "--prefix", prefix]);
    return path.join(prefix, "node_modules", npmName);
  }

  const gitSpec = normalizeGitSpec(source);
  if (gitSpec) {
    const dest = path.join(DELEGATE_EXTS, "git", gitSpec.repoName);
    if (!fs.existsSync(dest)) return null;
    await runCommand("git", ["-C", dest, "pull"]);
    return dest;
  }

  return null;
}
