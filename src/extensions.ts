import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  DELEGATE_EXTS,
  PI_AGENT_GIT,
  PI_AGENT_NPM,
  PI_HOME,
} from "./paths.js";
import {
  ensureSafeDir,
  isContained,
  isSymlink,
  safeRealpath,
  saveAtomically,
  withFileLock,
} from "./store.js";

export interface NpmSpec {
  installSpec: string;
  packageName: string;
}

export interface GitSpec {
  repoUrl: string;
  repoName: string;
  ref?: string;
}

export interface CommandSpec {
  command: string;
  args: string[];
}

export interface CommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface SourceMetadata {
  source: string;
  kind: "npm" | "git";
  packageName?: string;
  installSpec?: string;
  repoUrl?: string;
  repoName?: string;
  ref?: string;
  resolvedPath: string;
  installedAt: string;
  updatedAt: string;
}

const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ERROR_OUTPUT_CHARS = 4000;

function isPathSource(source: string): boolean {
  const s = source.trim();
  return s.startsWith("/") || s.startsWith(".") || s.startsWith("../");
}

export function parseNpmSpec(source: string): NpmSpec | null {
  const s = source.trim();
  if (!s) return null;

  let spec = s;
  if (spec.startsWith("npm:")) {
    spec = spec.slice(4).trim();
    if (!spec) return null;
  }

  // Reject anything that looks like a git/URL/path source.
  if (
    spec.startsWith("git:") ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(spec) ||
    isPathSource(spec)
  ) {
    return null;
  }

  // Scoped package.
  if (spec.startsWith("@")) {
    const scopedMatch = /^@([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)(?:@(.+))?$/.exec(
      spec,
    );
    if (!scopedMatch) return null;
    const scope = scopedMatch[1];
    const name = scopedMatch[2];
    const version = scopedMatch[3];
    const packageName = `@${scope}/${name}`;
    const installSpec = version ? `${packageName}@${version}` : packageName;
    return { installSpec, packageName };
  }

  const unscopedMatch = /^([a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?)(?:@(.+))?$/
    .exec(spec);
  if (!unscopedMatch) return null;
  const packageName = unscopedMatch[1];
  const version = unscopedMatch[2];
  const installSpec = version ? `${packageName}@${version}` : packageName;
  return { installSpec, packageName };
}

export function npmCandidatePaths(packageName: string): string[] {
  return [
    path.join(DELEGATE_EXTS, "npm", "node_modules", packageName),
    path.join(PI_AGENT_NPM, packageName),
  ];
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

export function normalizeGitSpec(source: string): GitSpec | null {
  let raw = source.trim();
  if (!raw) return null;
  if (raw.startsWith("git:")) raw = raw.slice(4).trim();
  if (!raw) return null;

  let repo = raw;
  let ref: string | undefined;
  const isUrl = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw);

  if (isUrl) {
    // Only an @ after the first URL path slash can be a ref. This preserves
    // URL userinfo such as https://user:pass@host/repo.
    const schemeEnd = raw.indexOf("://") + 3;
    const pathSlash = raw.indexOf("/", schemeEnd);
    const at = raw.lastIndexOf("@");
    if (pathSlash >= 0 && at > pathSlash && raw.slice(at + 1)) {
      ref = raw.slice(at + 1);
      repo = raw.slice(0, at);
    }
  } else if (raw.startsWith("git@") || raw.includes(":")) {
    // SCP-like SSH form: git@host:path/repo@ref. The @ before ':' is userinfo.
    const colon = raw.indexOf(":");
    const pathPart = colon >= 0 ? raw.slice(colon + 1) : raw;
    const at = pathPart.lastIndexOf("@");
    if (at > 0 && pathPart.slice(at + 1)) {
      ref = pathPart.slice(at + 1);
      repo = raw.slice(0, colon + 1) + pathPart.slice(0, at);
    }
  } else {
    const at = raw.lastIndexOf("@");
    if (at > 0 && raw.slice(at + 1)) {
      ref = raw.slice(at + 1);
      repo = raw.slice(0, at);
    }
  }

  let repoUrl: string;
  if (/^https?:\/\//.test(repo) || repo.startsWith("ssh://")) {
    repoUrl = `${stripGitSuffix(repo)}.git`;
  } else if (/^(?:[^/:]+@)?[^/:]+:.+/.test(repo)) {
    const match = /^(([^/@]+)@)?([^/:]+):(.+)$/.exec(repo);
    if (!match) return null;
    const user = match[2];
    const host = match[3];
    const repoPath = stripGitSuffix(match[4]);
    repoUrl = `ssh://${user ? `${user}@` : ""}${host}/${repoPath}.git`;
  } else {
    repoUrl = `https://${stripGitSuffix(repo)}.git`;
  }

  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return null;
  }
  const repoName = `${parsed.host}/${parsed.pathname
    .replace(/^\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")}`;
  return { repoUrl, repoName, ref };
}

export function gitCandidatePaths(spec: GitSpec): string[] {
  return [
    path.join(DELEGATE_EXTS, "git", spec.repoName),
    path.join(PI_AGENT_GIT, spec.repoName),
  ];
}

export function installDestinationPreview(source: string): string | null {
  const s = source.trim();
  if (!s) return null;
  if (isPathSource(s)) return s;

  const npmSpec = parseNpmSpec(s);
  if (npmSpec) {
    return npmCandidatePaths(npmSpec.packageName)[0];
  }

  const gitSpec = normalizeGitSpec(s);
  if (gitSpec) {
    return path.join(DELEGATE_EXTS, "git", gitSpec.repoName);
  }

  return null;
}

export function resolveExtensionPath(ext: string): string | null {
  if (isPathSource(ext)) {
    return fs.existsSync(ext) ? ext : null;
  }

  const npmSpec = parseNpmSpec(ext);
  if (npmSpec) {
    for (const candidate of npmCandidatePaths(npmSpec.packageName)) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  const gitSpec = normalizeGitSpec(ext);
  if (gitSpec) {
    for (const candidate of gitCandidatePaths(gitSpec)) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  return null;
}

function encodeSourceForLock(source: string): string {
  return crypto.createHash("sha256").update(source).digest("hex").slice(0, 32);
}

function ensureDelegateRoot(): void {
  const realHome = safeRealpath(PI_HOME) ?? PI_HOME;
  if (isSymlink(DELEGATE_EXTS)) {
    throw new Error(`Refusing to use symlinked delegate root: ${DELEGATE_EXTS}`);
  }
  ensureSafeDir(DELEGATE_EXTS, 0o700, PI_HOME);
  const realExt = safeRealpath(DELEGATE_EXTS) ?? DELEGATE_EXTS;
  if (!isContained(realHome, realExt)) {
    throw new Error(
      `Delegate extension root escapes trusted root: ${realExt}`,
    );
  }
}

function assertSafeDelegatePath(target: string): void {
  ensureDelegateRoot();
  if (isSymlink(target)) {
    throw new Error(`Refusing to operate on symlinked path: ${target}`);
  }
  const realHome = safeRealpath(PI_HOME) ?? PI_HOME;
  const resolved = safeRealpath(target) ?? target;
  if (!isContained(realHome, resolved)) {
    throw new Error(
      `Delegate path escapes trusted root: ${resolved}`,
    );
  }
}

function resolveConfiguredNpmCommand(_ctx?: ExtensionCommandContext): CommandSpec {
  // ExtensionContext intentionally does not expose SettingsManager. Read only
  // the documented npmCommand setting, then allow an explicit test/operator
  // override. Never evaluate shell text; command and args stay separate.
  const settingsPath = path.join(PI_HOME, "agent", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      npmCommand?: unknown;
    };
    if (
      Array.isArray(settings.npmCommand) &&
      settings.npmCommand.length > 0 &&
      settings.npmCommand.every((part) => typeof part === "string" && part.length > 0)
    ) {
      return {
        command: settings.npmCommand[0] as string,
        args: settings.npmCommand.slice(1) as string[],
      };
    }
  } catch {
    // Missing or malformed Pi settings fall back to npm.
  }

  const env = process.env.PI_DELEGATE_NPM_COMMAND;
  if (env) {
    const parts = env.split(/\s+/).filter(Boolean);
    if (parts.length > 0) return { command: parts[0], args: parts.slice(1) };
  }
  return { command: "npm", args: [] };
}

function trimOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  return "...(truncated)\n" + output.slice(-maxChars);
}

export function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error("Command aborted"));
      return;
    }

    const proc = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    const MAX_COMMAND_OUTPUT_CHARS = 64 * 1024;
    let killed = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abortHandler);
    };

    const sendSignal = (force: boolean) => {
      if (!proc.pid) return;
      if (process.platform === "win32") {
        void terminateProcessTree(proc.pid, force);
        return;
      }
      try {
        process.kill(-proc.pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        // Process group already exited.
      }
    };

    const abortHandler = () => {
      if (killed) return;
      killed = true;
      sendSignal(false);
      killTimer = setTimeout(() => {
        if (!proc.killed) sendSignal(true);
      }, 5000);
    };

    if (options.signal) {
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (killed) return;
        killed = true;
        sendSignal(false);
        killTimer = setTimeout(() => sendSignal(true), 5000);
      }, options.timeoutMs);
    }

    proc.stdout?.on("data", (data: Buffer) => {
      stdout = trimOutput(stdout + data.toString("utf-8"), MAX_COMMAND_OUTPUT_CHARS);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr = trimOutput(stderr + data.toString("utf-8"), MAX_COMMAND_OUTPUT_CHARS);
    });

    proc.once("error", (err: Error) => {
      cleanup();
      reject(err);
    });

    proc.once("close", (code: number | null, sig: NodeJS.Signals | null) => {
      cleanup();
      resolve({ exitCode: code, signal: sig, stdout, stderr });
    });
  });
}

