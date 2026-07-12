import { spawn as spawnChild } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { existsSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.js";
import type { DelegateResult } from "./types.js";
import { getFinalOutput, getTextContent } from "./format.js";
import { SESSION_DIR, PI_HOME } from "./paths.js";
import { resolveExtensionPath } from "./extensions.js";
import { isSymlink, ensureSafeDir, isContained, safeRealpath } from "./store.js";

/** Streaming memory caps (issue 13): prevent a verbose child from exhausting
 *  the parent's memory before final-output truncation runs. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024; // incomplete stdout line
const MAX_STDERR_BYTES = 64 * 1024; // child stderr
const MAX_MESSAGES = 1000; // retained messages
const MAX_TOOL_RESULT_CHARS = 50_000; // per tool-result text block

/** Append `next` to `current`, capping the combined string to `max` UTF-8 bytes. */
function appendCapped(
  current: string,
  next: string,
  max: number,
): { value: string; truncated: boolean } {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= max) {
    return { value: combined, truncated: false };
  }
  return { value: combined.slice(-max), truncated: true };
}

/** Truncate oversized tool-result text so retained messages stay bounded. */
function truncateToolResult(msg: Message): Message {
  if (msg.role !== "toolResult" || !Array.isArray(msg.content)) return msg;

  const tooBig = msg.content.some(
    (content) =>
      content.type === "text" && content.text.length > MAX_TOOL_RESULT_CHARS,
  );
  if (!tooBig) return msg;

  return {
    ...msg,
    content: msg.content.map((content) =>
      content.type === "text" && content.text.length > MAX_TOOL_RESULT_CHARS
        ? {
            ...content,
            text:
              content.text.slice(0, MAX_TOOL_RESULT_CHARS) +
              "...(content truncated)",
          }
        : content,
    ),
  };
}

/** Push a message, dropping the oldest if over the cap. Returns true if dropped. */
function pushBoundedMessage(messages: Message[], msg: Message): boolean {
  messages.push(msg);
  if (messages.length > MAX_MESSAGES) {
    messages.shift();
    return true;
  }
  return false;
}

/**
 * Stable identity for a message so it is only collected once across the
 * `message_end` and (legacy) `tool_result_end` events. Different event types
 * may finalize the same message; without dedup, content would be doubled.
 */
function messageKey(msg: Message): string {
  if (msg.role === "assistant") {
    return `assistant:${(msg as any).responseId ?? msg.timestamp}`;
  }
  if (msg.role === "toolResult") {
    return `toolResult:${(msg as any).toolCallId}:${msg.timestamp}`;
  }
  return `user:${msg.timestamp}`;
}

/** Write a file atomically in a fresh temp directory and restrict mode. */
function writeEphemeralFullOutput(output: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegate-"));
  fs.chmodSync(dir, 0o700);
  const filePath = path.join(dir, "output.txt");
  fs.writeFileSync(filePath, output, { mode: 0o600 });
  return filePath;
}

/** On Windows, terminate the process tree via taskkill (no shell). */
function terminateProcessTree(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const proc = spawnChild("taskkill", args, { detached: true });
    proc.on("error", () => resolve());
    proc.on("close", () => resolve());
  });
}

