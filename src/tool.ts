import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionContext,
  type AgentToolResult,
  type AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { getAgent, listAgents, loadThreads, upsertThread } from "./agents.js";
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
        "Conversation thread id. Reuse the same value across follow-up calls so the sub-agent keeps memory. Omit for a default per-agent thread.",
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
  const { agent: agentName, task, threadId } = params;

  const agent = getAgent(agentName);
  if (!agent) {
    const available = listAgents()
      .map((a) => `"${a.name}"`)
      .join(", ");
    throw new Error(
      `Unknown agent: "${agentName}". Available agents: ${available || "none"}.`,
    );
  }

  const sessionEnabled = agent.session !== false;
  const effectiveThreadId =
    sessionEnabled && threadId && threadId.trim()
      ? sanitizeThreadId(threadId)
      : agent.name;
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
      agent,
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
  const result = sessionId
    ? await withSessionFileLock(sessionId, run)
    : await run();

  if (isFailedResult(result)) {
    const errorMsg = getResultOutput(result);
    throw new Error(`Agent ${result.stopReason || "failed"}: ${errorMsg}`);
  }

  if (sessionId) {
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
