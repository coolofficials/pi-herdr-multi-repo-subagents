import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  Controller,
  discoverRepos,
  resolveRepo,
  herdr,
  writeJSON,
  readJSON,
  summarizeMessages,
} from "../src/core.mjs";

import { processIdentity } from "../src/lifecycle.mjs";
const liveReady = { managed: true, instance: processIdentity() };

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "task");
  await fs.mkdir(root);
  const repo = async (p) => {
    await fs.mkdir(path.join(root, p, ".git"), { recursive: true });
    return path.join(root, p);
  };
  return { dir, root, repo };
}
test("discovers arbitrary nested roots, root metadata, worktree .git files and jj; stops inside repositories", async (t) => {
  const { root, repo } = await fixture(t);
  await repo(".");
  await repo("nested/backend");
  await repo("nested/backend/fixture");
  await repo("node_modules/ignored");
  await repo(".hidden/ignored");
  await fs.mkdir(path.join(root, "other"));
  await fs.writeFile(path.join(root, "other", ".git"), "gitdir: elsewhere");
  await fs.mkdir(path.join(root, "jj-only", ".jj"), { recursive: true });
  assert.deepEqual(
    (await discoverRepos(root)).repositories.map((r) => r.repo),
    ["jj-only", "nested/backend", "other"],
  );
});
test("discovery does not follow symlinks; explicit includes reject root escape", async (t) => {
  const { dir, root, repo } = await fixture(t);
  await repo("actual");
  await fs.mkdir(path.join(dir, "outside", ".git"), { recursive: true });
  await fs.symlink(path.join(dir, "outside"), path.join(root, "outside-link"));
  await fs.symlink(root, path.join(root, "loop"));
  assert.deepEqual(
    (await discoverRepos(root)).repositories.map((r) => r.repo),
    ["actual"],
  );
  await assert.rejects(resolveRepo(root, "outside-link"), /descendant/);
  await assert.rejects(resolveRepo(root, "../outside"), /descendant/);
  await assert.rejects(resolveRepo(root, root), /relative/);
});
test("include/exclude paths override discovery without hardcoded repo directory names", async (t) => {
  const { root, repo } = await fixture(t);
  await repo("apps/api");
  await repo("apps/api/nested");
  await repo("apps/web");
  await writeJSON(path.join(root, "pi-herdr.json"), {
    include: ["apps/api/nested", "apps/web"],
    exclude: ["apps/web"],
  });
  assert.deepEqual(
    (await discoverRepos(root)).repositories.map((r) => r.repo),
    ["apps/api/nested"],
  );
  await writeJSON(path.join(root, "pi-herdr.json"), { maxDepth: 0 });
  await assert.rejects(discoverRepos(root), /maxDepth/);
});
test("outside Herdr fails before running a command", async () => {
  await assert.rejects(
    herdr(["pane", "split"], { env: {} }),
    /inside a Herdr pane/,
  );
});
async function controlled(t, opts = {}) {
  const f = await fixture(t);
  await f.repo("repos/api");
  await f.repo("repos/web");
  await writeJSON(path.join(f.root, "pi-herdr.json"), { layout: "split" });
  const calls = [];
  const live = new Map();
  let n = 0;
  const transport = async (args) => {
    calls.push(args);
    if (args[0] === "status") return "version: 0.9.1";
    if (args[1] === "layout")
      return {
        result: {
          layout: {
            panes: [{ pane_id: "w1:p1", rect: { width: 160, height: 40 } }],
          },
        },
      };
    if (args[1] === "split") {
      return { result: { pane: { pane_id: `w1:p${++n + 1}` } } };
    }
    if (args[1] === "start") {
      const { dir } = JSON.parse(args[args.indexOf("--repo-agent-child") + 1]);
      const launch = await readJSON(path.join(dir, "launch.json"));
      await writeJSON(path.join(dir, "ready.json"), {
        ...liveReady,
        cwd: launch.cwd,
        pane: launch.pane,
      });
      live.set(args[2], {
        name: args[2],
        status: "idle",
        pane_id: args[args.indexOf("--pane") + 1],
      });
      return { result: { agent: live.get(args[2]) } };
    }
    if (args[1] === "get") {
      if (!live.has(args[2])) throw new Error("not found");
      return { result: { agent: live.get(args[2]) } };
    }
    if (args[1] === "prompt") {
      if (opts.failPrompt) throw new Error("timeout after write");
      return { result: { agent: live.get(args[2]) } };
    }
    if (args[1] === "list") return { result: { agents: [...live.values()] } };
    if (args[1] === "read") return "visible log";
    throw new Error(`Unexpected mock command ${args}`);
  };
  const controller = new Controller({
    root: f.root,
    storage: path.join(f.dir, "state"),
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/test/socket",
    },
    transport,
  });
  return { ...f, controller, calls, live };
}
test("start uses returned pane, repository cwd, argv strings and no focus; duplicate repo rejected", async (t) => {
  const { controller, calls } = await controlled(t);
  const value = await controller.start({
    role: "scout",
    repo: "repos/api",
    task: "Literal $(touch /tmp/nope) `command`",
    model: "provider/model",
  });
  assert.equal(value.pane, "w1:p2");
  const split = calls.find((x) => x[1] === "split");
  assert.ok(split.includes("--no-focus"));
  assert.equal(split[split.indexOf("--direction") + 1], "right");
  assert.ok(split[split.indexOf("--cwd") + 1].endsWith("/repos/api"));
  const start = calls.find((x) => x[1] === "start");
  assert.equal(start[start.indexOf("--pane") + 1], value.pane);
  await assert.rejects(
    controller.start({ role: "scout", repo: "repos/api", task: "second" }),
    /already serves this scope/,
  );
});
test("durable report survives controller reload; next prompt has a new job and no stale report", async (t) => {
  const { controller, calls } = await controlled(t);
  const first = await controller.start({
    role: "scout",
    repo: "repos/api",
    task: "first",
  });
  const record = await controller.record(first.id);
  await writeJSON(path.join(record.dir, `${first.jobId}.result.json`), {
    jobId: first.jobId,
    status: "settled",
    summary: "completed first",
    brief: { outcome: "completed", summary: "completed first" },
  });
  const reloaded = new Controller({
    root: controller.root,
    storage: controller.storage,
    env: controller.env,
    transport: controller.transport,
  });
  assert.equal(
    (await reloaded.read({ id: first.id })).report.brief.summary,
    "completed first",
  );
  const next = await reloaded.prompt({ id: first.id, task: "second" });
  assert.notEqual(next.jobId, first.jobId);
  assert.equal((await reloaded.read({ id: first.id })).report, null);
  assert.equal(calls.filter((x) => x[1] === "split").length, 1);
});
test("uncertain submission remains registered and is never retried automatically", async (t) => {
  const { controller, calls } = await controlled(t, { failPrompt: true });
  await assert.rejects(
    controller.start({ role: "scout", repo: "repos/api", task: "test" }),
    /Submission may have happened/,
  );
  const [record] = await controller.records();
  assert.ok(record.jobId);
  await assert.rejects(
    controller.prompt({ id: record.id, task: "retry" }),
    /no settled report/,
  );
  assert.equal(calls.filter((x) => x[1] === "prompt").length, 1);
});
test("working and blocked agents reject followup; read returns blocked without claiming success", async (t) => {
  const { controller, live } = await controlled(t);
  const value = await controller.start({
    role: "scout",
    repo: "repos/api",
    task: "test",
  });
  live.get(value.id).status = "blocked";
  const result = await controller.read({ id: value.id });
  assert.equal(result.status, "blocked");
  assert.equal(result.report, null);
});
test("concurrent starts cannot write competing registry entries", async (t) => {
  const { controller } = await controlled(t);
  const results = await Promise.allSettled([
    controller.start({ role: "scout", repo: "repos/api", task: "a" }),
    controller.start({ role: "scout", repo: "repos/api", task: "b" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await controller.records()).length, 1);
});
test("forget preserves active pane; unavailable reports remain readable", async (t) => {
  const { controller, live } = await controlled(t);
  const value = await controller.start({
    role: "scout",
    repo: "repos/api",
    task: "test",
  });
  await assert.rejects(
    controller.forget({ id: value.id }),
    /exit was not cleanly/,
  );
  live.delete(value.id);
  assert.equal((await controller.read({ id: value.id })).status, "unavailable");
  const rec = await controller.record(value.id);
  await writeJSON(path.join(rec.dir, "ready.json"), {
    cleanExit: true,
    instance: { ...processIdentity(), started: "different incarnation" },
  });
  assert.equal((await controller.forget({ id: value.id })).status, "forgotten");
});
test("summary captures final answer only and usage, excludes thoughts and tool logs", () => {
  const output = summarizeMessages([
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "earlier" },
      ],
      usage: { input: 12, output: 4 },
    },
    { role: "toolResult", content: [{ type: "text", text: "huge log" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "final" }],
      usage: { input: 8, output: 3 },
      stopReason: "stop",
    },
  ]);
  assert.equal(output.summary, "final");
  assert.equal(output.usage.input, 20);
  assert.equal(output.usage.output, 7);
});
test("explicit tabs preserve independent starts and distinct job identities", async (t) => {
  const { controller, root, calls } = await controlled(t);
  await writeJSON(path.join(root, "pi-herdr.json"), { layout: "tabs" });
  const transport = controller.transport;
  controller.env.HERDR_WORKSPACE_ID = "w1";
  controller.transport = async (args, opts) => {
    if (args[0] === "tab" && args[1] === "create") {
      calls.push(args);
      return { result: { root_pane: { pane_id: `w1:p${calls.length + 10}` } } };
    }
    return transport(args, opts);
  };
  const a = await controller.start({
    role: "scout",
    repo: "repos/api",
    task: "A",
  });
  const b = await controller.start({
    role: "scout",
    repo: "repos/web",
    task: "B",
  });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.jobId, b.jobId);
  assert.equal(
    calls.filter((x) => x[0] === "tab" && x[1] === "create").length,
    2,
  );
  assert.equal(calls.filter((x) => x[1] === "split").length, 0);
});
test("reset waits for idle and fresh session evidence, then submits a distinct task", async (t) => {
  const { controller, calls } = await controlled(t);
  const a = await controller.start({
    role: "scout",
    repo: "repos/api",
    task: "A",
  });
  const rec = await controller.record(a.id);
  await assert.rejects(
    controller.reset({ id: a.id, reason: "new goal", task: "B" }),
    /settle/,
  );
  await writeJSON(path.join(rec.dir, `${a.jobId}.result.json`), {
    status: "settled",
    summary: "A done",
  });
  await writeJSON(path.join(rec.dir, "ready.json"), {
    ...liveReady,
    sessionId: "old",
    sessionFile: "/old.jsonl",
  });
  const transport = controller.transport;
  controller.transport = async (args, opts) => {
    if (args[1] === "prompt" && args[3] === "/new")
      await writeJSON(path.join(rec.dir, "ready.json"), {
        ...liveReady,
        sessionId: "new",
        sessionFile: "/new.jsonl",
      });
    return transport(args, opts);
  };
  const b = await controller.reset({
    id: a.id,
    reason: "new goal",
    task: "B",
    context: "handoff",
  });
  assert.notEqual(a.jobId, b.jobId);
  assert.equal(a.pane, b.pane);
  assert.equal(calls.filter((x) => x[1] === "split").length, 1);
  assert.equal((await controller.record(a.id)).previousSession, "/old.jsonl");
});
test("invalid work is rejected before creating a pane or resetting a session", async (t) => {
  const { controller, calls } = await controlled(t);
  await assert.rejects(
    controller.start({ role: "scout", repo: "repos/api", task: " " }),
    /empty/,
  );
  await assert.rejects(
    controller.start({
      role: "scout",
      repo: "repos/api",
      task: "x".repeat(48001),
    }),
    /16000/,
  );
  assert.equal(calls.length, 0);
});
test("reset tolerates Herdr unknown state while the fresh Pi session initializes", async (t) => {
  const { controller, live } = await controlled(t);
  const started = await controller.start({
    role: "scout",
    repo: "repos/api",
    task: "first",
  });
  const record = await controller.record(started.id);
  await writeJSON(path.join(record.dir, `${started.jobId}.result.json`), {
    status: "settled",
    summary: "done",
  });
  await writeJSON(path.join(record.dir, "ready.json"), {
    ...liveReady,
    sessionId: "old",
  });
  const transport = controller.transport;
  let resetting = false;
  let unknownCount = 0;
  controller.transport = async (args, options) => {
    if (args[1] === "prompt" && args[3] === "/new") {
      resetting = true;
      await writeJSON(path.join(record.dir, "ready.json"), {
        ...liveReady,
        sessionId: "new",
      });
    }
    if (resetting && args[1] === "get" && unknownCount++ < 2)
      return {
        result: { agent: { ...live.get(started.id), status: "unknown" } },
      };
    return transport(args, options);
  };
  const next = await controller.reset({
    id: started.id,
    reason: "fresh review",
    task: "review",
  });
  assert.ok(unknownCount >= 3);
  assert.notEqual(next.jobId, started.jobId);
});

