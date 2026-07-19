import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  getAgent,
  loadThreads,
  removeThread,
} from "../agents.js";
import { sanitizeAgentName, sanitizeThreadId } from "../sanitize.js";
import {
  deleteSessionsById,
  collectSessionIds,
} from "../fsutil.js";
import { tryWithSessionFileLock } from "../locks.js";
import { SESSION_DIR } from "../paths.js";

/** How long cleanup waits for an active session lock before skipping it. */
const CLEANUP_LOCK_WAIT_MS = 1000;
/** How long `close` waits for a (likely finishing) session before skipping. */
const CLOSE_LOCK_WAIT_MS = 2000;

export async function handleThreads(
  agentFilter: string | null,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const threads = await loadThreads();
  const entries = Object.values(threads).filter(
    (t) => !agentFilter || t.agent === agentFilter,
  );
  if (entries.length === 0) {
    ctx.ui.notify(
      agentFilter
        ? `No threads for agent "${agentFilter}"`
        : "No delegate threads.",
      "info",
    );
    return;
  }
  const lines = entries
    .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))
    .map((t) => {
      const display = t.userThreadId && t.userThreadId !== t.threadId
        ? `${t.userThreadId} (${t.threadId})`
        : t.threadId;
      return `\u2022 ${t.agent} / ${display}  (last ${t.lastUsed})`;
    });
  const output = ["Delegate threads:", ...lines].join("\n");
  // Notify goes to chat scrollback so it scrolls away; a widget would stick
  // above the editor until the next turn.
  ctx.ui.notify(output, "info");
}

export async function handleClose(
  agent: string | null,
  thread: string | null,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!agent || !thread) {
    ctx.ui.notify("Usage: /delegate close <agent> <thread>", "error");
    return;
  }
  const safeAgent = sanitizeAgentName(agent);
  const sessionId = `delegate-${safeAgent}-${sanitizeThreadId(thread)}`;

  let removed = 0;
  let skippedFiles = 0;
  const ran = await tryWithSessionFileLock(
    sessionId,
    async () => {
      const rep = deleteSessionsById(sessionId, SESSION_DIR);
      removed = rep.removed;
      skippedFiles = rep.skipped;
      if (rep.skipped === 0) await removeThread(sessionId);
    },
    { waitMs: CLOSE_LOCK_WAIT_MS },
  );

  if (!ran) {
    ctx.ui.notify(
      `Session "${thread}" for ${agent} is active in another process; not closed.`,
      "warning",
    );
    return;
  }

  ctx.ui.notify(
    removed > 0
      ? `Closed thread "${thread}" for ${agent} (${removed} file(s) removed)`
      : skippedFiles > 0
        ? `Could not fully close thread "${thread}" for ${agent}; ${skippedFiles} file(s) skipped and thread record preserved.`
        : `No session files found for ${agent}/${thread}`,
    skippedFiles > 0 ? "warning" : "info",
  );
}

export async function handlePrune(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const all = /(?:^|\s)--all(?:\s|$)/.test(args);
  const olderMatch = args.match(/--older\s+(\d+)/);
  const olderDays = olderMatch ? parseInt(olderMatch[1], 10) : 7;
  const threads = await loadThreads();
  const now = Date.now();
  let pruned = 0;
  let skipped = 0;
  let fileSkips = 0;
  for (const sid of Object.keys(threads)) {
    const t = threads[sid];
    const ageMs = now - new Date(t.lastUsed).getTime();
    if (all || ageMs > olderDays * 86400000) {
      const ran = await tryWithSessionFileLock(
        t.sessionId,
        async () => {
          const rep = deleteSessionsById(t.sessionId, SESSION_DIR);
          fileSkips += rep.skipped;
          if (rep.skipped === 0) await removeThread(sid);
        },
        { waitMs: CLEANUP_LOCK_WAIT_MS },
      );
      if (ran) pruned++;
      else skipped++;
    }
  }
  const skippedNote = skipped > 0 ? `, skipped ${skipped} active` : "";
  const fileSkipNote = fileSkips > 0 ? `, ${fileSkips} file(s) skipped` : "";
  ctx.ui.notify(
    `Pruned ${pruned} thread(s)${all ? " (all)" : ` (unused > ${olderDays}d)`}${skippedNote}${fileSkipNote}`,
    "info",
  );
}

export async function handleReset(
  name: string | null,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!name) {
    ctx.ui.notify("Usage: /delegate reset <name>", "error");
    return;
  }
  const agent = getAgent(name);
  if (!agent) {
    ctx.ui.notify(`Agent "${name}" not found`, "warning");
    return;
  }

  const prefix = `delegate-${agent.name}-`;
  const threads = await loadThreads();
  const threadIds = Object.values(threads)
    .filter((t) => t.agent === agent.name)
    .map((t) => t.sessionId);
  const diskIds = collectSessionIds(SESSION_DIR, (id) => id.startsWith(prefix));
  const ids = Array.from(new Set([...diskIds, ...threadIds]));

  let removed = 0;
  let dropped = 0;
  let skipped = 0;
  let fileSkips = 0;
  for (const id of ids) {
    const ran = await tryWithSessionFileLock(
      id,
      async () => {
        const rep = deleteSessionsById(id, SESSION_DIR);
        removed += rep.removed;
        fileSkips += rep.skipped;
        if (rep.skipped === 0) await removeThread(id);
      },
      { waitMs: CLEANUP_LOCK_WAIT_MS },
    );
    if (ran) dropped++;
    else skipped++;
  }

  const skippedNote = skipped > 0 ? `, skipped ${skipped} active` : "";
  const fileSkipNote = fileSkips > 0 ? `, ${fileSkips} file(s) skipped` : "";
  ctx.ui.notify(
    `Cleared ${removed} session file(s) and ${dropped} thread record(s) for "${name}"${skippedNote}${fileSkipNote}`,
    "info",
  );
}
