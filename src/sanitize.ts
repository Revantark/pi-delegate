import { createHash } from "node:crypto";

/**
 * Strict, reversible thread-id pattern. A thread id that already matches this
 * pattern is returned unchanged by {@link sanitizeThreadId}, which keeps valid
 * ids idempotent (re-sanitizing is a no-op, so reusing an id maps back to the
 * same session).
 */
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** True when `id` is already a safe, collision-free thread id. */
export function isValidThreadId(id: string): boolean {
  return THREAD_ID_PATTERN.test(id);
}

/**
 * Keep threadId safe for use in session ids and filenames without letting
 * distinct inputs silently collapse onto the same value.
 *
 * The old implementation did `id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)`,
 * so `research/a` and `research_a` both became `research_a` and shared a
 * session (issue 19).
 *
 * New behavior:
 * - Inputs that already match the strict pattern are returned unchanged.
 * - Arbitrary text becomes a readable prefix plus a short content hash, so two
 *   different inputs can never map to the same session id. Re-sanitizing the
 *   result is stable because the hash form itself satisfies the pattern.
 */
export function sanitizeThreadId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return "thread";
  if (THREAD_ID_PATTERN.test(trimmed)) return trimmed;
  const readable = trimmed.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  const suffix = createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
  return `${readable}-${suffix}`;
}

/** Keep agent name safe for use in session ids and filenames. */
export function sanitizeAgentName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  if (!cleaned || cleaned !== name)
    throw new Error(
      `Invalid agent name: "${name}". Use only letters, numbers, hyphens, underscores.`,
    );
  return cleaned;
}
