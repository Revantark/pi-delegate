# Delegate Extension

Pi extension that adds a `/delegate` command and a `delegate` tool. Lets the
parent session hand tasks to registered sub-agents running different models with
isolated tools/extensions/context. Each delegation spawns a fresh `pi` subprocess
(`pi --mode json`) and recovers only the final answer + usage from its JSONL
stream.

## Register

`package.json` → `pi.extensions: ["./index.ts"]` (default export calls
`pi.registerCommand` + `pi.registerTool`).

## The `delegate` tool (used by the agent)

Parameters:
- `agent` (string, required) — registered agent name.
- `task` (string, required) — what to delegate.
- `threadId` (string, optional) — reuse to keep sub-agent memory across calls.
  Omit → default per-agent thread.

Returns sub-agent answer + usage stats. Unknown agent → error listing available.

## `/delegate` command

| Subcommand | Usage |
|------------|-------|
| `add` | `add <name> --model <m> [--tools t1,t2] [--extensions e1,e2] [--no-extensions] [--no-session] [--description "d"]` |
| `remove` | `remove <name>` |
| `list` | `list` |
| `edit` | `edit <name>` (opens JSON editor) |
| `install` | `install <source> --agent <name> [--no-extensions]` |
| `update` | `update <source> --agent <name>` |
| `uninstall` | `uninstall <source> --agent <name>` |
| `reset` | `reset <name>` (wipe session files + thread records) |
| `threads` | `threads [agent]` |
| `close` | `close <agent> <thread>` |
| `prune` | `prune [--older <days>\|--all]` (default older 7d) |
| `help` | help text |

## Agent config (`AgentConfig`)

Stored in `~/.pi/delegate-agents.json`:
- `name`, `model` (required)
- `tools?` — tool allowlist
- `extensions?` — extra extension paths
- `noAutoExtensions?` — disable auto-loaded extensions (child runs `--no-extensions`)
- `session?` — false = ephemeral (no thread memory)
- `description?`

## State files (`~/.pi`)

- `delegate-agents.json` — agent registry
- `delegate-threads.json` — `{ sessionId: { agent, threadId, created, lastUsed, ... } }`
- `delegate-sessions/` — child session transcripts

## Isolation model

Child process gets its own `--model`, `--tools` allowlist, and
`--no-extensions`/explicit `--extension` set → delegated agents cannot re-invoke
`delegate`. `--tools`/`--no-extensions` is the real boundary; `sanitize.ts`
strips tool names from the prompt as defense-in-depth. `signal` abort tree-kills
the child. Per-`sessionId` in-process lock serializes writes
(`src/locks.ts`/`src/store.ts`).

## Key source map

- `src/index.ts` — registration (command + tool)
- `src/commands/*` — subcommand handlers
- `src/tool.ts` — `executeDelegateTool`
- `src/runner.ts` — spawn child + parse JSONL
- `src/agents.ts` — agent/thread registry
- `src/args.ts` — arg tokenizer/parser
- `src/sanitize.ts` — name/threadId sanitization
- `src/store.ts` — atomic file writes
- `src/extensions.ts` — install/update extension sources