function terminateProcessTree(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const proc = spawn("taskkill", args, { detached: true });
    proc.on("error", () => resolve());
    proc.on("close", () => resolve());
  });
}

async function runNpm(
  args: string[],
  ctx: ExtensionCommandContext | undefined,
  options: CommandOptions = {},
): Promise<CommandResult> {
  const npm = resolveConfiguredNpmCommand(ctx);
  return runCommand(npm.command, [...npm.args, ...args], options);
}

async function runGit(
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return runCommand("git", args, options);
}

function buildMetadata(
  source: string,
  resolvedPath: string,
  npmSpec?: NpmSpec,
  gitSpec?: GitSpec,
): SourceMetadata {
  const now = new Date().toISOString();
  if (npmSpec) {
    return {
      source,
      kind: "npm",
      packageName: npmSpec.packageName,
      installSpec: npmSpec.installSpec,
      resolvedPath,
      installedAt: now,
      updatedAt: now,
    };
  }
  return {
    source,
    kind: "git",
    repoUrl: gitSpec!.repoUrl,
    repoName: gitSpec!.repoName,
    ref: gitSpec!.ref,
    resolvedPath,
    installedAt: now,
    updatedAt: now,
  };
}

async function writeSourceMetadata(
  resolvedPath: string,
  metadata: SourceMetadata,
): Promise<void> {
  assertSafeDelegatePath(resolvedPath);
  const metaPath = path.join(resolvedPath, ".delegate-source.json");
  await saveAtomically(metaPath, metadata, PI_HOME);
}

