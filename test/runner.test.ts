import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDelegate } from "../src/runner.js";
import type { AgentConfig } from "../src/agents.js";

interface FakePiEnv {
  mode?: string;
  exitCode?: number;
  toolSize?: number;
  messageCount?: number;
}

const FAKE_SCRIPT = `#!/usr/bin/env node
const fs = require("fs");
const logFile = process.env.PI_DELEGATE_FAKE_LOG;
if (logFile) fs.appendFileSync(logFile, JSON.stringify(process.argv.slice(2)) + "\\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mode = process.env.PI_DELEGATE_FAKE_MODE || "ok";
const exitCode = Number(process.env.PI_DELEGATE_FAKE_EXITCODE || 0);

async function main() {
  if (mode === "stderr") {
    process.stderr.write("e".repeat(200_000));
  }

  if (mode === "user") {
    console.log(JSON.stringify({ type: "message_end", message: { role: "user", content: "hello", timestamp: 0 } }));
    process.exit(exitCode);
  }

  if (mode === "stream") {
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } }));
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } }));
  }

  if (mode === "bigtool") {
    const size = Number(process.env.PI_DELEGATE_FAKE_TOOLSIZE || 100_000);
    const text = "x".repeat(size);
    console.log(JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text }], timestamp: 1, toolCallId: "tc1" } }));
  }

  if (mode === "many") {
    const count = Number(process.env.PI_DELEGATE_FAKE_MESSAGECOUNT || 1_100);
    for (let i = 0; i < count; i++) {
      console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi " + i }], timestamp: i, responseId: "r" + i } }));
    }
  }

  if (mode === "abort" || mode === "timeout") {
    await sleep(60_000);
  }

  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1, responseId: "r1", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } }, model: "fake-model", stopReason: "stop" } }));
  process.exitCode = exitCode;
}

main();
`;

function makeFakePi(tempDir: string): string {
  const scriptPath = path.join(tempDir, "pi.js");
  fs.writeFileSync(scriptPath, FAKE_SCRIPT, { mode: 0o755 });
  return scriptPath;
}

