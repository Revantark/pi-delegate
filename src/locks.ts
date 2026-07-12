/**
 * Cross-process session lock.
 *
 * Serializes operations that touch the same delegate session file
 * (`~/.pi/delegate-sessions/<sessionId>.jsonl`) across separate parent Pi
 * processes. The previous implementation used an in-memory `Map`, which only
 * coordinated calls inside a single Node process — two different Pi processes
 * could concurrently read/write the same session, and cleanup commands took no
 * lock at all.
 *
 * The lock is a directory under `SESSION_DIR/.locks/<encoded-session-id>.lock`.
 * Directory creation is atomic on supported filesystems, so contending
 * processes either create it (win) or observe `EEXIST` (lose and retry). Lock
 * ownership metadata (pid, createdAt, random token) lives inside the directory;
 * a process only removes a lock it still owns, and reclaims stale locks left by
 * dead processes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { SESSION_DIR } from "./paths.js";
import { ensureSafeDir } from "./store.js";

const LOCK_DIR = path.join(SESSION_DIR, ".locks");
const LOCK_RETRY_MS = 50;
const DEFAULT_LOCK_WAIT_MS = 10_000;
const LOCK_INIT_GRACE_MS = 5_000;

interface LockMeta {
  pid: number;
  createdAt: string;
  token: string;
}

/** Thrown when a lock cannot be acquired within the allowed wait budget. */
export class SessionLockTimeoutError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session "${sessionId}" is locked by another process`);
    this.name = "SessionLockTimeoutError";
  }
}

function encodeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

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

function retriesForWait(waitMs: number): number {
  if (waitMs <= 0) return 1;
  return Math.max(1, Math.ceil(waitMs / LOCK_RETRY_MS));
}

/**
 * Attempt to remove a lock directory that is no longer valid. Returns true if
 * the caller should retry (the lock was stale and has been removed).
 */
function reclaimIfStale(lockDir: string, metaPath: string): boolean {
  try {
    const raw = fs.readFileSync(metaPath, "utf-8");
    const meta = JSON.parse(raw) as LockMeta;
    // A live owner always wins, even when its operation is long-running.
    // Age alone must never steal an active session lock.
    if (isProcessRunning(meta.pid)) return false;
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    // Missing metadata can mean another process is between mkdir and metadata
    // write. Reclaim only after an initialization grace period.
    try {
      const age = Date.now() - fs.statSync(lockDir).mtimeMs;
      if (age > LOCK_INIT_GRACE_MS) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        return true;
      }
    } catch {
      // Directory disappeared; caller retries.
    }
    return false;
  }
  return false;
}

export interface SessionLockOptions {
  /** Maximum time to wait for the lock before giving up. Default 10s. */
  waitMs?: number;
}

/**
 * Run `fn` while holding the cross-process lock for `sessionId`. The lock
 * covers the entire lifetime of `fn`, so concurrent operations on the same
 * session (including long-running child processes) are serialized.
 *
 * Different session IDs use different lock directories and run in parallel,
 * so multiple Pi sessions operating on different threads are not blocked.
 */
export async function withSessionFileLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
  opts: SessionLockOptions = {},
): Promise<T> {
  ensureSafeDir(LOCK_DIR, undefined, SESSION_DIR);
  const lockDir = path.join(LOCK_DIR, encodeSessionId(sessionId));
  const metaPath = path.join(lockDir, "meta.json");
  const token = randomUUID();
  const meta: LockMeta = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token,
  };

  const maxRetries = retriesForWait(opts.waitMs ?? DEFAULT_LOCK_WAIT_MS);
  let acquired = false;

  for (let i = 0; i < maxRetries; i++) {
    let created = false;
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      created = true;
      fs.writeFileSync(metaPath, JSON.stringify(meta), { mode: 0o600 });
      acquired = true;
      break;
    } catch (e) {
      if (created) {
        // Metadata creation failed after directory creation. Do not recursively
        // remove it: another process may reclaim and replace this directory.
        // Stale recovery handles leftovers after initialization grace.
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      if (e instanceof Error && (e as { code?: string }).code === "EEXIST") {
        if (reclaimIfStale(lockDir, metaPath)) {
          continue;
        }
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      throw e;
    }
  }

  if (!acquired) {
    throw new SessionLockTimeoutError(sessionId);
  }

  try {
    return await fn();
  } finally {
    // Release only if we still own the lock (token matches). Never delete a
    // lock owned by another process.
    try {
      const raw = fs.readFileSync(metaPath, "utf-8");
      const current = JSON.parse(raw) as LockMeta;
      if (current.token === token) {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    } catch {
      // Ownership cannot be verified. Never recursively remove this path:
      // another process may have replaced the lock after a race.
    }
  }
}

/**
 * Like {@link withSessionFileLock} but returns `false` instead of throwing when
 * the lock cannot be acquired (e.g. the session is active in another process).
 * Use this from cleanup commands so they skip active sessions rather than
 * blocking or deleting files a child is still using.
 *
 * Returns `true` if `fn` ran, `false` if the lock was held. Errors thrown by
 * `fn` itself propagate.
 */
export async function tryWithSessionFileLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
  opts: SessionLockOptions = {},
): Promise<boolean> {
  try {
    await withSessionFileLock(sessionId, fn, opts);
    return true;
  } catch (e) {
    if (e instanceof SessionLockTimeoutError) return false;
    throw e;
  }
}
