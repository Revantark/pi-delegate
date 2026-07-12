import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleDelegateCommand } from "./commands/index.js";
import { executeDelegateTool, delegateParamsSchema } from "./tool.js";
import type { AutocompleteItem } from "./types.js";
import { listAgents, loadThreads } from "./agents.js";

const SUBCOMMANDS = [
  "add",
  "remove",
  "list",
  "edit",
  "install",
  "update",
  "uninstall",
  "reset",
  "threads",
  "close",
  "prune",
  "help",
];

async function getDelegateCompletions(prefix: string): Promise<AutocompleteItem[]> {
  const tokens = prefix.trim().split(/\s+/).filter(Boolean);
  const partial = prefix.endsWith(" ") ? "" : tokens.pop() ?? "";
  const subcommand = tokens[0] ?? "";
  const agents = listAgents().map((agent) => agent.name);
  let threadItems: string[] = [];
  try {
    const threads = await loadThreads();
    threadItems = Object.values(threads)
      .filter((thread) => !subcommand || thread.agent === subcommand || subcommand === "close")
      .map((thread) => thread.threadId);
  } catch {
    // Missing or invalid thread state should not break command completion.
  }

  const candidates = !subcommand
    ? SUBCOMMANDS
    : subcommand === "remove" || subcommand === "edit" || subcommand === "reset" || subcommand === "threads"
      ? agents
      : subcommand === "close"
        ? tokens.length >= 2
          ? threadItems
          : agents
        : [];

  const seen = new Set<string>();
  return candidates
    .filter((value) => value.startsWith(partial) && !seen.has(value) && seen.add(value))
    .map((value) => ({ value, label: value }));
}

/** Widgets set by /delegate subcommands that should clear on the next prompt. */
export const DELEGATE_WIDGET_KEYS = [
  "delegate-list",
  "delegate-threads",
  "delegate-help",
] as const;

export default function (pi: ExtensionAPI) {
  // Prevent recursive delegation — child skips registering delegate tool/command.
  if (process.env.PI_DELEGATE_CHILD === "1") {
    return;
  }
  // Clear transient info widgets when the user starts a new turn so they don't
  // stick to the bottom of the TUI forever.
  pi.on("turn_start", (_event, ctx) => {
    for (const key of DELEGATE_WIDGET_KEYS) {
      ctx.ui.setWidget(key, undefined);
    }
  });

  pi.registerCommand("delegate", {
    description: "Manage delegate agents (add, remove, list, edit)",
    getArgumentCompletions: (prefix: string): Promise<AutocompleteItem[]> =>
      getDelegateCompletions(prefix),
    handler: handleDelegateCommand,
  });

  pi.registerTool(
    defineTool({
      name: "delegate",
      label: "Delegate",
      description: [
        "Delegate a task to a registered sub-agent running a different model.",
        "Sub-agent runs in isolation with its own context window and tool restrictions.",
        "Returns the sub-agent's response and usage statistics.",
        "Pass a threadId to retain conversation memory across follow-up calls;",
        "the tool returns the active threadId so you can reuse it.",
      ].join(" "),
      promptSnippet:
        "Delegate tasks to registered agents (charlie, image-bot, researcher, etc.)",
      promptGuidelines: [
        "Use delegate when the user asks to 'ask [agent name]' or 'have [agent name] do something'",
        "delegate runs an isolated agent session and returns the result",
        "Available agents are listed in /delegate list",
        "Use delegate to offload tasks to specialized/cheaper models while keeping main context",
        "For follow-ups, reuse the threadId returned by a previous delegate call so the sub-agent keeps memory",
      ],
      parameters: delegateParamsSchema,
      execute: executeDelegateTool,
    }),
  );
}
