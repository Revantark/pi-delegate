import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { removeAgent } from "../agents.js";

export async function handleRemove(
  name: string | null,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!name) {
    ctx.ui.notify("Usage: /delegate remove <name>", "error");
    return;
  }
  const removed = await removeAgent(name);
  if (removed) {
    ctx.ui.notify(`Agent "${name}" removed`, "info");
  } else {
    ctx.ui.notify(`Agent "${name}" not found`, "warning");
  }
}
