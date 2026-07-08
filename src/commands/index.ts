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
  ctx.ui.setWidget("delegate-help", [
    "Delegate commands:",
    "  /delegate add <name> --model <model> [--tools t1,t2] [--extensions e1,e2] [--no-extensions] [--description \"desc\"]",
    "  /delegate remove <name>",
    "  /delegate list",
    "  /delegate edit <name>",
    "  /delegate install <source> --agent <name> [--no-extensions]",
    "  /delegate update <source> --agent <name>",
    "  /delegate uninstall <source> --agent <name>",
    "  /delegate reset <name>",
    "  /delegate threads [agent]",
    "  /delegate close <agent> <thread>",
    "  /delegate prune [--older <days>|--all]",
    "  /delegate help",
  ]);
}

export async function handleDelegateCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
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
}
