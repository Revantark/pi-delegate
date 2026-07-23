import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionContext,
  type AgentToolResult,
  type AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { randomUUID } from "node:crypto";
import {
  getAgent,
  listAgents,
  loadThreads,
  upsertThread,
  withRegistryLock,
} from "./agents.js";
import { sanitizeThreadId, sanitizeAgentName } from "./sanitize.js";
import {
  formatUsageStats,
  getFinalOutput,
  isFailedResult,
  getResultOutput,
} from "./format.js";
import { withSessionFileLock } from "./locks.js";
import { runDelegate } from "./runner.js";
import { SESSION_DIR } from "./paths.js";
import type { DelegateToolDetails, UsageStats } from "./types.js";

export const delegateParamsSchema = Type.Object({
  agent: Type.String({
    description: "Name of the registered agent to invoke",
  }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  threadId: Type.Optional(
    Type.String({
      description:
        "Conversation thread id. Reuse the same value across follow-up calls so the sub-agent keeps memory. Omit to start a fresh parallel thread (unless the agent is configured with defaultThread: \"shared\"). Calls on the same thread are serialized; calls on different threads run in parallel.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        "Maximum child runtime in milliseconds for this call. Overrides the agent's configured timeout. Choose based on expected task duration (e.g. 120000 for quick lookups, 2400000 for long research tasks).",
    }),
  ),
});

export type DelegateParams = Static<typeof delegateParamsSchema>;

const zeroUsage = (): UsageStats => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
});

export async function executeDelegateTool(
  _toolCallId: string,
  params: DelegateParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<DelegateToolDetails> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<DelegateToolDetails>> {
  const { agent: agentName, task, threadId, timeoutMs: timeoutParam } = params;

  const agent = getAgent(agentName);
  if (!agent) {
    const available = listAgents()
      .map((a) => `"${a.name}"`)
      .join(", ");
    throw new Error(
      `Unknown agent: "${agentName}". Available agents: ${available || "none"}.`,
    );
  }

  // Per-call timeout: explicit param wins over the agent's configured
  // timeout. Clamped to a hard 2h ceiling.
  const MAX_TIMEOUT_MS = 7_200_000;
  const effectiveTimeoutMs =
    timeoutParam !== undefined && Number.isFinite(timeoutParam)
      ? Math.min(Math.max(1, Math.floor(timeoutParam)), MAX_TIMEOUT_MS)
      : agent.timeoutMs;
  const effectiveAgent: typeof agent =
    effectiveTimeoutMs !== agent.timeoutMs
      ? { ...agent, timeoutMs: effectiveTimeoutMs }
      : agent;

  const sessionEnabled = agent.session !== false;
  // No explicit threadId: "shared" keeps the legacy per-agent default thread
  // (calls serialize on one session); default "unique" gives every call its
  // own session so parallel delegate calls never contend on the session lock.
  const effectiveThreadId =
    sessionEnabled && threadId && threadId.trim()
      ? sanitizeThreadId(threadId)
      : agent.defaultThread === "shared"
        ? agent.name
        : `${agent.name}-${randomUUID().slice(0, 8)}`;
  const safeAgent = sanitizeAgentName(agent.name);
  const sessionId = sessionEnabled
    ? `delegate-${safeAgent}-${effectiveThreadId}`
    : null;

  const baseDetails: DelegateToolDetails = {
    agent: agent.name,
    model: agent.model,
    task,
    exitCode: 0,
    usage: zeroUsage(),
    threadId: sessionId ? effectiveThreadId : null,
    sessionId,
  };

  onUpdate?.({
    content: [
      {
        type: "text",
        text: `Delegating to ${agentName} (${agent.model})${
          sessionId ? ` [thread: ${effectiveThreadId}]` : " [ephemeral]"
        }...`,
      },
    ],
    details: baseDetails,
  });

  const run = () =>
    runDelegate(
      ctx.cwd,
      effectiveAgent,
      task,
      sessionId,
      signal,
      onUpdate
        ? (partial) => {
            const text =
              partial.liveLog ||
              getFinalOutput(partial.messages) ||
              "(running...)";
            onUpdate({
              content: [{ type: "text", text }],
              details: {
                agent: partial.agent,
                model: partial.model,
                task: partial.task,
                exitCode: partial.exitCode,
                stopReason: partial.stopReason,
                errorMessage: partial.errorMessage,
                usage: partial.usage,
                threadId: sessionId ? effectiveThreadId : null,
                sessionId,
              },
            });
          }
        : undefined,
    );
  // Lock wait budget: no point outliving our own runtime deadline. Calls on
  // the same thread still serialize (they share a session file), but a waiter
  // now survives a long-running holder instead of dying after 10s, and Esc
  // aborts the wait immediately.
  const result = sessionId
    ? await withSessionFileLock(sessionId, run, {
        waitMs: effectiveTimeoutMs ?? 600_000,
        signal,
      })
    : await run();

  if (isFailedResult(result)) {
    const errorMsg = getResultOutput(result);
    throw new Error(`Agent ${result.stopReason || "failed"}: ${errorMsg}`);
  }

  // Read-modify-write of the threads registry, serialized in-process so
  // parallel delegate completions cannot clobber each other's records.
  if (sessionId) {
    await withRegistryLock(async () => {
      const threads = await loadThreads();
      const now = new Date().toISOString();
      const existing = threads[sessionId];
      await upsertThread({
        agent: agent.name,
        threadId: effectiveThreadId,
        sessionId,
        sessionDir: SESSION_DIR,
        created: existing?.created ?? now,
        lastUsed: now,
        userThreadId: threadId && threadId.trim() ? threadId.trim() : undefined,
      });
    });
  }

  const answer = getFinalOutput(result.messages) || "(no output)";
  const truncated = truncateHead(answer, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  let display = truncated.content;
  if (truncated.truncated) {
    if (sessionId && result.fullOutputPath) {
      display += `\n[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines. ` +
        `Full output remains in the delegated session transcript: ${result.fullOutputPath}]`;
    } else if (result.fullOutputPath) {
      display += `\n[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines. ` +
        `Full output written to: ${result.fullOutputPath}]`;
    } else if (sessionId) {
      display += `\n[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines. ` +
        `Full output remains in the delegated session transcript.]`;
    } else {
      display += `\n[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines. ` +
        `Full output written to: ${result.fullOutputPath ?? "temporary storage"}]`;
    }
  }

  const usageLine = `\n\n[usage: ${formatUsageStats(result.usage, result.model)}]`;

  const content = sessionId
    ? `${display}${usageLine}\n\n[delegate thread: ${effectiveThreadId}]\n` +
      `Reuse this value as the "threadId" parameter on your next delegate ` +
      `call to continue this conversation.`
    : `${display}${usageLine}${result.fullOutputPath ? `\n\n[full output: ${result.fullOutputPath}]` : ""}`;

  return {
    content: [{ type: "text", text: content }],
    details: {
      agent: result.agent,
      model: result.model,
      task: result.task,
      exitCode: result.exitCode,
      stopReason: result.stopReason,
      errorMessage: result.errorMessage,
      usage: result.usage,
      threadId: sessionId ? effectiveThreadId : null,
      sessionId,
      outputTruncated: truncated.truncated,
      messagesTruncated: result.messagesTruncated,
      stderrTruncated: result.stderrTruncated,
      fullOutputPath: result.fullOutputPath,
    },
  };
}
