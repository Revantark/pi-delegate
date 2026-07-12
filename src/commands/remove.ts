import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  getAgent,
  loadThreads,
  removeAgent,
  removeThread,
} from "../agents.js";
import { sanitizeAgentName } from "../sanitize.js";
import { collectSessionIds, deleteSessionsById } from "../fsutil.js";
import { tryWithSessionFileLock } from "../locks.js";
import { SESSION_DIR } from "../paths.js";

/** How long `remove --purge` waits for an active session lock before skipping. */
const CLEANUP_LOCK_WAIT_MS = 1000;

export async function handleRemove(
  raw: string | null,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!raw) {
    ctx.ui.notify("Usage: /delegate remove <name> [--purge]", "error");
    return;
  }

  const tokens = raw.trim().split(/\s+/).filter((t) => t.length > 0);
  const name = tokens[0];
  if (!name) {
    ctx.ui.notify("Usage: /delegate remove <name> [--purge]", "error");
    return;
  }
  const purge = tokens.slice(1).includes("--purge");

  const agent = getAgent(name);
  if (!agent) {
    ctx.ui.notify(`Agent "${name}" not found`, "warning");
    return;
  }

  if (purge) {
    await purgeAgent(agent, ctx);
    return;
  }

  // Default: unregister the agent but preserve existing thread transcripts.
  // Removing the registry entry alone no longer silently orphans session
  // files and thread records (see issue 18). Data can be cleaned up later
  // with `reset <name>` or `remove <name> --purge`.
  await removeAgent(name);
  ctx.ui.notify(
    `Agent "${name}" removed. Thread transcripts were preserved. ` +
      `Use "/delegate reset ${name}" to delete its session files, or ` +
      `"/delegate remove ${name} --purge" to remove everything.`,
    "info",
  );
}

/**
 * Destructive removal: delete the agent's registry entry together with every
 * session file and thread record. Never runs without explicit confirmation,
 * because it destroys transcripts that cannot be recovered.
 */
async function purgeAgent(
  agent: { name: string },
  ctx: ExtensionCommandContext,
): Promise<void> {
  const name = agent.name;
  const safeAgent = sanitizeAgentName(name);
  const prefix = `delegate-${safeAgent}-`;

  const threads = await loadThreads();
  const threadIds = Object.values(threads)
    .filter((t) => t.agent === name)
    .map((t) => t.sessionId);
  const diskIds = collectSessionIds(SESSION_DIR, (id) => id.startsWith(prefix));
  const ids = Array.from(new Set([...diskIds, ...threadIds]));

  const count = ids.length;
  const message =
    `Remove agent "${name}" and delete ${count} thread session(s) and ` +
    `their transcript files? This cannot be undone.`;

  // Confirmation requires dialog-capable UI. In non-interactive modes refuse
  // the destructive purge rather than silently deleting data.
  const confirmed = ctx.hasUI
    ? await ctx.ui.confirm("Purge delegate agent", message)
    : false;

  if (!confirmed) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Refusing to purge "${name}" without confirmation. Run in interactive ` +
          `mode, or use "/delegate reset ${name}" to delete data separately.`,
        "warning",
      );
    } else {
      ctx.ui.notify(`Purge of "${name}" cancelled`, "info");
    }
    return;
  }

  let removed = 0;
  let dropped = 0;
  let skipped = 0;
  for (const id of ids) {
    const ran = await tryWithSessionFileLock(
      id,
      async () => {
        const rep = deleteSessionsById(id, SESSION_DIR);
        removed += rep.removed;
        skipped += rep.skipped;
        if (rep.skipped === 0) await removeThread(id);
      },
      { waitMs: CLEANUP_LOCK_WAIT_MS },
    );
    if (ran) dropped++;
    else skipped++;
  }

  // Do not unregister while active sessions remain. Keeping the agent
  // discoverable lets user retry purge after active work finishes.
  if (skipped > 0) {
    ctx.ui.notify(
      `Agent "${name}" was not removed: ${skipped} session(s) remain active or could not be cleaned. ` +
        `Retry /delegate remove ${name} --purge after they finish.`,
      "warning",
    );
    return;
  }

  await removeAgent(name);

  ctx.ui.notify(
    `Agent "${name}" removed. Deleted ${removed} session file(s) and ` +
      `${dropped} thread record(s).`,
    "info",
  );
}