async function readSourceMetadata(
  resolvedPath: string,
): Promise<SourceMetadata | undefined> {
  const metaPath = path.join(resolvedPath, ".delegate-source.json");
  if (!fs.existsSync(metaPath)) return undefined;
  try {
    const raw = fs.readFileSync(metaPath, "utf-8");
    return JSON.parse(raw) as SourceMetadata;
  } catch {
    return undefined;
  }
}

function installLockFile(source: string): string {
  return path.join(DELEGATE_EXTS, ".install-locks", encodeSourceForLock(source));
}

function npmErrorMessage(result: CommandResult, action: string): string {
  const parts: string[] = [`${action} failed with exit code ${result.exitCode}`];
  const err = trimOutput(result.stderr || result.stdout, MAX_ERROR_OUTPUT_CHARS);
  if (err) parts.push(`stderr:\n${err}`);
  return parts.join("\n");
}

export async function installExtensionSource(
  source: string,
  ctx?: ExtensionCommandContext,
): Promise<string | null> {
  ensureDelegateRoot();
  const npmSpec = parseNpmSpec(source);
  if (npmSpec) {
    return withFileLock(
      installLockFile(source),
      PI_HOME,
      async () => {
        const prefix = path.join(DELEGATE_EXTS, "npm");
        assertSafeDelegatePath(prefix);
        const result = await runNpm(
          ["install", npmSpec.installSpec, "--prefix", prefix],
          ctx,
          { timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS, signal: ctx?.signal ?? undefined },
        );
        if (result.exitCode !== 0) {
          throw new Error(npmErrorMessage(result, "npm install"));
        }
        const resolvedPath = path.join(prefix, "node_modules", npmSpec.packageName);
        assertSafeDelegatePath(resolvedPath);
        const metadata = buildMetadata(source, resolvedPath, npmSpec);
        await writeSourceMetadata(resolvedPath, metadata);
        return resolvedPath;
      },
    );
  }

  const gitSpec = normalizeGitSpec(source);
  if (gitSpec) {
    return withFileLock(
      installLockFile(source),
      PI_HOME,
      async () => {
        const dest = path.join(DELEGATE_EXTS, "git", gitSpec.repoName);
        if (fs.existsSync(dest)) {
          assertSafeDelegatePath(dest);
          fs.rmSync(dest, { recursive: true, force: true });
        }
        assertSafeDelegatePath(path.dirname(dest));
        const cloneArgs = ["clone"];
        if (gitSpec.ref) cloneArgs.push("--branch", gitSpec.ref);
        cloneArgs.push(gitSpec.repoUrl, dest);
        const result = await runGit(cloneArgs, {
          timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
          signal: ctx?.signal ?? undefined,
        });
        if (result.exitCode !== 0) {
          throw new Error(npmErrorMessage(result, "git clone"));
        }
        assertSafeDelegatePath(dest);
        const metadata = buildMetadata(source, dest, undefined, gitSpec);
        await writeSourceMetadata(dest, metadata);
        return dest;
      },
    );
  }

  return null;
}

