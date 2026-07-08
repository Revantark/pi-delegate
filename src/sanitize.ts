/** Keep threadId safe for use in session ids and filenames. */
export function sanitizeThreadId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "thread";
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
