import { spawn } from "node:child_process";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.js";
import type { DelegateResult } from "./types.js";
import { getFinalOutput, getTextContent } from "./format.js";
import { SESSION_DIR } from "./paths.js";
import { resolveExtensionPath } from "./extensions.js";

function getPiInvocation(
  args: string[],
): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const execName = path.basename(process.execPath).toLowerCase();

  if (/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: "pi", args };
  }
  return { command: process.execPath, args: [currentScript, ...args] };
}

/**
 * Spawn a pi sub-agent process, stream JSON events, return aggregated result.
 */
export async function runDelegate(
  defaultCwd: string,
  agent: AgentConfig,
  task: string,
  sessionId: string | null,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: DelegateResult) => void) | undefined,
): Promise<DelegateResult> {
  const args: string[] = ["--mode", "json", "-p"];

  if (sessionId === null) {
    args.push("--no-session");
  } else {
    args.push("--session-id", sessionId);
    args.push("--session-dir", SESSION_DIR);
    args.push("--name", `delegate:${sessionId}`);
  }
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }
  if (agent.noAutoExtensions) {
    args.push("--no-extensions");
  }
  if (agent.extensions && agent.extensions.length > 0) {
    if (!agent.noAutoExtensions) args.push("--no-extensions");
    for (const ext of agent.extensions) {
      const resolved = resolveExtensionPath(ext);
      if (resolved) args.push("--extension", resolved);
    }
  }
  args.push(`Task: ${task}`);

  const currentResult: DelegateResult = {
    agent: agent.name,
    model: agent.model,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };

  const emitUpdate = () => {
    if (onUpdate) onUpdate({ ...currentResult });
  };

  const exitCode = await new Promise<number>((resolve) => {
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: defaultCwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";

    const updateMain = (line: string) => {
      currentResult.liveLog = line;
      emitUpdate();
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === "tool_execution_start") {
        const name = event.toolName || "?";
        const a = event.args
          ? Object.entries(event.args)
              .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
              .join(", ")
          : "";
        updateMain(`\u25b6 [${name}] ${a}`);
        return;
      }

      if (event.type === "tool_execution_update") {
        const name = event.toolName || "?";
        const text = event.partialResult
          ? typeof event.partialResult === "string"
            ? event.partialResult.slice(0, 200)
            : "(streaming)"
          : event.args
            ? Object.entries(event.args)
                .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
                .join(", ")
            : "";
        updateMain(`\u2026 [${name}] ${text}`);
        return;
      }

      if (event.type === "tool_execution_end") {
        const name = event.toolName || "?";
        const err = event.isError ? " [ERROR]" : "";
        updateMain(`\u2713 [${name}] done${err}`);
        return;
      }

      if (event.type === "message_start" && event.message) {
        if (event.message.role === "assistant") {
          updateMain("\u{1f4ac} assistant thinking\u2026");
        }
        return;
      }

      if (event.type === "message_update") {
        let text = "";
        if (event.delta?.text) text = event.delta.text;
        else if (event.delta?.content?.[0]?.text)
          text = event.delta.content[0].text;
        else if (event.message?.content) {
          const parts = event.message.content as Array<{ type: string; text?: string }>;
          text = parts
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("");
        }
        if (text) updateMain(`\u{1f4ac} ${text.slice(-400)}`);
        return;
      }

      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        currentResult.messages.push(msg);

        if (msg.role === "assistant") {
          currentResult.usage.turns++;
          const usage = msg.usage;
          if (usage) {
            currentResult.usage.input += usage.input || 0;
            currentResult.usage.output += usage.output || 0;
            currentResult.usage.cacheRead += usage.cacheRead || 0;
            currentResult.usage.cacheWrite += usage.cacheWrite || 0;
            currentResult.usage.cost += usage.cost?.total || 0;
            currentResult.usage.contextTokens = usage.totalTokens || 0;
          }
          if (!currentResult.model && msg.model) currentResult.model = msg.model;
          if (msg.stopReason) currentResult.stopReason = msg.stopReason;
          if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;

          const finalText = getFinalOutput(currentResult.messages);
          if (finalText) updateMain(`\u{1f4ac} ${finalText}`);
        }
        emitUpdate();
        return;
      }

      if (event.type === "tool_result_end" && event.message) {
        const msg = event.message as Message;
        currentResult.messages.push(msg);
        const text = getTextContent(msg);
        if (text) {
          const toolName = (msg as any).toolName || "?";
          updateMain(`\u{1f4c4} [${toolName}] ${text.slice(0, 300)}`);
        }
        emitUpdate();
        return;
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      currentResult.stderr += data.toString();
    });

    proc.on("close", (code: number | null) => {
      if (buffer.trim()) processLine(buffer);
      resolve(code ?? 0);
    });

    proc.on("error", (err: Error) => {
      currentResult.errorMessage = err.message;
      resolve(1);
    });

    if (signal) {
      const killProc = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }
  });

  currentResult.exitCode = exitCode;
  delete currentResult.liveLog;

  if (currentResult.stopReason === "aborted") {
    throw new Error("Delegate was aborted");
  }

  return currentResult;
}