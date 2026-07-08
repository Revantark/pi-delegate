import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgent, addAgent } from "../agents.js";
import { parseInstallArgs } from "../args.js";
import {
  installExtensionSource,
  updateExtensionSource,
} from "../extensions.js";

export async function handleInstall(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parseInstallArgs(args);
  if (!parsed) {
    ctx.ui.notify(
      "Usage: /delegate install <source> --agent <name> [--no-extensions]",
      "error",
    );
    return;
  }
  const agent = getAgent(parsed.agent);
  if (!agent) {
    ctx.ui.notify(
      `Agent "${parsed.agent}" not found. Use /delegate add first.`,
      "error",
    );
    return;
  }
  const existing = agent.extensions || [];
  if (existing.includes(parsed.source)) {
    ctx.ui.notify(
      `Agent "${parsed.agent}" already has "${parsed.source}"`,
      "warning",
    );
    return;
  }
  ctx.ui.notify(
    `Installing ${parsed.source} for agent "${parsed.agent}"...`,
    "info",
  );
  const installedPath = await installExtensionSource(parsed.source);
  if (!installedPath) {
    ctx.ui.notify(`Failed to install "${parsed.source}"`, "error");
    return;
  }
  ctx.ui.notify(`Installed to ${installedPath}`, "info");
  await addAgent(
    parsed.agent,
    agent.model,
    agent.tools,
    agent.description,
    [...existing, parsed.source],
    parsed.noAutoExtensions || agent.noAutoExtensions,
  );
  ctx.ui.notify(`Added "${parsed.source}" to agent "${parsed.agent}"`, "info");
}

export async function handleUpdate(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parseInstallArgs(args);
  if (!parsed) {
    ctx.ui.notify("Usage: /delegate update <source> --agent <name>", "error");
    return;
  }
  const agent = getAgent(parsed.agent);
  if (!agent) {
    ctx.ui.notify(`Agent "${parsed.agent}" not found`, "error");
    return;
  }
  const existing = agent.extensions || [];
  if (!existing.includes(parsed.source)) {
    ctx.ui.notify(
      `Agent "${parsed.agent}" does not have "${parsed.source}"`,
      "warning",
    );
    return;
  }
  ctx.ui.notify(
    `Updating ${parsed.source} for agent "${parsed.agent}"...`,
    "info",
  );
  const updatedPath = await updateExtensionSource(parsed.source);
  if (!updatedPath) {
    ctx.ui.notify(
      `Failed to update "${parsed.source}". Try /delegate install first.`,
      "error",
    );
    return;
  }
  ctx.ui.notify(`Updated: ${updatedPath}`, "info");
}

export async function handleUninstall(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parseInstallArgs(args);
  if (!parsed) {
    ctx.ui.notify(
      "Usage: /delegate uninstall <source> --agent <name>",
      "error",
    );
    return;
  }
  const agent = getAgent(parsed.agent);
  if (!agent) {
    ctx.ui.notify(`Agent "${parsed.agent}" not found`, "error");
    return;
  }
  const existing = agent.extensions || [];
  if (!existing.includes(parsed.source)) {
    ctx.ui.notify(
      `Agent "${parsed.agent}" does not have "${parsed.source}"`,
      "warning",
    );
    return;
  }
  const updated = existing.filter((e) => e !== parsed.source);
  await addAgent(
    parsed.agent,
    agent.model,
    agent.tools,
    agent.description,
    updated.length > 0 ? updated : undefined,
    agent.noAutoExtensions,
  );
  ctx.ui.notify(
    `Removed "${parsed.source}" from agent "${parsed.agent}"`,
    "info",
  );
}