export async function updateExtensionSource(
  source: string,
  ctx?: ExtensionCommandContext,
): Promise<string | null> {
  ensureDelegateRoot();
  const npmSpec = parseNpmSpec(source);
  if (npmSpec) {
    return withFileLock(
      installLockFile(source),
      PI_HOME,
      async () => {
        const prefix = path.join(DELEGATE_EXTS, "npm");
        if (!fs.existsSync(prefix)) return null;
        assertSafeDelegatePath(prefix);
        const result = await runNpm(
          ["update", npmSpec.packageName, "--prefix", prefix],
          ctx,
          { timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS, signal: ctx?.signal ?? undefined },
        );
        if (result.exitCode !== 0) {
          throw new Error(npmErrorMessage(result, "npm update"));
        }
        const resolvedPath = path.join(prefix, "node_modules", npmSpec.packageName);
        assertSafeDelegatePath(resolvedPath);
        const existing = await readSourceMetadata(resolvedPath);
        const metadata = buildMetadata(source, resolvedPath, npmSpec);
        metadata.installedAt = existing?.installedAt ?? metadata.installedAt;
        await writeSourceMetadata(resolvedPath, metadata);
        return resolvedPath;
      },
    );
  }

  const gitSpec = normalizeGitSpec(source);
  if (gitSpec) {
    return withFileLock(
      installLockFile(source),
      PI_HOME,
      async () => {
        const dest = path.join(DELEGATE_EXTS, "git", gitSpec.repoName);
        if (!fs.existsSync(dest)) return null;
        assertSafeDelegatePath(dest);
        const result = gitSpec.ref
          ? await runGit(["-C", dest, "fetch", "origin", gitSpec.ref], {
              timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
              signal: ctx?.signal ?? undefined,
            })
          : await runGit(["-C", dest, "pull"], {
              timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
              signal: ctx?.signal ?? undefined,
            });
        if (gitSpec.ref && result.exitCode === 0) {
          const checkout = await runGit(["-C", dest, "checkout", gitSpec.ref], {
            timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
            signal: ctx?.signal ?? undefined,
          });
          if (checkout.exitCode !== 0) {
            throw new Error(npmErrorMessage(checkout, "git checkout"));
          }
        }
        if (result.exitCode !== 0) {
          throw new Error(npmErrorMessage(result, gitSpec.ref ? "git fetch" : "git pull"));
        }
        const existing = await readSourceMetadata(dest);
        const metadata = buildMetadata(source, dest, undefined, gitSpec);
        metadata.installedAt = existing?.installedAt ?? metadata.installedAt;
        await writeSourceMetadata(dest, metadata);
        return dest;
      },
    );
  }

  return null;
}
