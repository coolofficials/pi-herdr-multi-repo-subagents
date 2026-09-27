import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { snapshot } from "../src/workflow.mjs";
import childBridge from "../src/child.ts";
import { readJSON, writeJSON, MARKER } from "../src/core.mjs";

import { processIdentity } from "../src/lifecycle.mjs";
async function child(t, options = {}) {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-child-")),
  );
  const handlers = new Map(),
    commands = new Map(),
    registered = new Map();
  let tools = ["read", "repo_agent_start"],
    shutdowns = 0;
  const parent = options.parent ?? processIdentity();
  await writeJSON(path.join(dir, "launch.json"), {
    token: "launch",
    cwd: dir,
    root: dir,
    parent,
    scope: dir,
    workflowId: "parent",
    expiresAt: Date.now() + 10000,
  });
  await writeJSON(path.join(dir, "parent.json"), {
    instance: parent,
    status: "active",
  });
  const bridge = childBridge({
    on: (name, fn) => handlers.set(name, fn),
    registerFlag() {},
    registerTool(tool) {
      registered.set(tool.name, tool);
    },
    setSessionName() {},
    getAllTools: () => tools.map((name) => ({ name })),
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
    role: options.role,
  });
  if (options.coordinator) bridge.setCoordinator(options.coordinator);
  return { dir, emit, ctx, commands, registered, shutdowns: () => shutdowns };
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
  await writeJSON(path.join(dir, "job-1.brief.json"), {
    brief: { outcome: "completed", summary: "작업 완료" },
  });
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

test("lead missing a brief without pending children produces needs-report", async (t) => {
  const f = await child(t, {
    role: "task_lead",
    coordinator: { records: async () => [] },
  });
  await f.emit("input", { text: `${MARKER}job-1\nWork` });
  await f.emit("agent_settled");
  assert.equal(
    (await readJSON(path.join(f.dir, "job-1.result.json"))).status,
    "needs-report",
  );
  assert.equal(
    (await readJSON(path.join(f.dir, "job-state.json"))).jobId,
    undefined,
  );
});
test("lead without brief waits only for actual pending children", async (t) => {
  let dir;
  const f = await child(t, {
    role: "task_lead",
    coordinator: { records: async () => [{ id: "pending", dir }] },
  });
  dir = path.join(f.dir, "pending");
  await writeJSON(path.join(dir, "request.json"), { jobId: "pending-job" });
  await f.emit("input", { text: `${MARKER}job-1\nWork` });
  await f.emit("agent_settled");
  assert.equal(await readJSON(path.join(f.dir, "job-1.result.json")), null);
  assert.equal(
    (await readJSON(path.join(f.dir, "activity.json"))).status,
    "waiting_children",
  );
  await writeJSON(path.join(dir, "pending-job.result.json"), {
    status: "settled",
  });
  await f.emit("agent_settled");
  assert.equal(
    (await readJSON(path.join(f.dir, "job-1.result.json"))).status,
    "needs-report",
  );
});

test("parallel Reviewer tools preserve coverage and dependencies for every repo", async (t) => {
  const f = await child(t, { role: "reviewer" });
  const targets = {};
  for (const repo of ["a", "b"]) {
    const cwd = path.join(f.dir, repo);
    await fs.mkdir(cwd);
    execFileSync("git", ["init", "-q", cwd]);
    await fs.writeFile(path.join(cwd, "index.mjs"), "export const n=1;\n");
    const baseline = path.join(f.dir, repo + ".base.json");
    await writeJSON(baseline, await snapshot(cwd));
    await fs.writeFile(path.join(cwd, "index.mjs"), "export const n=2;\n");
    const target = await snapshot(cwd),
      saved = path.join(f.dir, repo + ".target.json");
    await writeJSON(saved, target);
    targets[repo] = {
      path: cwd,
      baseline,
      target: target.fingerprint,
      snapshot: saved,
    };
  }
  await writeJSON(path.join(f.dir, "request.json"), {
    jobId: "job-1",
    owner: "parent",
    role: "reviewer",
    contract: { root: f.dir, review: { kind: "work", targets } },
  });
  await f.emit("input", { text: `${MARKER}job-1\nReview` });
  const tool = f.registered.get("repo_review_changes");
  await Promise.all(
    ["a", "b"].map((repo) => tool.execute("call", { repo, file: "index.mjs" })),
  );
  const inspected = await readJSON(path.join(f.dir, "job-1.inspection.json"));
  assert.deepEqual(Object.keys(inspected).sort(), ["a", "b"]);
  for (const repo of ["a", "b"])
    assert.equal(inspected[repo].files["index.mjs"].complete, true);
  const scope = await readJSON(path.join(f.dir, "job-1.scope.json"));
  assert.deepEqual(Object.keys(scope.files).sort(), [
    "a/index.mjs",
    "b/index.mjs",
  ]);
});

test("read-only child roles reject raw source, shell and edit tools", async (t) => {
  for (const role of ["task_lead", "reviewer", "oracle"]) {
    const f = await child(t, { role });
    await f.emit("input", { text: `${MARKER}job-1\nWork` });
    for (const toolName of [
      "read",
      "write",
      "edit",
      "bash",
      "unknown_extension_tool",
    ])
      assert.equal((await f.emit("tool_call", { toolName })).block, true);
  }
});

test("missing brief gets exactly one report-only continuation without changing job", async (t) => {
  const { dir, emit, registered } = await child(t);
  await emit("input", { text: `${MARKER}job-1\nWork` });
  const event = {
    outcome: "completed",
    context: { canContinue: false },
    continue: false,
  };
  const repair = await emit("agent_before_settle", event);
  assert.equal(repair.continue, true);
  assert.match(repair.entries[0].content, /SAME job/);
  assert.equal((await emit("tool_call", { toolName: "read" })).block, true);
  assert.equal(await readJSON(path.join(dir, "job-1.result.json")), null);
  assert.equal(await emit("agent_before_settle", event), undefined);
  await registered
    .get("repo_agent_report")
    .execute("", { outcome: "incomplete", summary: "Evidence missing" });
  await emit("agent_settled");
  assert.equal(
    (await readJSON(path.join(dir, "job-1.result.json"))).brief.outcome,
    "incomplete",
  );
});
test("checkpoint replaces context at a boundary but retains delegated job", async (t) => {
  const { dir, emit, registered, ctx } = await child(t);
  await emit("input", { text: `${MARKER}job-1\nWork` });
  await registered.get("repo_checkpoint").execute(
    "",
    {
      reason: "large context",
      summary: "Requirement: implement timeout; read artifact X then verify Y.",
    },
    undefined,
    undefined,
    ctx,
  );
  const result = await emit("agent_before_settle", {
    outcome: "completed",
    context: { canContinue: false },
  });
  assert.equal(result.entries[0].type, "compaction");
  assert.equal(result.entries[0].firstKeptEntryId, null);
  assert.match(result.entries[0].summary, /job-1/);
  assert.equal(await readJSON(path.join(dir, "job-1.result.json")), null);
  assert.equal(
    (await readJSON(path.join(dir, "job-1.checkpoint.json"))).applied,
    true,
  );
});

test("report schema exposes verdict only to independent review roles", async (t) => {
  for (const role of ["implementer", "task_lead", "reviewer", "oracle"]) {
    const { emit, registered } = await child(t, { role });
    await emit("input", { text: `${MARKER}job-1\nWork` });
    const schema = registered.get("repo_agent_report").parameters;
    assert.equal(
      Object.hasOwn(schema.properties, "verdict"),
      ["reviewer", "oracle"].includes(role),
    );
  }
});
