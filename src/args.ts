/**
 * Argument parsing for delegate command subcommands.
 *
 * Tokenizer supports:
 *   --flag value, --flag=value, --no-flag, positional args,
 *   single/double quotes, and backslash escapes.
 */

export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (const ch of input) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/^\s$/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escape) {
    current += "\\";
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function parseFlagTokens(
  args: string,
): {
  positional: string[];
  opts: Map<string, string>;
  flags: Set<string>;
} {
  const tokens = tokenizeArgs(args);
  const positional: string[] = [];
  const opts = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith("--")) {
      positional.push(tok);
      continue;
    }

    const eq = tok.indexOf("=");
    if (eq !== -1) {
      opts.set(tok.slice(2, eq), tok.slice(eq + 1));
      continue;
    }

    const name = tok.slice(2);
    if (!name) continue;

    // Boolean flags consume no value.
    if (name === "no-extensions" || name === "no-session") {
      flags.add(tok);
      continue;
    }

    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      opts.set(name, next);
      i++;
    } else {
      opts.set(name, "");
    }
  }

  return { positional, opts, flags };
}

export function parseArgs(args: string): { subcommand: string; rest: string } {
  const trimmed = args.trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return { subcommand: trimmed, rest: "" };
  return {
    subcommand: trimmed.slice(0, spaceIdx),
    rest: trimmed.slice(spaceIdx + 1),
  };
}

export function parseAddArgs(
  args: string,
): {
  name: string;
  model: string;
  tools?: string[];
  description?: string;
  extensions?: string[];
  noAutoExtensions?: boolean;
  session?: boolean;
} | null {
  const { positional, opts, flags } = parseFlagTokens(args);
  if (positional.length === 0) return null;

  const name = positional[0];
  const model = opts.get("model");
  if (!model) return null;

  const tools = opts
    .get("tools")
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const extensions = opts
    .get("extensions")
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const description = opts.get("description");

  return {
    name,
    model,
    tools: tools && tools.length > 0 ? tools : undefined,
    description: description || undefined,
    extensions: extensions && extensions.length > 0 ? extensions : undefined,
    noAutoExtensions: flags.has("--no-extensions") || undefined,
    session: flags.has("--no-session") ? false : undefined,
  };
}

export function parseInstallArgs(
  args: string,
): { source: string; agent: string; noAutoExtensions?: boolean } | null {
  const { positional, opts, flags } = parseFlagTokens(args);
  if (positional.length === 0) return null;

  const agent = opts.get("agent");
  if (!agent) return null;

  return {
    source: positional[0],
    agent,
    noAutoExtensions: flags.has("--no-extensions") || undefined,
  };
}
