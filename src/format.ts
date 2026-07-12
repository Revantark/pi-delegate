import type { Message } from "@earendil-works/pi-ai";
import type { DelegateResult, UsageStats } from "./types.js";
import type { AgentConfig } from "./agents.js";

export function formatAgentList(agents: AgentConfig[]): string {
  return [
    "Registered agents:",
    ...agents.map((a) => {
      const tools = a.tools ? ` (${a.tools.join(", ")})` : " (all tools)";
      const desc = a.description ? ` - ${a.description}` : "";
      const ext = a.extensions ? ` [ext: ${a.extensions.join(", ")}]` : "";
      const noAuto = a.noAutoExtensions ? " [no-auto-ext]" : "";
      const sess = a.session === false ? " [ephemeral]" : " [session]";
      const timeout = a.timeoutMs ? ` [timeout:${a.timeoutMs}ms]` : "";
      return `\u2022 ${a.name}: ${a.model}${tools}${ext}${noAuto}${sess}${timeout}${desc}`;
    }),
  ].join("\n");
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`\u2191${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`\u2193${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`cr${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`cw${formatTokens(usage.cacheWrite)}`);
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    // Join ALL text blocks of the last assistant message; an assistant
    // message may contain multiple text blocks (the previous code returned
    // the first one and discarded the rest).
    const text = msg.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text) return text;
  }
  return "";
}

export function getTextContent(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  return (msg.content ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export function isFailedResult(result: DelegateResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted"
  );
}

export function getResultOutput(result: DelegateResult): string {
  if (isFailedResult(result)) {
    return (
      result.errorMessage ||
      result.stderr ||
      getFinalOutput(result.messages) ||
      "(no output)"
    );
  }
  return getFinalOutput(result.messages) || "(no output)";
}
