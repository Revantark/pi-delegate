import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { listAgents } from "../agents.js";
import { formatAgentList } from "../format.js";

export async function handleList(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const agents = listAgents();
  if (agents.length === 0) {
    ctx.ui.notify(
      "No agents registered. Use /delegate add <name> --model <model>",
      "info",
    );
    return;
  }
  const output = formatAgentList(agents);
  // Widgets are TUI-only; in json/print/rpc modes fall back to a notification
  // so the command is not silently a no-op.
  if (ctx.mode === "tui") {
    ctx.ui.setWidget("delegate-list", output.split("\n"));
  } else {
    ctx.ui.notify(output, "info");
  }
}
