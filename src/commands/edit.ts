import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgent, addAgent, removeAgent } from "../agents.js";
import { sanitizeAgentName } from "../sanitize.js";

export async function handleEdit(
  name: string | null,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!name) {
    ctx.ui.notify("Usage: /delegate edit <name>", "error");
    return;
  }
  const agent = getAgent(name);
  if (!agent) {
    ctx.ui.notify(`Agent "${name}" not found`, "warning");
    return;
  }

  const config = {
    name: agent.name,
    model: agent.model,
    ...(agent.tools && { tools: agent.tools }),
    ...(agent.extensions && { extensions: agent.extensions }),
    ...(agent.noAutoExtensions && { noAutoExtensions: agent.noAutoExtensions }),
    ...(agent.session !== undefined && { session: agent.session }),
    ...(agent.description && { description: agent.description }),
  };
  const initialJson = JSON.stringify(config, null, 2);

  const edited = await ctx.ui.editor(`Edit agent "${name}"`, initialJson);
  if (!edited) return;

  let parsed: any;
  try {
    parsed = JSON.parse(edited);
  } catch {
    ctx.ui.notify("Invalid JSON. Edit cancelled.", "error");
    return;
  }

  if (!parsed.name || typeof parsed.name !== "string") {
    ctx.ui.notify("Missing or invalid 'name' field", "error");
    return;
  }
  if (!parsed.model || typeof parsed.model !== "string") {
    ctx.ui.notify("Missing or invalid 'model' field", "error");
    return;
  }

  try {
    sanitizeAgentName(parsed.name);
  } catch (e: any) {
    ctx.ui.notify(e.message, "error");
    return;
  }

  if (parsed.name !== name) {
    await removeAgent(name);
  }

  await addAgent(
    parsed.name,
    parsed.model,
    Array.isArray(parsed.tools) ? parsed.tools : undefined,
    typeof parsed.description === "string" ? parsed.description : undefined,
    Array.isArray(parsed.extensions) ? parsed.extensions : undefined,
    typeof parsed.noAutoExtensions === "boolean"
      ? parsed.noAutoExtensions
      : undefined,
    typeof parsed.session === "boolean" ? parsed.session : undefined,
  );

  ctx.ui.notify(`Agent "${parsed.name}" saved`, "info");
}
