import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import childBridge from "../src/child.ts";
import { readJSON, writeJSON, MARKER } from "../src/core.mjs";

import { processIdentity } from "../src/lifecycle.mjs";
async function child(t, options = {}) {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-child-")),
  );
  const handlers = new Map(),
    commands = new Map();
  let tools = ["read", "repo_agent_start"],
    shutdowns = 0;
  const parent = options.parent ?? processIdentity();
  await writeJSON(path.join(dir, "launch.json"), {
    token: "launch",
    cwd: dir,
    parent,
    scope: dir,
    workflowId: "parent",
    expiresAt: Date.now() + 10000,
  });
  await writeJSON(path.join(dir, "parent.json"), {
    instance: parent,
    status: "active",
  });
  childBridge({
    on: (name, fn) => handlers.set(name, fn),
    registerFlag() {},
    getFlag: () =>
      options.noFlag ? undefined : JSON.stringify({ dir, token: "launch" }),
    getActiveTools: () => tools,
    setActiveTools: (v) => {
      tools = v;
    },
    registerCommand: (name, command) => commands.set(name, command),
  });
  const ctx = {
    cwd: dir,
    isIdle: () => true,
    hasPendingMessages: () => false,
    shutdown: () => {
      shutdowns++;
    },
    ui: { notify() {}, setStatus() {} },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/sessions/1.jsonl",
    },
  };
  const emit = async (name, event = {}) => handlers.get(name)?.(event, ctx);
  t.after(async () => {
    await emit("session_shutdown", { reason: "reload" });
    await fs.rm(dir, { recursive: true, force: true });
  });
  await emit("session_start");
  await writeJSON(path.join(dir, "request.json"), {
    jobId: "job-1",
    owner: "parent",
  });
  return { dir, emit, ctx, commands, shutdowns: () => shutdowns };
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
  await emit("session_shutdown", { reason: "quit" });
  assert.equal(
    (await readJSON(path.join(dir, "job-1.result.json"))).status,
    "aborted",
  );
});
test("mismatched task marker cannot produce a report for an unrelated job", async (t) => {
  const { emit } = await child(t);
  assert.equal(
    (await emit("input", { text: `${MARKER}wrong\nWork` })).action,
    "handled",
  );
});

test("idle child exits on confirmed parent death; ordinary Pi does not become child", async (t) => {
  const f = await child(t, {
    parent: { ...processIdentity(), started: "old process" },
  });
  await f.emit("agent_settled");
  assert.equal(f.shutdowns(), 1);
  const ordinary = await child(t, { noFlag: true });
  assert.equal(await readJSON(path.join(ordinary.dir, "ready.json")), null);
});
test("busy child saves report before parent-exit shutdown and refuses new requests", async (t) => {
  const f = await child(t);
  await f.emit("input", { text: `${MARKER}job-1\nWork` });
  await writeJSON(path.join(f.dir, "parent.json"), {
    instance: processIdentity(),
    status: "released",
    reason: "quit",
  });
  assert.equal((await f.emit("input", { text: "new work" })).action, "handled");
  assert.equal(f.shutdowns(), 0);
  await f.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "finished" }],
    },
  });
  await f.emit("agent_settled");
  assert.equal(f.shutdowns(), 1);
  assert.equal(
    (await readJSON(path.join(f.dir, "job-1.result.json"))).summary,
    "finished",
  );
});
test("unknown parent is retained; reload does not abort job; detach rejects delegation", async (t) => {
  const f = await child(t, {
    parent: { ...processIdentity(), host: "unobservable-host" },
  });
  await f.emit("input", { text: `${MARKER}job-1\nWork` });
  await f.emit("session_shutdown", { reason: "reload" });
  assert.equal(await readJSON(path.join(f.dir, "job-1.result.json")), null);
  await f.emit("agent_settled");
  assert.equal(f.shutdowns(), 0);
  await f.commands.get("repo-agent-detach").handler("", f.ctx);
  assert.equal((await readJSON(path.join(f.dir, "ready.json"))).managed, false);
  assert.equal(
    (await f.emit("input", { text: `${MARKER}job-1\nWork` })).action,
    "handled",
  );
});