describe("runner integration", { concurrency: false }, () => {
  function withFakePi<T>(
    env: FakePiEnv,
    fn: (tempDir: string, logFile: string, scriptPath: string) => Promise<T>,
  ): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-"));
    const logFile = path.join(tempDir, "args.log");
    const scriptPath = makeFakePi(tempDir);
    const originalBin = process.env.PI_DELEGATE_TEST_BIN;
    const originalLog = process.env.PI_DELEGATE_FAKE_LOG;
    process.env.PI_DELEGATE_TEST_BIN = scriptPath;
    process.env.PI_DELEGATE_FAKE_LOG = logFile;
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) {
        process.env[`PI_DELEGATE_FAKE_${key.toUpperCase()}`] = String(value);
      }
    }
    return fn(tempDir, logFile, scriptPath).finally(() => {
      process.env.PI_DELEGATE_TEST_BIN = originalBin;
      process.env.PI_DELEGATE_FAKE_LOG = originalLog;
      for (const key of Object.keys(env)) {
        delete process.env[`PI_DELEGATE_FAKE_${key.toUpperCase()}`];
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  }

  function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
      name: "fake",
      model: "fake-model",
      session: false,
      ...overrides,
    } as AgentConfig;
  }

  test("child arguments contain --no-extensions", async () => {
    await withFakePi({}, async (_tempDir, logFile) => {
      await runDelegate(os.tmpdir(), baseAgent(), "hello", null, undefined, undefined);
      const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
      const args = JSON.parse(lines[lines.length - 1]);
      assert.ok(args.includes("--no-extensions"));
    });
  });

  test("explicit extensions are passed", async () => {
    await withFakePi({}, async (tempDir, logFile) => {
      const extDir = path.join(tempDir, "ext");
      fs.mkdirSync(extDir);
      await runDelegate(
        os.tmpdir(),
        baseAgent({ extensions: [extDir] }),
        "hello",
        null,
        undefined,
        undefined,
      );
      const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
      const args = JSON.parse(lines[lines.length - 1]);
      const idx = args.indexOf("--extension");
      assert.ok(idx !== -1);
      assert.equal(args[idx + 1], extDir);
    });
  });

  test("missing extension fails before spawn", async () => {
    await assert.rejects(async () => {
      await runDelegate(
        os.tmpdir(),
        baseAgent({ extensions: ["/no/such/extension/path"] }),
        "hello",
        null,
        undefined,
        undefined,
      );
    }, /was not found/);
  });

  test("user message does not crash truncateToolResult", async () => {
    await withFakePi({ mode: "user" }, async () => {
      const result = await runDelegate(os.tmpdir(), baseAgent(), "hello", null, undefined, undefined);
      const user = result.messages.find((m) => m.role === "user");
      assert.ok(user);
    });
  });

  test("assistant text stream is parsed", async () => {
    await withFakePi({ mode: "stream" }, async () => {
      const result = await runDelegate(os.tmpdir(), baseAgent(), "hello", null, undefined, undefined);
      const text = result.messages
        .filter((m) => m.role === "assistant")
        .map((m) => (m as any).content?.map((c: any) => c.text).join(""))
        .join("");
      assert.ok(text.includes("done"));
    });
  });

  test("final text is returned", async () => {
    await withFakePi({}, async () => {
      const result = await runDelegate(os.tmpdir(), baseAgent(), "hello", null, undefined, undefined);
      const assistant = result.messages.find((m) => m.role === "assistant");
      assert.ok(assistant);
      assert.ok((assistant as any).content?.some((c: any) => c.type === "text" && c.text === "done"));
    });
  });

  test("tool result is truncated safely", async () => {
    await withFakePi({ mode: "bigtool", toolSize: 200_000 }, async () => {
      const result = await runDelegate(os.tmpdir(), baseAgent(), "hello", null, undefined, undefined);
      const tool = result.messages.find((m) => m.role === "toolResult");
      assert.ok(tool);
      const text = (tool as any).content?.find((c: any) => c.type === "text")?.text ?? "";
      assert.ok(text.length < 200_000);
      assert.ok(text.includes("truncated"));
    });
  });

  test("stderr is capped", async () => {
    await withFakePi({ mode: "stderr" }, async () => {
      const result = await runDelegate(os.tmpdir(), baseAgent(), "hello", null, undefined, undefined);
      assert.ok(result.stderr.length < 200_000);
      assert.ok(result.stderrTruncated);
    });
  });

  test("message count is capped", async () => {
    await withFakePi({ mode: "many", messageCount: 1_100 }, async () => {
      const result = await runDelegate(os.tmpdir(), baseAgent(), "hello", null, undefined, undefined);
      assert.ok(result.messages.length <= 1_000);
      assert.ok(result.messagesTruncated);
    });
  });

  test("nonzero exit returns failure", async () => {
    await withFakePi({ exitCode: 7 }, async () => {
      const result = await runDelegate(os.tmpdir(), baseAgent(), "hello", null, undefined, undefined);
      assert.equal(result.exitCode, 7);
    });
  });

  test("abort terminates child", async () => {
    await withFakePi({ mode: "abort" }, async () => {
      const controller = new AbortController();
      const promise = runDelegate(os.tmpdir(), baseAgent(), "hello", null, controller.signal, undefined);
      setTimeout(() => controller.abort(), 100);
      await assert.rejects(promise, /aborted/i);
    });
  });

  test("timeout terminates child", async () => {
    await withFakePi({ mode: "timeout" }, async () => {
      await assert.rejects(
        async () => {
          await runDelegate(os.tmpdir(), baseAgent({ timeoutMs: 10 }), "hello", null, undefined, undefined);
        },
        /timed out/i,
      );
    });
  });

  test("process invocation works under fake runtime", async () => {
    await withFakePi({}, async () => {
      const result = await runDelegate(os.tmpdir(), baseAgent(), "hello", null, undefined, undefined);
      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "fake-model");
      assert.equal(result.stopReason, "stop");
      assert.ok(result.fullOutputPath);
    });
  });
});
