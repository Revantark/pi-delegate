/**
 * Atomic, crash-safe file writes with cross-process locking.
 *
 * Locking uses an atomic directory (`<file>.lock.d`) keyed by file path.
 * Directory creation is atomic on supported filesystems, so contending
 * processes either create it (win) or observe `EEXIST` (lose and retry). Lock
 * ownership metadata (pid, createdAt, random token) lives inside the directory;
 * a process only removes a lock it still owns, which avoids the PID-reuse race
 * of the old PID-file lock (issue 20, bugs A/E).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  lstatSync,
  realpathSync,
  rmSync,
} from "node:fs";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100; // 100 * 50ms = 5s
const LOCK_INIT_GRACE_MS = 5_000;
interface LockMeta {
  pid: number;
  createdAt: string;
  token: string;
}

/** Check if a process with given PID is still running */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if a path is a symbolic link */
export function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Ensure a directory exists and is not a symlink.
 *
 * When `root` is provided (a known trusted root such as `~/.pi`), the resolved
 * realpath is verified to be contained within it, so a path that escapes the
 * intended directory (e.g. via a symlinked parent) is rejected (issue 20, bug D).
 */
export function ensureSafeDir(dir: string, mode?: number, root?: string): void {
  const rootResolved = root ? (safeRealpath(root) ?? root) : undefined;
  const dirResolved = safeRealpath(dir) ?? dir;
  if (existsSync(dir)) {
    if (isSymlink(dir)) {
      throw new Error(`Refusing to use symlinked directory: ${dir}`);
    }
    if (rootResolved && !isContained(rootResolved, dirResolved)) {
      throw new Error(`Directory escapes trusted root: ${dir} not under ${root}`);
    }
    return;
  }
  mkdirSync(dir, { recursive: true, ...(mode !== undefined ? { mode } : {}) });
  if (rootResolved && !isContained(rootResolved, dirResolved)) {
    throw new Error(`Directory escapes trusted root: ${dir} not under ${root}`);
  }
}

/**
 * True iff `child` is contained within (or equal to) `parent`.
 * Uses path.relative() rather than naive prefix matching, so
 * `/Users/revantark2` is NOT treated as contained by `/Users/revantark`.
 */
export function isContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** realpathSync that returns the input on error instead of throwing (e.g. ENOENT, unreadable). */
export function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Load data from a file with symlink protection.
 */
export function loadFromFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  if (isSymlink(filePath)) {
    throw new Error(`Refusing to use symlinked file: ${filePath}`);
  }
  const content = readFileSync(filePath, "utf-8");
  if (!content.trim()) return undefined;
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`);
  }
}

/** Directory lock path for a given state file. */
function lockDirFor(filePath: string): string {
  return `${filePath}.lock.d`;
}

/** Remove a lock directory only if we still own it (token matches). */
function releaseLockDir(lockDir: string, metaPath: string, token: string): void {
  try {
    const raw = readFileSync(metaPath, "utf-8");
    const current = JSON.parse(raw) as Partial<LockMeta>;
    if (current.token === token) {
      rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {
    // Never remove a lock whose ownership cannot be verified. Another process
    // may have replaced its metadata after this process lost the lock.
  }
}

/**
 * Attempt to remove a stale lock directory. Returns true if the caller should
 * retry (the lock was stale and has been removed).
 */
function reclaimIfStale(lockDir: string, metaPath: string): boolean {
  try {
    const raw = readFileSync(metaPath, "utf-8");
    const meta = JSON.parse(raw) as Partial<LockMeta>;
    if (
      typeof meta.pid !== "number" ||
      typeof meta.createdAt !== "string" ||
      typeof meta.token !== "string"
    ) {
      return false;
    }
    // A live owner always wins, even when its operation is long-running.
    if (isProcessRunning(meta.pid)) return false;
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    // Missing metadata may mean another process is still initializing its lock.
    // Reclaim only after initialization grace; never immediately delete an
    // unverified lock during mkdir -> metadata-write window.
    try {
      const age = Date.now() - fs.statSync(lockDir).mtimeMs;
      if (age > LOCK_INIT_GRACE_MS) {
        rmSync(lockDir, { recursive: true, force: true });
        return true;
      }
    } catch {
      // Lock disappeared; caller retries.
    }
    return false;
  }
}

/**
 * Run `fn` while holding the cross-process lock for `filePath`. The directory
 * is created (atomic) before the lock is taken, so a fresh install where the
 * parent directory does not yet exist no longer fails with ENOENT (issue 20,
 * bug A).
 */
export async function withFileLock<T>(
  filePath: string,
  root: string | undefined = undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  // Ensure the parent directory exists (and is contained in `root`) *before*
  // trying to create the lock directory.
  ensureSafeDir(path.dirname(filePath), undefined, root);

  const lockDir = lockDirFor(filePath);
  const metaPath = path.join(lockDir, "meta.json");
  const token = randomUUID();
  const meta: LockMeta = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token,
  };

  let acquired = false;
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    let created = false;
    try {
      mkdirSync(lockDir, { recursive: false });
      created = true;
      writeFileSync(metaPath, JSON.stringify(meta), { mode: 0o600, flag: "wx" });
      acquired = true;
      break;
    } catch (e) {
      const code = e instanceof Error ? (e as { code?: string }).code : undefined;
      if (created) {
        // Metadata creation failed after directory creation. Do not recursively
        // remove it: another process may reclaim and replace this directory.
        // Stale recovery handles leftovers after initialization grace.
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      if (code === "EEXIST") {
        if (reclaimIfStale(lockDir, metaPath)) continue;
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      throw e;
    }
  }

  if (!acquired) throw new Error(`Failed to acquire lock: ${filePath}`);

  try {
    return await fn();
  } finally {
    releaseLockDir(lockDir, metaPath, token);
  }
}

/**
 * Write `data` to `filePath` atomically: a unique temp file is written with
 * restrictive `0o600` mode, then renamed over the target (rename is atomic on
 * the same filesystem). The unique temp name avoids collisions with abandoned
 * temp files or concurrent writers (issue 20, bugs B/C/G).
 */
function writeAtomically<T>(filePath: string, data: T): void {
  const dir = path.dirname(filePath);
  ensureSafeDir(dir);
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

/**
 * Load data, modify it, and save atomically with cross-process locking.
 * Returns the modified data after the write completes.
 *
 * A malformed existing file is NOT silently replaced with `{}`: the parse error
 * is propagated so a corrupt registry is never overwritten (issue 20, bug F).
 * Only a missing file starts from an empty object.
 */
export async function modifyFile<T>(
  filePath: string,
  fn: (data: T) => T,
  root?: string,
): Promise<T> {
  return withFileLock(filePath, root, async () => {
    let existing: T = {} as T;
    if (existsSync(filePath)) {
      if (isSymlink(filePath)) {
        throw new Error(`Refusing to use symlinked file: ${filePath}`);
      }
      const content = readFileSync(filePath, "utf-8");
      if (content) {
        existing = JSON.parse(content) as T;
      }
    }

    const modified = fn(existing);

    writeAtomically(filePath, modified);
    return modified;
  });
}

/**
 * Save data to a file atomically (no read-modify-write, just write), protected
 * by the same lock protocol as {@link modifyFile} so the two cannot clobber each
 * other (issue 20, bug B).
 */
export async function saveAtomically<T>(
  filePath: string,
  data: T,
  root?: string,
): Promise<void> {
  await withFileLock(filePath, root, async () => {
    writeAtomically(filePath, data);
  });
}
