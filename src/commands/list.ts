import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { listAgents } from "../agents.js";

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
  const lines = agents.map((a) => {
    const tools = a.tools ? ` (${a.tools.join(", ")})` : " (all tools)";
    const desc = a.description ? ` - ${a.description}` : "";
    const ext = a.extensions ? ` [ext: ${a.extensions.join(", ")}]` : "";
    const noAuto = a.noAutoExtensions ? " [no-auto-ext]" : "";
    const sess = a.session === false ? " [ephemeral]" : " [session]";
    return `\u2022 ${a.name}: ${a.model}${tools}${ext}${noAuto}${sess}${desc}`;
  });
  ctx.ui.setWidget("delegate-list", ["Registered agents:", ...lines]);
}