test("recovery refuses live child and preserves crash evidence after confirmed death", async (t) => {
  const { controller, live } = await controlled(t);
  const first = await controller.start({
    role: "scout",
    repo: "repos/api",
    task: "work",
  });
  const record = await controller.record(first.id);
  await assert.rejects(controller.recover(first.id), /alive or unknown/);
  live.delete(first.id);
  await writeJSON(path.join(record.dir, "ready.json"), {
    instance: { ...processIdentity(), started: "old incarnation" },
  });
  const recovered = await controller.recover(first.id);
  assert.equal(recovered.status, "recovered");
  assert.equal((await controller.records()).length, 0);
  assert.ok(await readJSON(path.join(record.dir, "recovered.json")));
  assert.equal(controller.lifecycle.reservation(record.path), null);
});

test("detached child cannot be reset or receive follow-up", async (t) => {
  const { controller } = await controlled(t);
  const first = await controller.start({
    role: "scout",
    repo: "repos/api",
    task: "work",
  });
  const record = await controller.record(first.id);
  await writeJSON(path.join(record.dir, `${first.jobId}.result.json`), {
    status: "settled",
    summary: "done",
  });
  await writeJSON(path.join(record.dir, "ready.json"), {
    ...liveReady,
    managed: false,
  });
  await assert.rejects(
    controller.prompt({ id: first.id, task: "next" }),
    /detached/,
  );
  await assert.rejects(
    controller.reset({ id: first.id, task: "next", reason: "new task" }),
    /detached/,
  );
});

test("recovery retry repairs cleanup after registry removal and preserves interruption", async (t) => {
  const { controller, live } = await controlled(t);
  const first = await controller.start({
    role: "scout",
    repo: "repos/api",
    task: "Inspect",
  });
  const record = await controller.record(first.id);
  live.delete(first.id);
  await writeJSON(path.join(record.dir, "ready.json"), {
    instance: { ...processIdentity(), started: "exited instance" },
  });
  const original = controller.lifecycle.unreserve.bind(controller.lifecycle);
  controller.lifecycle.unreserve = () => {
    throw Error("simulated cleanup interruption");
  };
  await assert.rejects(controller.recover(first.id), /simulated cleanup/);
  assert.equal((await controller.records()).length, 0);
  assert.ok(controller.lifecycle.reservation(record.reservationKey));
  controller.lifecycle.unreserve = original;
  assert.equal((await controller.recover(first.id)).status, "recovered");
  assert.equal(controller.lifecycle.reservation(record.reservationKey), null);
  assert.equal(
    (await readJSON(path.join(record.dir, first.jobId + ".result.json")))
      .status,
    "interrupted",
  );
  assert.equal((await controller.recover(first.id)).status, "recovered");
});
