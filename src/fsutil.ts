import * as fs from "node:fs";
import * as path from "node:path";
import { isSymlink } from "./store.js";

/** Report of a session-directory cleanup: how many files were removed vs skipped. */
export interface CleanupReport {
  removed: number;
  skipped: number;
}

/**
 * Read first ~4KB of a session file, parse header, return its session id.
 * Returns null if it is not a `.jsonl` session file or the header is unreadable.
 *
 * The descriptor is always closed via `try/finally` so a read error cannot leak
 * an open fd (issue 21). The header must be a complete first line and must have
 * `type === "session"`; an unterminated header larger than 4KB is rejected as
 * malformed rather than silently misparsed.
 */
function readSessionId(full: string): string | null {
  if (!full.endsWith(".jsonl")) return null;
  let fd: number;
  try {
    fd = fs.openSync(full, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buf, 0, 4096, 0);
    if (bytes <= 0) return null;
    const text = buf.subarray(0, bytes).toString("utf-8");
    const newlineIdx = text.indexOf("\n");
    if (newlineIdx === -1 && bytes === 4096) {
      // Header did not fit in 4KB and is unterminated: too large/malformed.
      return null;
    }
    const firstLine = newlineIdx === -1 ? text : text.slice(0, newlineIdx);
    const header = JSON.parse(firstLine);
    return header && typeof header.id === "string" && header.type === "session"
      ? header.id
      : null;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

/**
 * Read first ~4KB of a session file, parse header, check predicate.
 * Avoids reading entire multi-MB session into memory just to inspect id.
 */
function sessionFileMatches(
  full: string,
  predicate: (id: string) => boolean,
): boolean {
  const id = readSessionId(full);
  return id ? predicate(id) : false;
}

/**
 * Walk session dir tree and delete files matching predicate.
 *
 * Each directory entry is handled independently, so a permission error on one
 * entry does not abort the whole cleanup (issue 21). The result reports how many
 * files were removed and how many were skipped. Empty subdirectories are removed
 * afterwards, except the trusted root itself and the `.locks` directory.
 */
function deleteSessions(
  sessionDir: string,
  predicate: (id: string) => boolean,
): CleanupReport {
  const report: CleanupReport = { removed: 0, skipped: 0 };
  if (!fs.existsSync(sessionDir)) return report;
  if (isSymlink(sessionDir)) return report; // refuse to walk a symlinked root

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      report.skipped++;
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (isSymlink(full)) continue; // skip symlinked entries
      try {
        if (entry.isDirectory()) {
          walk(full);
        } else if (sessionFileMatches(full, predicate)) {
          fs.rmSync(full, { force: true });
          report.removed++;
        }
      } catch {
        report.skipped++;
      }
    }
    // Remove now-empty subdirectories (never the trusted root, never .locks).
    if (dir !== sessionDir && path.basename(dir) !== ".locks") {
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        // ignore (non-empty, permission, etc.)
      }
    }
  };
  walk(sessionDir);
  return report;
}

export function deleteSessionsById(
  sessionId: string,
  sessionDir: string,
): CleanupReport {
  return deleteSessions(sessionDir, (id) => id === sessionId);
}

export function deleteSessionsByPrefix(
  prefix: string,
  sessionDir: string,
): CleanupReport {
  return deleteSessions(sessionDir, (id) => id.startsWith(prefix));
}

/**
 * Walk session dir tree and collect session ids matching predicate.
 * Used to make prefix-based cleanup lock-safe (so each session can be locked
 * individually before deletion).
 */
export function collectSessionIds(
  sessionDir: string,
  predicate: (id: string) => boolean,
): string[] {
  if (!fs.existsSync(sessionDir)) return [];
  if (isSymlink(sessionDir)) return []; // refuse to walk a symlinked root
  const ids: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (isSymlink(full)) continue; // skip symlinked entries
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const id = readSessionId(full);
        if (id && predicate(id)) ids.push(id);
      }
    }
  };
  walk(sessionDir);
  return ids;
}
