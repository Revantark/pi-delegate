/**
 * Session-level write lock — serializes delegate calls targeting the same
 * session file so concurrent runs don't interleave JSONL writes.
 */
const sessionLocks = new Map<string, Promise<unknown>>();

export function withSessionLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = sessionLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const chained = next.then(
    (v) => {
      if (sessionLocks.get(key) === chained) sessionLocks.delete(key);
      return v;
    },
    (e) => {
      if (sessionLocks.get(key) === chained) sessionLocks.delete(key);
      throw e;
    },
  );
  sessionLocks.set(key, chained);
  return chained as Promise<T>;
}
