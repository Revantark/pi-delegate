/**
 * Atomic, crash-safe file writes with PID-based cross-process locking.
 * Ported from pi-subagents/src/schedule-store.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, lstatSync } from "node:fs";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

/** Check if a process with given PID is still running */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Acquire a PID-based cross-process lock, reclaiming stale locks from dead PIDs */
function acquireLock(lockPath: string): void {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        try {
          const existingPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
          if (existingPid && !isProcessRunning(existingPid)) {
            // Stale lock - reclaim it
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Ignore read errors - retry
        }
        // Wait for lock to be released
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) {
          /* busy wait */
        }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

/** Release a lock file */
function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Ignore errors on unlock
  }
}

/** Check if a path is a symbolic link */
export function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Ensure a directory exists and is not a symlink (mirrors pi-subagents ensureMemoryDir). */
export function ensureSafeDir(dir: string): void {
  if (existsSync(dir)) {
    if (isSymlink(dir)) {
      throw new Error(`Refusing to use symlinked directory: ${dir}`);
    }
    return;
  }
  mkdirSync(dir, { recursive: true });
}

/** In-memory lock for serializing operations within a single process */
const inProcessLocks = new Map<string, Promise<unknown>>();

/**
 * Load data from a file with symlink protection.
 */
export function loadFromFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  if (isSymlink(filePath)) return undefined;
  try {
    const content = readFileSync(filePath, "utf-8");
    return content ? JSON.parse(content) as T : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Save data to a file atomically (no read-modify-write, just write).
 */
export function saveAtomically<T>(filePath: string, data: T): void {
  const tmpPath = `${filePath}.tmp`;
  const dir = path.dirname(filePath);
  ensureSafeDir(dir);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * Load data, modify it, and save atomically with cross-process locking.
 * Returns the modified data after the write completes.
 */
export async function modifyFile<T>(
  filePath: string,
  fn: (data: T) => T
): Promise<T> {
  const lockKey = `__lock_${filePath}`;
  const lockPath = `${filePath}.lock`;

  const prev = inProcessLocks.get(lockKey) ?? Promise.resolve();
  const next = prev.then(async () => {
    acquireLock(lockPath);
    try {
      // Read existing data (or empty object)
      let existing: T = ({} as T);
      if (existsSync(filePath)) {
        if (isSymlink(filePath)) {
          throw new Error(`Refusing to use symlinked file: ${filePath}`);
        }
        try {
          const content = readFileSync(filePath, "utf-8");
          if (content) {
            existing = JSON.parse(content) as T;
          }
        } catch {
          existing = {} as T;
        }
      }

      // Modify data
      const modified = fn(existing);

      // Atomic write: write to temp, then rename
      const tmpPath = `${filePath}.tmp`;
      const dir = path.dirname(filePath);
      ensureSafeDir(dir);
      writeFileSync(tmpPath, JSON.stringify(modified, null, 2), "utf-8");
      renameSync(tmpPath, filePath);

      return modified;
    } finally {
      releaseLock(lockPath);
    }
  });

  const chained = next.then(
    (v) => {
      if (inProcessLocks.get(lockKey) === chained) {
        inProcessLocks.delete(lockKey);
      }
      return v;
    },
    (e) => {
      if (inProcessLocks.get(lockKey) === chained) {
        inProcessLocks.delete(lockKey);
      }
      throw e;
    }
  );

  inProcessLocks.set(lockKey, chained);
  return chained;
}