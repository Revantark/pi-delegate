import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { addAgent } from "../agents.js";
import { sanitizeAgentName } from "../sanitize.js";
import { parseAddArgs } from "../args.js";

export async function handleAdd(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parseAddArgs(args);
  if (!parsed) {
    ctx.ui.notify(
      'Usage: /delegate add <name> --model <model> [--tools t1,t2] [--extensions e1,e2] [--no-extensions] [--no-session] [--timeout <ms>] [--description "desc"]',
      "error",
    );
    return;
  }
  try {
    sanitizeAgentName(parsed.name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(message, "error");
    return;
  }
  await addAgent(
    parsed.name,
    parsed.model,
    parsed.tools,
    parsed.description,
    parsed.extensions,
    parsed.noAutoExtensions,
    parsed.session,
    parsed.timeoutMs,
  );
  const toolsStr = parsed.tools ? ` (${parsed.tools.join(", ")})` : "";
  const descStr = parsed.description ? ` - ${parsed.description}` : "";
  const extStr = parsed.extensions
    ? ` with extensions: ${parsed.extensions.join(", ")}`
    : "";
  const noAuto = parsed.noAutoExtensions ? " (auto-extensions disabled)" : "";
  const sessStr =
    parsed.session === false ? " (ephemeral)" : " (session memory on)";
  ctx.ui.notify(
    `Agent "${parsed.name}" registered with model ${parsed.model}${toolsStr}${extStr}${noAuto}${sessStr}${descStr}`,
    "info",
  );
}