function getPiInvocation(
  args: string[],
): { command: string; args: string[] } {
  const testBin = process.env.PI_DELEGATE_TEST_BIN;
  if (testBin) {
    return { command: testBin, args };
  }

  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const genericRuntime = /^(node|bun)(\.exe)?$/.test(execName);

  if (genericRuntime) {
    return { command: "pi", args };
  }

  return { command: process.execPath, args };
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
  if (sessionId !== null) {
    if (isSymlink(SESSION_DIR)) {
      throw new Error(`Refusing to use symlinked session directory: ${SESSION_DIR}`);
    }
    ensureSafeDir(SESSION_DIR, 0o700);
    // Containment: resolved path must stay within the trusted delegate root.
    // Use relative() based containment, not naive prefix matching, so a
    // sibling directory (e.g. /Users/revantark2) is not treated as contained.
    // The trusted root is PI_HOME (which honors PI_DELEGATE_HOME), not the
    // user's home, so a redirected state tree still validates correctly.
    const homeReal = safeRealpath(PI_HOME) ?? PI_HOME;
    const resolved = safeRealpath(SESSION_DIR) ?? SESSION_DIR;
    if (!isContained(homeReal, resolved)) {
      throw new Error(`Session directory escapes allowed root: ${resolved}`);
    }
  }
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
  // Child processes must never auto-load extensions — including this delegate
  // extension — otherwise they could recursively delegate (issue 1). Always
  // disable auto-loading, then re-enable only explicitly configured extensions.
  // A configured extension that cannot be resolved is a misconfiguration and
  // must fail loudly, not be silently skipped (issue 23).
  args.push("--no-extensions");
  const loadedExtensions: string[] = [];
  for (const ext of agent.extensions ?? []) {
    const resolved = resolveExtensionPath(ext);
    if (!resolved) {
      throw new Error(
        `Configured extension for agent "${agent.name}" was not found: ${ext}`,
      );
    }
    args.push("--extension", resolved);
    loadedExtensions.push(`${ext} -> ${resolved}`);
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

  // Surface which extensions the child will actually load (issue 23): a
  // configured extension that is missing has already thrown above, so this
  // only lists successfully resolved ones.
  if (loadedExtensions.length > 0) {
    currentResult.liveLog = `🔌 loaded extensions:\n${loadedExtensions.join("\n")}`;
    emitUpdate();
  }

  const exitCode = await new Promise<number>((resolve) => {
    const invocation = getPiInvocation(args);
    const proc = spawnChild(invocation.command, invocation.args, {
      cwd: defaultCwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_DELEGATE_CHILD: "1",
      },
      // Detach on POSIX so the child becomes its own process-group leader.
      // This lets us kill the whole tree (grandchildren) via the group id.
      detached: process.platform !== "win32",
    });

    let buffer = "";
    const seenMessages = new Set<string>();

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
        // Current Pi streams assistant text through `assistantMessageEvent`.
        const streamEvent = event.assistantMessageEvent;
        if (streamEvent?.type === "text_delta" && streamEvent.delta) {
          text = streamEvent.delta;
        } else if (event.delta?.text) {
          text = event.delta.text;
        } else if (event.delta?.content?.[0]?.text) {
          text = event.delta.content[0].text;
        } else if (event.message?.content) {
          const parts = event.message.content as Array<{ type: string; text?: string }>;
          text = parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("");
        }
        if (text) updateMain(`\u{1f4ac} ${text.slice(-400)}`);
        return;
      }

      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        // Avoid collecting the same message twice if both `message_end` and
        // a legacy `tool_result_end` finalize the same message.
        const key = messageKey(msg);
        if (seenMessages.has(key)) return;
        seenMessages.add(key);
        if (pushBoundedMessage(currentResult.messages, truncateToolResult(msg))) {
          currentResult.messagesTruncated = true;
        }

        if (msg.role === "assistant") {
          currentResult.usage.turns++;
          const usage = msg.usage;
          if (usage) {
            currentResult.usage.input += usage.input || 0;
            currentResult.usage.output += usage.output || 0;
            currentResult.usage.cacheRead += usage.cacheRead || 0;
            currentResult.usage.cacheWrite += usage.cacheWrite || 0;
            currentResult.usage.cost += usage.cost?.total || 0;
            // Track peak context size observed across turns (the field name
            // is ambiguous; Math.max keeps the maximum rather than the last).
            currentResult.usage.contextTokens = Math.max(
              currentResult.usage.contextTokens,
              usage.totalTokens ?? 0,
            );
          }
          // Always prefer the resolved model reported by Pi over the
          // requested one (agent.model may be an alias/selector that resolves
          // to a different concrete model). The last assistant message wins.
          if (msg.model) currentResult.model = msg.model;
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
        const key = messageKey(msg);
        if (seenMessages.has(key)) return;
        seenMessages.add(key);
        const bounded = pushBoundedMessage(
          currentResult.messages,
          truncateToolResult(msg),
        );
        if (bounded) currentResult.messagesTruncated = true;
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
      const result = appendCapped(buffer, data.toString(), MAX_BUFFER_BYTES);
      buffer = result.value;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      const result = appendCapped(currentResult.stderr, data.toString(), MAX_STDERR_BYTES);
      currentResult.stderr = result.value;
      if (result.truncated) currentResult.stderrTruncated = true;
    });

    let aborted = false;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    // Send a signal to the child process group (POSIX) so subprocesses
    // started by child tools are also terminated. On Windows, terminate the
    // entire tree with taskkill.
    const sendSignal = (sig: NodeJS.Signals | "force") => {
      if (!proc.pid) return;
      if (process.platform !== "win32") {
        try {
          process.kill(-proc.pid, sig as NodeJS.Signals);
        } catch {
          /* group already gone (ESRCH) */
        }
      } else {
        void terminateProcessTree(proc.pid, sig === "force");
      }
    };

    const abortHandler = () => {
      if (settled) return;
      aborted = true;
      sendSignal("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) sendSignal(process.platform === "win32" ? "force" : "SIGKILL");
      }, 5000);
    };

    // Resolve exactly once, treating abort (Bug D) and signal death (Bug A)
    // as failure rather than success.
    const finish = (code: number | null, signalName: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", abortHandler); // Bug E

      if (timedOut) {
        currentResult.stopReason = "timeout";
        resolve(1);
        return;
      }
      if (aborted) {
        currentResult.stopReason = "aborted";
        resolve(1);
        return;
      }
      if (signalName) {
        currentResult.errorMessage = `Delegate exited due to signal ${signalName}`;
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    };

    proc.once("close", (code: number | null, signalName: NodeJS.Signals | null) => {
      if (buffer.trim()) processLine(buffer);
      finish(code, signalName);
    });

    proc.once("error", (err: Error) => {
      currentResult.errorMessage = err.message;
      finish(1, null);
    });

    if (agent.timeoutMs && agent.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        sendSignal("SIGTERM");
        killTimer = setTimeout(() => {
          if (!settled) sendSignal(process.platform === "win32" ? "force" : "SIGKILL");
        }, 5_000);
      }, agent.timeoutMs);
    }

    if (signal) {
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }
  });

  currentResult.exitCode = exitCode;
  if (sessionId === null) {
    currentResult.fullOutputPath = writeEphemeralFullOutput(
      getFinalOutput(currentResult.messages) || "(no output)",
    );
  }
  delete currentResult.liveLog;

  if (currentResult.stopReason === "aborted") {
    throw new Error("Delegate was aborted");
  }
  if (currentResult.stopReason === "timeout") {
    throw new Error(`Delegate timed out after ${agent.timeoutMs} ms`);
  }

  return currentResult;
}