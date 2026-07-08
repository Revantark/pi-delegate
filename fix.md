# pi-delegate — Fix Plan

## Context

Target: `/Users/rev/.pi/agent/extensions/delegate/` (`index.ts` ~830 lines, `agents.ts` ~120 lines, `package.json`).

Goal: reduce token leaks, fix correctness bugs, improve structure. **Refactor only.** Do NOT change behaviour the user likes (sync factory, `--no-extensions` auto-forced when explicit extensions set, `withSessionLock`, `sanitizeThreadId`, signal handling, `spawn` array-args).

Severity legend: **[P0]** token leak / deadlock / data loss. **[P1]** bug. **[P2]** structure / type safety. **[P3]** manifest / polish.

---

## P0-1: Unbounded tool result — token leak into parent context

**Where:** `executeDelegateTool`, line near `const answer = getFinalOutput(result.messages) || "(no output)";`

**Why:** Sub-agent answer flows back into the parent agent's context with NO size cap. A 100KB research dump = 100KB of parent context. Best practice (`@earendil-works/pi-coding-agent` docs) requires `truncateHead`/`truncateTail` with `DEFAULT_MAX_BYTES` (50KB) / `DEFAULT_MAX_LINES` (2000). This is the single biggest leak.

**Fix:**
1. Import from `@earendil-works/pi-coding-agent`:
   ```ts
   import { truncateHead, truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
   ```
2. Wrap `answer` before composing `content`:
   ```ts
   const truncated = truncateHead(answer, {
     maxBytes: DEFAULT_MAX_BYTES,
     maxLines: DEFAULT_MAX_LINES,
   });
   let display = truncated.content;
   if (truncated.truncated) {
     display += `\n[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines. Full output saved to: <tmpfile>]`;
   }
   ```
3. Use `truncateTail` instead if you judge the END of the assistant text matters more for delegate (final answer usually does — but keep `truncateHead` as default unless you confirm).

**Acceptance:** Sub-agent returning 200KB text → tool result ≤ 50KB and includes truncation notice.

---

## P0-2: `details` leaks full `messages[]` + `stderr` + `liveLog`

**Where:** `executeDelegateTool`, final `return { content, details: { ...result, threadId, sessionId } }`.

