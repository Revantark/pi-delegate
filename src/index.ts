import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleDelegateCommand } from "./commands/index.js";
import { executeDelegateTool, delegateParamsSchema } from "./tool.js";
import type { AutocompleteItem } from "./types.js";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("delegate", {
    description: "Manage delegate agents (add, remove, list, edit)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
      const options = [
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
      return options
        .filter((o) => o.startsWith(prefix))
        .map((o) => ({ value: o, label: o }));
    },
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
