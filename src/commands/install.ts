import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgent, updateAgent } from "../agents.js";
import { parseInstallArgs } from "../args.js";
import {
  installExtensionSource,
  updateExtensionSource,
  installDestinationPreview,
} from "../extensions.js";

export async function handleInstall(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parseInstallArgs(args);
  if (!parsed) {
    ctx.ui.notify(
      "Usage: /delegate install <source> --agent <name> [--no-extensions] [--yes]",
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

  // Installing an extension is a high-impact operation: npm packages can run
  // lifecycle scripts and git repositories contain arbitrary TypeScript that
  // executes inside delegated child processes (issue 22). Require explicit
  // confirmation in interactive modes, or an explicit --yes flag otherwise.
  const destination = installDestinationPreview(parsed.source);
  if (!parsed.yes) {
    if (ctx.hasUI) {
      const confirmed = await ctx.ui.confirm(
        "Install delegate extension?",
        `Install extension source \`${parsed.source}\` for agent \`${parsed.agent}\`?\n\n` +
          `This source will run with Pi's full permissions in delegated child processes.` +
          (destination ? `\n\nDestination: ${destination}` : ""),
      );
      if (!confirmed) {
        ctx.ui.notify("Installation cancelled.", "info");
        return;
      }
    } else {
      ctx.ui.notify(
        `Refusing interactive install in non-interactive mode. Re-run with --yes to install \`${parsed.source}\` for agent \`${parsed.agent}\`, or use an interactive (TUI/RPC) session.`,
        "error",
      );
      return;
    }
  }

  ctx.ui.notify(
    `Installing ${parsed.source} for agent "${parsed.agent}"...`,
    "info",
  );
  const installedPath = await installExtensionSource(parsed.source, ctx);
  if (!installedPath) {
    ctx.ui.notify(`Failed to install "${parsed.source}"`, "error");
    return;
  }
  ctx.ui.notify(`Installed to ${installedPath}`, "info");
  try {
    await updateAgent(parsed.agent, {
      extensions: [...existing, parsed.source],
      noAutoExtensions: parsed.noAutoExtensions ?? agent.noAutoExtensions,
    });
    ctx.ui.notify(`Added "${parsed.source}" to agent "${parsed.agent}"`, "info");
  } catch (err) {
    // Installation succeeded but the config update failed: the artifact is now
    // orphaned (not referenced by any agent). Report it instead of swallowing.
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(
      `Installed "${parsed.source}" to ${installedPath} but failed to update agent ` +
        `"${parsed.agent}" (${message}). The installed artifact is now orphaned; ` +
        `remove it manually or re-run /delegate install after fixing the error.`,
      "error",
    );
  }
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
  const updatedPath = await updateExtensionSource(parsed.source, ctx);
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
  await updateAgent(parsed.agent, {
    extensions: updated.length > 0 ? updated : undefined,
  });
  ctx.ui.notify(
    `Removed "${parsed.source}" from agent "${parsed.agent}"`,
    "info",
  );
}