**Why:** `...result` spread copies `messages: Message[]` (every intermediate tool call's full text), `stderr` (could be multi-MB), and `liveLog` (transient streaming string). `details` persists in session entries → loaded again on reload → bloats every subsequent session restore.

**Fix:** Build `details` explicitly, exclude heavy fields:
```ts
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
}
```
Do NOT include `messages`, `stderr`, `liveLog`. Also clear `currentResult.liveLog` at end of `runDelegate` (or never include in result).

**Acceptance:** Session JSONL entries contain only scalar fields; no `messages`/`stderr` keys.

---

## P0-3: `runCommand` pipe deadlock

**Where:** `runCommand(command, args)`, `spawn(command, args, { stdio: "pipe" })`.

**Why:** `stdio: "pipe"` creates pipes for stdout/stderr, but nobody reads them. npm install / git clone write tens of KB → pipe buffer fills → child blocks writing → never finishes. Hangs forever on install/update.

**Fix:** Change to `stdio: "ignore"`. You don't use the output anyway — install is fire-and-forget. Replace the `proc.on("close")`/`proc.on("error")` logic unchanged; just pass `stdio: "ignore"`.

**Acceptance:** `npm install` of a large package completes; no hang.

---

## P0-4: Spawn error swallowed → undebuggable "no output"

**Where:** `runDelegate`, `proc.on("error", () => resolve(1))`.

**Why:** If `pi` binary missing (ENOENT) or spawn fails for any reason, `currentResult.errorMessage` stays empty. Caller throws `Agent failed: (no output)`. User can't tell what went wrong.

**Fix:**
```ts
proc.on("error", (err) => {
  currentResult.errorMessage = err.message;
  resolve(1);
});
```
Same for the buffer-flush line at `proc.on("close")` — preserve last stderr chunk.

**Acceptance:** Missing `pi` binary produces error message like `spawn pi ENOENT` in result.

---

## P1-5: `handleReset` prefix collision

**Where:** `handleReset`, `deleteSessionsByPrefix("delegate-${agent.name}", sessionDir)`.

**Why:** `startsWith("delegate-charlie")` matches `delegate-charlie2-x` too. Resetting agent `charlie` deletes sessions for `charlie2`.

**Fix:** Append trailing dash:
```ts
deleteSessionsByPrefix(`delegate-${agent.name}-`, sessionDir);
```
Update `deleteSessionsByPrefix` callers if any (none currently) to always pass prefix-with-trailing-dash, or rename to clarify it does prefix matching without delimiter awareness.

**Acceptance:** `/delegate reset charlie` does not touch `delegate-charlie2-*` files.

---

## P1-6: `resolveExtensionPath` returns non-existent paths

**Where:** `resolveExtensionPath`, `npm:` and `git:` branches.

**Why:** Returns `delegate` var (constructed path) even when `!fs.existsSync`. Caller `runDelegate` does `if (resolved) args.push("--extension", resolved)` — passes truthy-but-nonexistent path → pi fails to load extension with cryptic error.

**Fix:** Return `null` when the candidate path doesn't exist:
```ts
const npmMatch = ext.match(/^npm:(.+)$/);
if (npmMatch) {
  const delegate = path.join(DELEGATE_EXTS, "npm", "node_modules", name);
  if (fs.existsSync(delegate)) return delegate;
  const global = path.join(home, ".pi", "agent", "npm", "node_modules", name);
  if (fs.existsSync(global)) return global;
  return null;  // was: return delegate
}
```
Same fix for `git:` branch.

**Acceptance:** Nonexistent `npm:foo` ext → `--extension` flag is NOT pushed; warning in log.

---

## P1-7: `installExtensionSource` rejects bare npm names

**Where:** `installExtensionSource`, fall-through `return null`.

**Why:** `resolveExtensionPath` accepts bare names (e.g. `charlie-pkg`), but `installExtensionSource` only handles `npm:` prefix + git-like URL. Inconsistent.

**Fix:** Add a bare-name branch that treats it as npm:
```ts
if (!source.startsWith("npm:") && !source.startsWith("git:") && !source.includes("/") && !source.includes(":")) {
  // treat as npm package name
  const prefix = path.join(DELEGATE_EXTS, "npm");
  if (!fs.existsSync(prefix)) fs.mkdirSync(prefix, { recursive: true });
  await runCommand("npm", ["install", source.trim(), "--prefix", prefix]);
  return path.join(prefix, "node_modules", source.trim());
}
```
Place BEFORE the git fall-through.

**Acceptance:** `/delegate install charlie-pkg --agent foo` installs and resolves.

---

## P1-8: Agent name not sanitized — path traversal

**Where:** `addAgent` (agents.ts), all sites that build `delegate-${agent.name}-...` strings (`runDelegate`, `handleClose`, `handleReset`, `executeDelegateTool`).

**Why:** Agent name flows into `--session-dir` paths and `--session-id`. A name like `../../etc` or `foo:bar` escapes session dir or breaks parsing.

**Fix:**
1. Add `sanitizeAgentName(name)` (mirror of `sanitizeThreadId`):
   ```ts
   const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
   if (!cleaned || cleaned !== name) throw new Error("Invalid agent name");
   return cleaned;
   ```
2. Call at entry of `addAgent` and `handleEdit` (validate before write).
3. Apply at every `delegate-${agent.name}-` construction site.

**Acceptance:** `addAgent("../bad", ...)` throws; normal names pass unchanged.

---

## P1-9: Config-file registry write race

**Where:** `loadAgents`/`saveAgents`/`upsertThread`/`saveThreads` (agents.ts); called from many handlers + `executeDelegateTool`.

**Why:** Read-modify-write with no lock. Two concurrent delegate calls each call `upsertThread` → second clobbers first's write. Same for `addAgent` from `/delegate add` if user types fast.

**Fix:** Two options, pick one:
- **(A)** Reuse existing `withSessionLock`: key on a fixed string like `__config__` and wrap all registry writes. Simple, no new infra.
- **(B)** Use `withFileMutationQueue` from `@earendil-works/pi-coding-agent` if exported (check imports — sugar's list mentions it as standard utility). Cleaner.

Recommendation: (A) — minimal change, consistent with existing pattern. Move `sessionLocks`/`withSessionLock` to a shared `locks.ts` module so both files import it.

**Acceptance:** 10 concurrent `upsertThread` calls → all 10 present in final JSON.

---

## P1-10: `getArgumentCompletions` missing subcommands

**Where:** `index.ts`, command registration block.

**Why:** Missing: `reset`, `threads`, `close`, `prune`. Tab completion doesn't suggest them.

**Fix:** Add to the `options` array:
```ts
const options = [
  "add", "remove", "list", "edit",
  "install", "update", "uninstall",
  "reset", "threads", "close", "prune",
  "help",
];
```

**Acceptance:** Typing `/delegate <tab>` shows all 12 subcommands.

---

## P2-11: Split monolithic `index.ts` into focused modules

**Where:** `index.ts` (830 lines).

**Why:** 12 sections in one file: types, helpers, arg parsing, 12 handlers, runner, tool execute, entry. Hard to navigate, hard to review, hard to test. Best practice (flexdinesh conventions): directory with `index.ts` as entry + sibling modules. You already use this pattern (have `agents.ts`).

**Fix:** Create module skeleton (DO NOT change exports/imports from outside perspective):
```
src/
├── index.ts          # factory only: pi.registerCommand + pi.registerTool
├── types.ts          # AutocompleteItem, UsageStats, DelegateResult
├── paths.ts          # DELEGATE_EXTS, CONFIG_PATH (~/.pi/...), sessionDir, registry paths — centralize ALL ~/.pi/ literals
├── args.ts           # parseArgs, parseAddArgs, parseInstallArgs
├── format.ts         # formatTokens, formatUsageStats (currently dead — see #12)
├── sanitize.ts       # sanitizeThreadId, sanitizeAgentName
├── locks.ts          # sessionLocks, withSessionLock
├── fsutil.ts         # sessionFileMatches, deleteSessions, deleteSessionsById, deleteSessionsByPrefix (fix #5 prefix dash here too)
├── commands/
│   ├── add.ts        # handleAdd
│   ├── remove.ts
│   ├── list.ts
│   ├── edit.ts
│   ├── install.ts    # install/update/uninstall share source normalization
│   ├── sessions.ts   # reset/threads/close/prune
│   └── help.ts
├── runner.ts         # runDelegate + event-line processing
└── tool.ts           # executeDelegateTool + defineTool call
```
Keep the `delegate` extension root file as `index.ts` at package root; have it `export default function(pi)` and `import "./src/..."`. OR move `index.ts` into `src/` and set `package.json` `"main": "src/index.ts"` (and `"pi": { "extensions": ["src/index.ts"] }`).

**Acceptance:** No file >300 lines; each module has single responsibility.

---

## P2-12: Remove dead code OR surface usage stats

**Where:** `formatTokens`, `formatUsageStats` defined but never called.

**Why:** Dead code clutters. But the stats they format ARE computed (`usage.input`, `cost`, `turns`). They're just never shown to the parent agent in `content`.

**Fix (pick one):**
- **(A) Remove** `formatTokens` and `formatUsageStats`. Drop the unused `model` arg in `formatUsageStats`.
- **(B) Use them:** in `executeDelegateTool`, before returning `content`, add a usage footer:
  ```ts
  display += `\n\n[usage: ${formatUsageStats(result.usage, result.model)}]`;
  ```
  **Choose (B)** — usage stats are useful for cost-aware delegation. Apply truncation-aware (truncate USAGE line separately, or accept it as last line that `truncateHead` would drop — consider `truncateTail` then).

**Acceptance:** No dead functions; parent agent sees a usage summary line.

---

## P2-13: Type `ctx` and `onUpdate` properly

**Where:** every `handle*(args, ctx: any)` and `executeDelegateTool(..., ctx: any, onUpdate: any, ...)`.

**Why:** `any` defeats TS checks. Pi exports `ExtensionContext` and tool contexts.

**Fix:** Import:
```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
```
Use `ExtensionContext` for command handlers, and the tool-execute context type (often `ToolContext` or inferred from `defineTool`) for the tool executor. `onUpdate` signature: `(update: { content: Array<{type: "text"; text: string}>; details?: unknown }) => void`.

`signal` is `AbortSignal | undefined` — type explicitly. `params` should be inferred from the `Type.Object` schema via `typeof schema.static` (TypeBox pattern) — check pi docs for the canonical form; if not available, define a local `interface DelegateParams`.

**Acceptance:** No `any` in function signatures; TS compiles clean.

---

## P2-14: Robust arg parsing

**Where:** `parseAddArgs`, `parseInstallArgs` (regex).

**Why:** `--description "a b"` works, but `"a \"b\""` doesn't (no escape). Quoted values with `=` break. Comma-separated `--tools` can't contain commas in tool names. Low priority but readability suffers.

**Fix:** Extract a tiny tokenizer (~30 lines): handles `--flag value`, `--flag="value"`, `--no-flag`, positional args, double + single quotes with backslash escapes. Put in `args.ts`. Use from `parseAddArgs`/`parseInstallArgs`.

**Acceptance:** `--description "say \"hi\""` parses to `say "hi"`.

---

## P2-15: De-duplicate source normalization

**Where:** `resolveExtensionPath`, `installExtensionSource`, `updateExtensionSource` — each repeats the `npm:` / `git:` / URL-prefix detection + `.git` suffix appending + `repoName` basename extraction.

**Why:** Triple-implementation of same logic. Drift inevitable (already drifted: `installExtensionSource` rejects bare names, `resolveExtensionPath` accepts them — see #7).

**Fix:** Extract:
```ts
function normalizeSource(source: string): {
  kind: "npm" | "git";
  name: string;
  repoUrl?: string;
  installDest: string;  // where to clone/install to
}
```
Then `installExtensionSource`/`updateExtensionSource`/`resolveExtensionPath` each become 5–10 lines calling it.

**Acceptance:** Source-format logic exists in exactly one place.

---

## P2-16: `sessionFileMatches` reads whole file

**Where:** `sessionFileMatches` → `fs.readFileSync(full, "utf-8").split("\n")[0]`.

**Why:** Session JSONL can be MB. Reading entire file just to inspect first line is wasteful. `deleteSessions` walks dir + reads EVERY file fully. O(N × filesize) memory.

**Fix:** Read first ~4KB and take first line:
```ts
const fd = fs.openSync(full, "r");
const buf = Buffer.alloc(4096);
const bytes = fs.readSync(fd, buf, 0, 4096, 0);
fs.closeSync(fd);
const firstLine = buf.subarray(0, bytes).toString("utf-8").split("\n")[0];
```
Parse `firstLine` as JSON, check `header.id`.

**Acceptance:** `deleteSessions` on dir with 100 × 1MB session files completes in <1s and uses constant memory.

---

## P3-17: Manifest fields

**Where:** `package.json`.

**Why:** Per flexdinesh conventions + sugar's best-practices list. Currently imports `@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai` without declaring them — works only because pi injects them.

**Fix:**
```json
{
  "name": "pi-delegate",
  "version": "1.0.0",
  "type": "module",
  "main": "index.ts",
  "keywords": ["pi-package", "pi-extension"],
  "pi": {
    "extensions": ["./index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*"
  },
  "dependencies": {
    "@sinclair/typebox": "^0.34.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0"
  }
}
```

**Acceptance:** Auto-discovery still works; standalone install (if ever distributed) resolves.

---

## P3-18: `notify` for multi-line output → `setWidget` or custom entry

**Where:** `handleList`, `handleThreads` — `ctx.ui.notify("...\n...", "info")`.

**Why:** `notify` is designed for short toasts. Multi-line agent registry dump may render poorly or truncate.

**Fix (low priority):** Consider `ctx.ui.setWidget("delegate-list", lines)` for sticky display, or `appendEntry` with custom renderer for a real panel. If too invasive, leave as-is — `notify` does accept multi-line in most modes.

**Acceptance:** Multi-line agent list renders cleanly in TUI + RPC.

---

## Refactor order (recommended)

1. **P0-1, P0-2, P0-3, P0-4** — fixes the leaks + hang. Smallest, highest impact.
2. **P1-5 through P1-10** — bug cluster. Do together (they share file edits).
3. **P2-12** — pick A or B, trivial.
4. **P2-11** — file split. Do BEFORE P2-13/14/15/16 so types move cleanly.
5. **P2-13, P2-14, P2-15, P2-16** — readability pass on the new modules.
6. **P3-17, P3-18** — polish.

After each batch: run `pi -e ./index.ts` smoke test (load + `/delegate list` + one delegation round-trip).

## Out of scope (do NOT change)

- Factory signature `export default function (pi: ExtensionAPI)`.
- `withSessionLock` algorithm (just relocate).
- `--no-extensions` auto-when-explicit logic in `runDelegate`.
- AbortSignal escalation pattern (SIGTERM → 5s → SIGKILL).
- `promptSnippet` + `promptGuidelines` wording (user-tuned).
- Throwing on tool error (current behaviour correct).
- `spawn` with array args (security-correct).

## Decisions for human

- **Q1 (P0-1):** `truncateHead` or `truncateTail` for sub-agent answer? Default to `truncateHead` (sugar's example) unless you confirm end-matters.
- **Q2 (P2-12):** Surface usage stats in content (B) or delete (A)? Recommend B.
- **Q3 (P2-11):** Keep `index.ts` at package root with thin re-export, or move everything to `src/`? Recommend `src/` layout.
- **Q4 (P1-9):** Option A (extend `withSessionLock`) or B (`withFileMutationQueue`)? Recommend A unless B is already a standard pi utility you want adopted everywhere.
