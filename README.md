# pi-delegate

Hand tasks from your main Pi session to **registered sub-agents** that run in
isolation on different models, with their own tools, extensions, and context
window. Each delegation spawns a fresh `pi --mode json` subprocess and returns
only the sub-agent's final answer plus usage stats — keeping your main context
lean.

The extension adds:

- a **`/delegate`** slash command (manage agents, sessions, threads)
- a **`delegate`** tool (the LLM calls this to actually offload work)

---

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Concepts](#concepts)
- [Configuring Agents](#configuring-agents)
- [Command Reference](#command-reference)
- [The `delegate` Tool](#the-delegate-tool)
- [Sessions & Threads](#sessions--threads)
- [Isolation & Safety](#isolation--safety)
- [State Files](#state-files)
- [Example Prompts](#example-prompts)
- [Tips & Gotchas](#tips--gotchas)

---

## Install

```bash
# install from git
pi install git:github.com/Revantark/pi-delegate

# pin a tag/commit
pi install git:github.com/Revantark/pi-delegate@v1.0.0

# local checkout (dev)
pi install /path/to/pi-delegate

# one-shot without writing settings
pi -e git:github.com/Revantark/pi-delegate
```

No build step — Pi loads `index.ts` directly. Peer deps (provided by Pi):
`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`.

---

## Quick Start

```text
# 1. Register a sub-agent
/delegate add researcher --model sonnet --description "Deep research, web + docs"

# 2. Check it
/delegate list

# 3. Use it — just talk to your main agent
"Have researcher summarize the pi extension docs and list the public APIs."

#    ...or call the tool directly in a prompt:
"delegate to researcher: compare the runner.ts and tool.ts designs"
```

The main agent sees the `delegate` tool (with guidance) and will invoke it
automatically when you say "ask X", "have X do Y", or delegate explicitly.

---

## Concepts

| Term | Meaning |
|------|---------|
| **Agent** | A named, registered sub-agent config (model + tool/extension limits). Lives in `~/.pi/delegate-agents.json`. |
| **Delegation** | One `delegate` tool call → one spawned `pi` subprocess → one answer. |
| **Session / Thread** | When `session` is on (default), repeats of the same `threadId` share memory across calls. |
| **Ephemeral** | When `session: false` (`--no-session`), each call is stateless — no memory, no stored transcripts. |

---

## Configuring Agents

### `add`

```text
/delegate add <name> --model <model> \
  [--tools t1,t2] [--extensions e1,e2] \
  [--no-extensions] [--no-session] [--description "desc"]
```

| Flag | Effect |
|------|--------|
| `--model <m>` | **Required.** Model the sub-agent runs on. |
| `--tools t1,t2` | Tool allowlist. Omit = all tools available to child. |
| `--extensions e1,e2` | Extra extension paths to load in the child. |
| `--no-extensions` | Disable auto-loaded extensions (`--no-extensions` in child). |
| `--no-session` | `session: false` → ephemeral, no memory/transcripts. |
| `--description "d"` | Human note; also shown in `/delegate list`. |

Agent names must match `^[a-zA-Z0-9_-]{1,64}$` (validated on add/edit).

### `edit`

```text
/delegate edit <name>
```

Opens a JSON editor pre-filled with the agent config. You can rename
(changes key), change model, tools, extensions, session flag, description.
Invalid JSON cancels; missing `name`/`model` is rejected.

### Other config commands

```text
/delegate remove <name>        # unregister agent (preserves transcripts)
/delegate list                 # show all agents + limits
/delegate install <src> --agent <name> [--no-extensions]
/delegate update  <src> --agent <name>
/delegate uninstall <src> --agent <name>
```

`install` clones/installs an extension source into `~/.pi/delegate-exts` and
appends it to the agent's `extensions` list. `update` re-pulls; `uninstall`
removes it from the list.

> **Install confirmation (issue 22):** installing an extension is a high-impact
> operation — npm packages can run lifecycle scripts and git repos contain
> arbitrary TypeScript that executes inside delegated children. In interactive
> (TUI/RPC) mode `install` shows a confirmation dialog naming the source and
destination; pass `--yes` to install non-interactively. In non-interactive
> (JSON/print) mode `install` refuses without `--yes`.
>
> **Missing extensions fail (issue 23):** if a configured extension can't be
> resolved on disk, delegation throws instead of silently running without it.

---

## Command Reference

| Subcommand | Usage | What it does |
|------------|-------|--------------|
| `add` | `add <name> --model <m> [flags]` | Register an agent. |
| `remove` | `remove <name>` `[--purge]` | Unregister agent. Default keeps thread transcripts; `--purge` (with confirmation) deletes session files + thread records too. |
| `list` | `list` | Show registered agents. |
| `edit` | `edit <name>` | Edit config in JSON editor. |
| `install` | `install <source> --agent <name> [--no-extensions] [--yes]` | Install extension source for an agent. |
| `update` | `update <source> --agent <name>` | Update installed extension source. |
| `uninstall` | `uninstall <source> --agent <name>` | Detach extension source. |
| `reset` | `reset <name>` | Wipe **session files + thread records** for an agent (keeps the registration). |
| `threads` | `threads [agent]` | List active threads (optionally filtered). |
| `close` | `close <agent> <thread>` | Close one thread (deletes its transcripts + record). |
| `prune` | `prune [--older <days>\|--all]` | Delete old/all threads. Default: older than 7 days. |
| `help` | `help` | Print usage text. |

> **`reset` vs `remove`**: `remove` unregisters the agent but keeps its transcripts by
> default; `remove --purge` deletes the agent and its data. `reset` keeps the agent
> registration and only wipes memory/transcripts. Use `reset` to give an agent a
> clean slate without re-registering it.

---

## The `delegate` Tool

The LLM calls this — not you (though you can prompt it to). Schema:

```ts
delegate({
  agent:   string,             // required — registered agent name
  task:    string,             // required — what to delegate
  threadId?: string,           // optional — reuse to keep memory
})
```

Behavior:

- Unknown `agent` → throws an error **listing available agents**, so the model
  self-corrects on retry.
- Output is truncated to safe byte/line limits and ends with a usage summary
  and, for stateful agents, the `threadId` to reuse.
- A `threadId` is returned so follow-ups continue the same conversation.

---

## Sessions & Threads

- **Stateful (default):** omit `threadId` → a default per-agent thread is used
  (`delegate-<agent>-<name>`). Pass your own `threadId` to branch or label a
  conversation.
- **Memory:** reuse the same `threadId` across calls → the sub-agent remembers
  prior context.
- **Ephemeral:** agent registered with `--no-session` → `threadId` is ignored,
  nothing is stored.
- **Manage:**
  - `/delegate threads [agent]` — what's alive.
  - `/delegate close <agent> <thread>` — kill one thread.
  - `/delegate prune --older 14` or `prune --all` — bulk cleanup.
  - `/delegate reset <name>` — nuke all of an agent's threads at once.

---

## Isolation & Safety

Each child gets its **own** `--model`, a `--tools` allowlist, and an explicit
`--no-extensions` / `--extension` set. That means:

- Delegated agents **cannot** re-invoke `delegate` (the tool isn't in their
  toolset) — no infinite delegation loops.
- `--tools` / `--no-extensions` is the real boundary; prompt text is also
  sanitized (tool names stripped) as defense-in-depth.
- An `AbortSignal` tree-kills the child process if the call is cancelled.
- A per-`sessionId` lock serializes writes so concurrent delegations don't
  clobber state.

---

## State Files

All under `~/.pi/` (Pi's config directory — see `State Files` for redirects):

| Path | Purpose |
|------|---------|
| `delegate-agents.json` | Agent registry (name, model, tools, extensions, session, description). |
| `delegate-threads.json` | Active threads: `{ sessionId: { agent, threadId, created, lastUsed, ... } }`. |
| `delegate-sessions/` | Child session transcripts. |
| `delegate-exts/` | Installed extension sources for agents. |

> **Configurable root:** all paths are derived from Pi's config directory name
> (`CONFIG_DIR_NAME`, default `.pi`) rather than hardcoded. Set `PI_DELEGATE_HOME`
> to relocate the entire delegate state tree (agents, threads, sessions,
> extensions) for rebranded/custom deployments or tests.

---

## Example Prompts

These are things you can say to your **main** agent. The model routes them to
the `delegate` tool on its own.

**Offload a one-off task**
> "Ask researcher to summarize the pi extension docs and list the public APIs."

**Keep context across a series**
> "Delegate to coder using threadId `refactor-auth`: first, find every place we
> call the login endpoint. Then in a follow-up I'll have you rewrite them."

**Cheap model for grunt work**
> "Have the mini agent (haiku) rename all `fooBar` identifiers to `foo_bar`
> across src/ and report the diff."

**Specialized toolset**
> "Use the image-bot agent to generate a diagram of our deploy pipeline from
> this description: …"

**Cleanup**
> "Run /delegate prune --older 30 to drop stale threads, then /delegate list."

---

## Tips & Gotchas

- **Agents aren't auto-discovered.** The LLM only knows agent names after it
  (or you) runs `/delegate list`. If it guesses a wrong name, the error message
  lists the valid ones and it retries.
- **`remove`** unregisters an agent. By default it preserves existing thread
  transcripts (see them via `threads`, delete via `reset`). Pass `--purge` to also
  delete session files and thread records after confirmation. Never purges silently.
- **Ephemeral agents ignore `threadId`.** Don't expect memory from a
  `--no-session` agent.
- **Locks serialize per thread.** Two delegations to the *same* thread run one
  after the other; different threads run in parallel.
- **Output is truncated.** Long answers get a `[Output truncated: …]` note.
  Increase `DEFAULT_MAX_*` in `src/tool.ts` if you need more.
- **Edit after model change?** Run `/delegate reset <name>` so old transcripts
  from the previous model don't leak into new runs.

---

## Source Map

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Registration (command + tool), widget cleanup. |
| `src/commands/*` | Subcommand handlers. |
| `src/tool.ts` | `delegate` tool execution + result formatting. |
| `src/runner.ts` | Spawn child `pi` + parse JSONL stream. |
| `src/agents.ts` | Agent + thread registry (read/write). |
| `src/args.ts` | Argument tokenizer/parser. |
| `src/sanitize.ts` | Agent/thread name sanitization. |
| `src/store.ts` | Atomic file writes. |
| `src/locks.ts` | Per-session write serialization. |
| `src/extensions.ts` | Install/update extension sources. |

See `AGENTS.md` for the developer-oriented overview.
