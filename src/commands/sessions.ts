import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  getAgent,
  loadThreads,
  saveThreads,
  removeThread,
} from "../agents.js";
import { sanitizeAgentName, sanitizeThreadId } from "../sanitize.js";
import { deleteSessionsById, deleteSessionsByPrefix } from "../fsutil.js";
import { SESSION_DIR } from "../paths.js";

export async function handleThreads(
  agentFilter: string | null,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const threads = loadThreads();
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
    .map((t) => `\u2022 ${t.agent} / ${t.threadId}  (last ${t.lastUsed})`);
  ctx.ui.setWidget("delegate-threads", ["Delegate threads:", ...lines]);
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
  const removed = deleteSessionsById(sessionId, SESSION_DIR);
  await removeThread(sessionId);
  ctx.ui.notify(
    removed > 0
      ? `Closed thread "${thread}" for ${agent} (${removed} file(s) removed)`
      : `No session files found for ${agent}/${thread}`,
    "info",
  );
}

export async function handlePrune(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const all = /(?:^|\s)--all(?:\s|$)/.test(args);
  const olderMatch = args.match(/--older\s+(\d+)/);
  const olderDays = olderMatch ? parseInt(olderMatch[1], 10) : 7;
  const threads = loadThreads();
  const now = Date.now();
  let pruned = 0;
  for (const sid of Object.keys(threads)) {
    const t = threads[sid];
    const ageMs = now - new Date(t.lastUsed).getTime();
    if (all || ageMs > olderDays * 86400000) {
      deleteSessionsById(t.sessionId, t.sessionDir);
      await removeThread(sid);
      pruned++;
    }
  }
  ctx.ui.notify(
    `Pruned ${pruned} thread(s)${all ? " (all)" : ` (unused > ${olderDays}d)`}`,
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
  const removed = deleteSessionsByPrefix(`delegate-${agent.name}-`, SESSION_DIR);
  const threads = loadThreads();
  let dropped = 0;
  for (const sid of Object.keys(threads)) {
    if (threads[sid].agent === agent.name) {
      delete threads[sid];
      dropped++;
    }
  }
  if (dropped) await saveThreads(threads);
  ctx.ui.notify(
    `Cleared ${removed} session file(s) and ${dropped} thread record(s) for "${name}"`,
    "info",
  );
}
