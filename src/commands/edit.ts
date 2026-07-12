import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgent, renameAgent, type AgentConfig } from "../agents.js";
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

  // `ctx.ui.editor()` requires an interactive, dialog-capable UI. In
  // json/print/rpc modes without a UI it is unavailable, so bail early
  // rather than calling it blindly.
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "Editing an agent requires interactive UI mode (TUI or RPC).",
      "error",
    );
    return;
  }

  const config = {
    name: agent.name,
    model: agent.model,
    ...(agent.tools && { tools: agent.tools }),
    ...(agent.extensions && { extensions: agent.extensions }),
    ...(agent.noAutoExtensions && { noAutoExtensions: agent.noAutoExtensions }),
    ...(agent.session !== undefined && { session: agent.session }),
    ...(agent.timeoutMs !== undefined && { timeoutMs: agent.timeoutMs }),
    ...(agent.description && { description: agent.description }),
  };
  const initialJson = JSON.stringify(config, null, 2);

  const edited = await ctx.ui.editor(`Edit agent "${name}"`, initialJson);
  if (!edited) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(edited);
  } catch {
    ctx.ui.notify("Invalid JSON. Edit cancelled.", "error");
    return;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    ctx.ui.notify("Edited value must be a JSON object", "error");
    return;
  }
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.name !== "string" || !candidate.name) {
    ctx.ui.notify("Missing or invalid 'name' field", "error");
    return;
  }
  if (typeof candidate.model !== "string" || !candidate.model) {
    ctx.ui.notify("Missing or invalid 'model' field", "error");
    return;
  }
  const arrayFieldIsValid = (key: "tools" | "extensions") =>
    candidate[key] === undefined ||
    (Array.isArray(candidate[key]) && candidate[key].every((value) => typeof value === "string"));
  if (!arrayFieldIsValid("tools") || !arrayFieldIsValid("extensions")) {
    ctx.ui.notify("'tools' and 'extensions' must be arrays of strings", "error");
    return;
  }
  if (candidate.description !== undefined && typeof candidate.description !== "string") {
    ctx.ui.notify("'description' must be a string", "error");
    return;
  }
  if (candidate.noAutoExtensions !== undefined && typeof candidate.noAutoExtensions !== "boolean") {
    ctx.ui.notify("'noAutoExtensions' must be boolean", "error");
    return;
  }
  if (candidate.session !== undefined && typeof candidate.session !== "boolean") {
    ctx.ui.notify("'session' must be boolean", "error");
    return;
  }
  if (
    candidate.timeoutMs !== undefined &&
    (typeof candidate.timeoutMs !== "number" ||
      !Number.isInteger(candidate.timeoutMs) ||
      candidate.timeoutMs <= 0)
  ) {
    ctx.ui.notify("'timeoutMs' must be a positive integer", "error");
    return;
  }

  try {
    sanitizeAgentName(candidate.name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(message, "error");
    return;
  }

  const updatedAgent: AgentConfig = {
    name: candidate.name,
    model: candidate.model,
    ...(candidate.tools !== undefined && { tools: candidate.tools as string[] }),
    ...(candidate.extensions !== undefined && { extensions: candidate.extensions as string[] }),
    ...(candidate.noAutoExtensions !== undefined && {
      noAutoExtensions: candidate.noAutoExtensions as boolean,
    }),
    ...(candidate.session !== undefined && { session: candidate.session as boolean }),
    ...(candidate.timeoutMs !== undefined && { timeoutMs: candidate.timeoutMs as number }),
    ...(candidate.description !== undefined && { description: candidate.description as string }),
  };

  await renameAgent(name, updatedAgent);
  ctx.ui.notify(`Agent "${updatedAgent.name}" saved`, "info");
}
