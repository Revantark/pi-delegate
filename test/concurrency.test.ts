import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Redirect the delegate state tree into a temp dir before importing modules
// that read PI_DELEGATE_HOME at load time (paths.ts reads env once).
const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegate-conc-"));
process.env.PI_DELEGATE_HOME = stateHome;

const { withSessionFileLock, tryWithSessionFileLock } = await import(
  "../src/locks.js"
);
const { withRegistryLock, loadThreads, upsertThread } = await import(
  "../src/agents.js"
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("lock wait honors abort signal instead of waiting for the budget", async () => {
  const ac = new AbortController();
  // Holder keeps the lock for 500ms.
  const holder = withSessionFileLock("abort-target", () => sleep(500));
  // Waiter has a generous budget but an abort signal that fires at 50ms.
  const waiter = withSessionFileLock(
    "abort-target",
    async () => "should never run",
    { waitMs: 30_000, signal: ac.signal },
  );
  setTimeout(() => ac.abort(new Error("user abort")), 50);

  const started = Date.now();
  await assert.rejects(waiter, /user abort/);
  assert.ok(
    Date.now() - started < 400,
    "aborted waiter must return well before the holder finishes",
  );
  await holder;
});

test("already-aborted signal fails acquisition immediately", async () => {
  const ac = new AbortController();
  ac.abort(new Error("pre-aborted"));
  await assert.rejects(
    withSessionFileLock("pre-abort", async () => "nope", {
      signal: ac.signal,
    }),
    /pre-aborted/,
  );
});

test("tryWithSessionFileLock still returns false on lock timeout", async () => {
  const holder = withSessionFileLock("try-target", () => sleep(300));
  const ran = await tryWithSessionFileLock(
    "try-target",
    async () => "nope",
    { waitMs: 50 },
  );
  assert.equal(ran, false);
  await holder;
});

test("withRegistryLock serializes concurrent read-modify-write upserts", async () => {
  const now = new Date().toISOString();
  const makeInfo = (i: number) => ({
    agent: "tester",
    threadId: `thread-${i}`,
    sessionId: `session-${i}`,
    sessionDir: path.join(stateHome, "delegate-sessions"),
    created: now,
    lastUsed: now,
  });

  const N = 10;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      withRegistryLock(async () => {
        // Mirror tool.ts: read existing, then upsert. Without the mutex the
        // interleaved loads could clobber each other's records.
        await loadThreads();
        await upsertThread(makeInfo(i));
      }),
    ),
  );

  const all = await loadThreads();
  for (let i = 0; i < N; i++) {
    assert.ok(
      all[`session-${i}`],
      `expected thread record session-${i} to survive`,
    );
  }
});
