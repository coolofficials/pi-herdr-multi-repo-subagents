import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import childBridge from "../src/child.ts";
import { readJSON, writeJSON, MARKER } from "../src/core.mjs";

async function child(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-child-"));
  const previous = process.env.PI_HERDR_CHILD_DIR;
  process.env.PI_HERDR_CHILD_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_HERDR_CHILD_DIR;
    else process.env.PI_HERDR_CHILD_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const handlers = new Map();
  childBridge({ on: (event, fn) => handlers.set(event, fn) });
  const ctx = {
    cwd: "/repo",
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/sessions/1.jsonl",
    },
  };
  const emit = async (name, event = {}) => handlers.get(name)?.(event, ctx);
  await emit("session_start");
  await writeJSON(path.join(dir, "request.json"), { jobId: "job-1" });
  return { dir, emit, ctx };
}
test("child captures at settled, not agent_end, and retains language from the model", async (t) => {
  const { dir, emit } = await child(t);
  const input = await emit("input", { text: `${MARKER}job-1\nDo work` });
  assert.equal(input.text, "Do work");
  await emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "작업 완료" }],
      stopReason: "stop",
    },
  });
  await emit("agent_end", { messages: [] });
  assert.equal(await readJSON(path.join(dir, "job-1.result.json")), null);
  await emit("agent_before_settle", { outcome: "completed" });
  await emit("agent_settled");
  const report = await readJSON(path.join(dir, "job-1.result.json"));
  assert.equal(report.summary, "작업 완료");
  assert.equal(report.status, "settled");
});
test("provider error reports failure rather than successful completion", async (t) => {
  const { dir, emit } = await child(t);
  await emit("input", { text: `${MARKER}job-1\nWork` });
  await emit("message_end", {
    message: {
      role: "assistant",
      content: [],
      errorMessage: "provider unavailable",
      stopReason: "error",
    },
  });
  await emit("agent_before_settle", { outcome: "error" });
  await emit("agent_settled");
  const report = await readJSON(path.join(dir, "job-1.result.json"));
  assert.equal(report.status, "error");
  assert.equal(report.error, "provider unavailable");
});
test("manual idle turn does not overwrite delegated results, shutdown marks active job aborted", async (t) => {
  const { dir, emit } = await child(t);
  await emit("input", { text: "Manual chat" });
  await emit("agent_settled");
  assert.equal(await readJSON(path.join(dir, "job-1.result.json")), null);
  await emit("input", { text: `${MARKER}job-1\nWork` });
  await emit("session_shutdown");
  assert.equal(
    (await readJSON(path.join(dir, "job-1.result.json"))).status,
    "aborted",
  );
});
test("mismatched task marker cannot produce a report for an unrelated job", async (t) => {
  const { emit } = await child(t);
  await assert.rejects(
    emit("input", { text: `${MARKER}wrong\nWork` }),
    /does not match/,
  );
});
