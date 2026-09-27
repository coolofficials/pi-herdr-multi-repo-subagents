import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  describe,
  childRows,
  publish,
  showChild,
} from "../src/presentation.mjs";
import { childWorkState } from "../src/execution.mjs";
import { writeJSON } from "../src/storage.mjs";

test("multiple pending children survive one completion; report delivery does not hide pending work", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "status-multi-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const records = ["a", "b"].map((id) => ({
    id,
    dir: path.join(root, id),
    jobId: id,
    role: "task_lead",
    repo: ".",
  }));
  for (const record of records) {
    await writeJSON(path.join(record.dir, "request.json"), {
      jobId: record.jobId,
    });
    await writeJSON(path.join(record.dir, "activity.json"), {
      jobId: record.jobId,
      status: "waiting_children",
    });
  }
  assert.deepEqual((await childWorkState(records)).waiting, ["a", "b"]);
  let view = describe({
    role: "orchestrator",
    title: "Root",
    idle: true,
    children: await childRows(records, root),
  });
  assert.match(view.status, /waiting for 2 children/);
  assert.match(view.lines.join("\n"), /Task Lead \[a\].*waiting children/);
  await writeJSON(path.join(records[0].dir, "a.result.json"), {
    status: "settled",
    brief: { outcome: "completed" },
  });
  assert.deepEqual((await childWorkState(records)).waiting, ["b"]);
  view = describe({
    role: "orchestrator",
    title: "Root",
    idle: true,
    children: await childRows(records, root),
  });
  assert.match(view.status, /waiting for 1 child/);
  assert.match(view.lines.at(-1), /1 pending.*1 reported/);
});
test("every role separates identity, assignment, state and recipient; main retains a stable identity", () => {
  for (const role of [
    "task_lead",
    "implementer",
    "reviewer",
    "oracle",
    "scout",
    "researcher",
  ]) {
    const view = describe({
      role,
      title: "정식 배포 준비",
      repo: "repos/app",
      idle: false,
      parent: "task_lead",
    });
    assert.ok(view.sessionName.includes("정식 배포 준비"));
    assert.match(view.lines[0], /\] (Task|Project): 정식 배포 준비/);
    assert.match(
      view.lines[1],
      /State: .*Repo: repos\/app.*Reports to: Task Lead/,
    );
  }
  const view = describe({
    role: "orchestrator",
    title: "surete",
    idle: false,
    tasks: { active: 2, done: 3 },
  });
  assert.equal(view.sessionName, "Orchestrator");
  assert.match(view.lines[0], /2 active \/ 3 done/);
  assert.match(view.status, /coordinating/);
});
test("bounded child roster prioritizes attention, sanitizes text and retains all counts", () => {
  const children = Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    role: "implementer",
    title: "long".repeat(100),
    repo: "repos/app",
    pending: true,
    status: "running",
    issue: false,
  }));
  children.push({
    id: "broken",
    role: "reviewer",
    title: "bad\n\x1btask",
    status: "needs_report",
    issue: true,
  });
  const view = describe({
    role: "task_lead",
    title: "long".repeat(100),
    idle: true,
    children,
  });
  assert.match(view.lines[2], /broken/);
  assert.match(view.lines.join("\n"), /\+8 more/);
  assert.match(view.lines.at(-1), /10 pending.*1 attention/);
  assert.ok(view.lines.length <= 7);
  assert.ok(!view.lines.join("").includes("\x1b"));
});
test("publishing owns one footer entry and does not repeat session-name writes", () => {
  let name,
    writes = 0;
  const statuses = new Map(),
    widgets = new Map();
  const pi = {
    getSessionName: () => name,
    setSessionName: (value) => {
      name = value;
      writes++;
    },
  };
  const ctx = {
    hasUI: true,
    ui: {
      setStatus: (k, v) => statuses.set(k, v),
      setWidget: (k, v) => widgets.set(k, v),
    },
  };
  const view = describe({ role: "orchestrator", title: "root", idle: true });
  publish(pi, ctx, view);
  publish(pi, ctx, view);
  assert.equal(writes, 1);
  assert.equal(statuses.get("repo-role"), undefined);
  assert.equal(statuses.get("repo-agents"), undefined);
  assert.deepEqual(widgets.get("repo-workflow"), view.lines);
});

test("unbundled research retains the actual assignment in the child roster", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "status-research-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeJSON(path.join(dir, "request.json"), {
    jobId: "research-1",
    task: "Compare platform packaging options",
  });
  const [row] = await childRows(
    [
      {
        dir,
        jobId: "research-1",
        id: "researcher-1",
        role: "researcher",
        repo: ".",
      },
    ],
    dir,
  );
  assert.equal(row.title, "Compare platform packaging options");
  const view = describe({
    role: "orchestrator",
    title: "root",
    idle: true,
    children: [row],
  });
  assert.match(view.lines[2], /Researcher.*Compare platform packaging/);
});

test("broken display data cannot interrupt child lifecycle handling", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "status-broken-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "activity.json"), "invalid");
  const statuses = new Map();
  await showChild(
    {},
    { ui: { setStatus: (key, value) => statuses.set(key, value) } },
    { role: "implementer" },
    dir,
  );
  assert.match(statuses.get("repo-workflow"), /Implementer.*unavailable/);
});
