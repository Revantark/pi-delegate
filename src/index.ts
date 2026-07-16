import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleDelegateCommand } from "./commands/index.js";
import { executeDelegateTool, delegateParamsSchema } from "./tool.js";
import type { AutocompleteItem } from "./types.js";
import { listAgents, loadThreads } from "./agents.js";
import { buildDelegateDescription } from "./format.js";

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
    .map((value) => ({
      value: subcommand ? `${subcommand} ${value}` : value,
      label: value,
    }));
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
      description: buildDelegateDescription(listAgents()),
      promptSnippet:
        "Offload subtasks to specialized sub-agents. The tool description lists available agents and their capabilities.",
      promptGuidelines: [
        "Use delegate proactively: if a task has mixed domains (e.g. code + image), delegate one part to a sub-agent while you handle the other.",
        "The tool description lists available agents and their capabilities. Choose the right agent based on its description.",
        "Delegate to offload heavy or specialized work (research, image gen, web access) to cheaper or more capable models while keeping your context free.",
        "When user says 'ask [agent name]' or 'have [agent name] do something', delegate immediately.",
        "For follow-ups, reuse the threadId returned by a previous call so the sub-agent keeps memory.",
      ],
      parameters: delegateParamsSchema,
      execute: executeDelegateTool,
    }),
  );
}
