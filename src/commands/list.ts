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
  // Notify goes to chat scrollback so it scrolls away; a widget would stick
  // above the editor until the next turn.
  ctx.ui.notify(output, "info");
}
