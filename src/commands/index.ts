import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleAdd } from "./add.js";
import { handleRemove } from "./remove.js";
import { handleList } from "./list.js";
import { handleEdit } from "./edit.js";
import { handleInstall, handleUpdate, handleUninstall } from "./install.js";
import {
  handleReset,
  handleThreads,
  handleClose,
  handlePrune,
} from "./sessions.js";
import { parseArgs } from "../args.js";

async function handleHelp(ctx: ExtensionCommandContext): Promise<void> {
  const lines = [
    "Delegate commands:",
    "  /delegate add <name> --model <model> [--tools t1,t2] [--extensions e1,e2] [--no-extensions] [--no-session] [--timeout <ms>] [--description \"desc\"]",
    "  /delegate remove <name> [--purge]",
    "  /delegate list",
    "  /delegate edit <name>",
    "  /delegate install <source> --agent <name> [--no-extensions] [--yes]",
    "  /delegate update <source> --agent <name>",
    "  /delegate uninstall <source> --agent <name>",
    "  /delegate reset <name>",
    "  /delegate threads [agent]",
    "  /delegate close <agent> <thread>",
    "  /delegate prune [--older <days>|--all]",
    "  /delegate help",
  ];
  // Widgets are TUI-only; in other modes surface the text via a notification.
  if (ctx.mode === "tui") {
    ctx.ui.setWidget("delegate-help", lines);
  } else {
    ctx.ui.notify(lines.join("\n"), "info");
  }
}

export async function handleDelegateCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const { subcommand, rest } = parseArgs(args);

    switch (subcommand) {
      case "add":
        await handleAdd(rest, ctx);
        break;
      case "remove":
        await handleRemove(rest.trim() || null, ctx);
        break;
      case "list":
        await handleList(ctx);
        break;
      case "install":
        await handleInstall(rest, ctx);
        break;
      case "update":
        await handleUpdate(rest, ctx);
        break;
      case "uninstall":
        await handleUninstall(rest, ctx);
        break;
      case "edit":
        await handleEdit(rest.trim() || null, ctx);
        break;
      case "reset":
        await handleReset(rest.trim() || null, ctx);
        break;
      case "threads":
        await handleThreads(rest.trim() || null, ctx);
        break;
      case "close": {
        const parts = rest.trim().split(/\s+/);
        await handleClose(parts[0] || null, parts[1] || null, ctx);
        break;
      }
      case "prune":
        await handlePrune(rest, ctx);
        break;
      case "":
      case "help":
        await handleHelp(ctx);
        break;
      default:
        ctx.ui.notify(
          `Unknown subcommand: ${subcommand}. Use /delegate help`,
          "error",
        );
    }
  } catch (error) {
    // Central boundary: handlers that perform filesystem/network work
    // (install, update, uninstall, reset, close, edit, ...) can throw.
    // Report an actionable message instead of letting a raw extension
    // exception escape to the user.
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`delegate: ${message}`, "error");
  }
}
