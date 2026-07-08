import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Read first ~4KB of a session file, parse header, check predicate.
 * Avoids reading entire multi-MB session into memory just to inspect id.
 */
function sessionFileMatches(
  full: string,
  predicate: (id: string) => boolean,
): boolean {
  if (!full.endsWith(".jsonl")) return false;
  try {
    const fd = fs.openSync(full, "r");
    const buf = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const firstLine = buf.subarray(0, bytes).toString("utf-8").split("\n")[0];
    const header = JSON.parse(firstLine);
    return !!(header && typeof header.id === "string" && predicate(header.id));
  } catch {
    return false;
  }
}

/**
 * Walk session dir tree and delete files matching predicate.
 * Returns count of removed files.
 */
function deleteSessions(
  sessionDir: string,
  predicate: (id: string) => boolean,
): number {
  if (!fs.existsSync(sessionDir)) return 0;
  let removed = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (sessionFileMatches(full, predicate)) {
        fs.rmSync(full, { force: true });
        removed++;
      }
    }
  };
  walk(sessionDir);
  return removed;
}

export function deleteSessionsById(
  sessionId: string,
  sessionDir: string,
): number {
  return deleteSessions(sessionDir, (id) => id === sessionId);
}

export function deleteSessionsByPrefix(
  prefix: string,
  sessionDir: string,
): number {
  return deleteSessions(sessionDir, (id) => id.startsWith(prefix));
}
