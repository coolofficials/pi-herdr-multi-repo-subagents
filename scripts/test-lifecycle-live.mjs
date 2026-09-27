import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { herdr, readJSON, writeJSON } from "../src/core.mjs";
import { liveness } from "../src/lifecycle.mjs";
const evidence = path.resolve(process.argv[2]);
const first = await readJSON(path.join(evidence, "live-result.json"));
assert.ok(first, "Run test-live first");
assert.equal(process.env.HERDR_ENV, "1");
const root = first.root;
assert.equal(
  (await readJSON(path.join(root, "demo-fixture.json"))).type,
  "pi-herdr-multi-repo-subagents-demo",
);
const storage = path.join(
  process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  "pi-herdr-multi-repo-subagents",
);
const runs = path.join(
  storage,
  "runs",
  createHash("sha256").update(root).digest("hex").slice(0, 20),
);
const events = [];
const log = async (name, details = {}) => {
  events.push({ name, ...details, at: new Date().toISOString() });
  await writeJSON(path.join(evidence, "lifecycle-progress.json"), events);
  console.log(name);
};
async function until(label, fn, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
async function parentForPane(pane) {
  for (const run of await fs.readdir(runs)) {
    const p = await readJSON(path.join(runs, run, "parent.json"));
    if (p?.pane === pane && p.status === "active") return p;
  }
}
const idle = async (name) => {
  try {
    const a = (await herdr(["agent", "get", name])).result.agent;
    return ["idle", "done"].includes(a.agent_status ?? a.status);
  } catch {
    return false;
  }
};
const ready = (record) => readJSON(path.join(record.dir, "ready.json"));
const dead = async (record) =>
  liveness((await ready(record))?.instance) === "dead";
const parent = await parentForPane(first.pane);
assert.ok(parent);
await until("initial parent idle", () => idle(first.coordinator));
const records = await readJSON(path.join(parent.scope, "agents.json"));
assert.equal(records.length, 2);
const beforeReload = Date.now();
await herdr(["agent", "prompt", first.coordinator, "/reload"]);
await until("reload", async () => {
  const p = await parentForPane(first.pane);
  return (
    p?.runId === parent.runId &&
    Date.parse(p.updatedAt) >= beforeReload &&
    (await idle(first.coordinator))
  );
});
await new Promise((resolve) => setTimeout(resolve, 1500));
await log("parent-reload-preserves-family", { runId: parent.runId });
await herdr([
  "agent",
  "prompt",
  first.coordinator,
  "/repo-agents fresh Lifecycle verification: implementation, builds and tests already passed. Retain both idle repository children. Next verify parent exit; do not do more repository work until explicitly asked.",
]);
const fresh = await until("same process fresh handoff", async () => {
  const p = await parentForPane(first.pane);
  return p?.sessionId !== parent.sessionId ? p : false;
});
assert.equal(fresh.runId, parent.runId);
assert.equal(fresh.instance.pid, parent.instance.pid);
await log("fresh-conversation-preserves-process-and-children", {
  oldSession: parent.sessionId,
  newSession: fresh.sessionId,
});
const newTab = async (label) =>
  (
    await herdr([
      "tab",
      "create",
      "--workspace",
      process.env.HERDR_WORKSPACE_ID,
      "--label",
      label,
      "--cwd",
      root,
      "--no-focus",
    ])
  ).result.root_pane.pane_id;
const duplicatePane = await newTab("Duplicate owner check");
const duplicateName = `duplicate-${Date.now().toString(36)}`;
await herdr([
  "agent",
  "start",
  duplicateName,
  "--kind",
  "pi",
  "--pane",
  duplicatePane,
]);
await new Promise((r) => setTimeout(r, 1000));
assert.equal((await parentForPane(first.pane)).runId, parent.runId);
const duplicateScreen = await herdr(
  ["agent", "read", duplicateName, "--source", "visible", "--lines", "100"],
  { raw: true },
);
await fs.writeFile(
  path.join(evidence, "duplicate-owner-screen.txt"),
  duplicateScreen,
);
assert.match(duplicateScreen, /Coordination unavailable|Another main Pi/);
await herdr(["agent", "prompt", duplicateName, "/quit"]);
await log("second-main-cannot-take-root");
const backend = records.find((r) => r.repo.endsWith("backend"));
const frontend = records.find((r) => r.repo.endsWith("frontend"));
const started = path.join(evidence, "drain-started"),
  release = path.join(evidence, "drain-release"),
  done = path.join(evidence, "drain-done");
const code = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'started');const deadline=Date.now()+180000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)throw Error('test release timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);}fs.writeFileSync(${JSON.stringify(done)},'done');`;
const task = `Authorized lifecycle test. Create a new repo_work bundle for repos/backend with this process-drain scenario as acceptance criteria. Reset ${backend.id} to implementer with that bundle and a handoff. Ask that child to run this Node script using bash and wait for it to finish, then submit repo_agent_report with summary DRAIN-DONE and end with DRAIN-DONE: ${code} . Do not run the script yourself. Leave frontend idle. After submitting the child task, end your turn with DRAIN-DISPATCHED. Do not wait or poll.`;
await herdr(["agent", "prompt", first.coordinator, task]);
await until(
  "child started actual blocking tool",
  () =>
    fs.access(started).then(
      () => true,
      () => false,
    ),
  120000,
);
await until("parent returned", () => idle(first.coordinator));
const busy = (await readJSON(path.join(parent.scope, "agents.json"))).find(
  (r) => r.id === backend.id,
);
assert.equal(liveness(parent.instance), "alive");
process.kill(parent.instance.pid, "SIGKILL");
await until("old parent dead", () => liveness(parent.instance) === "dead");
await until("idle frontend exited", () => dead(frontend), 15000);
assert.equal(await dead(backend), false);
await log("parent-hard-exit-idle-child-exits-busy-child-keeps-working");
const nextPane = await newTab("New parent family");
const nextName = `newmain-${Date.now().toString(36)}`;
await herdr(["agent", "start", nextName, "--kind", "pi", "--pane", nextPane]);
const next = await until("new parent owns root", () => parentForPane(nextPane));
assert.notEqual(next.runId, parent.runId);
assert.deepEqual(await readJSON(path.join(next.scope, "agents.json"), []), []);
assert.equal(await dead(backend), false);
await log("new-parent-does-not-adopt-draining-child", { runId: next.runId });
await fs.writeFile(release, "release");
await until(
  "busy child saved result and exited",
  async () =>
    (await readJSON(path.join(busy.dir, `${busy.jobId}.result.json`))) &&
    (await dead(busy)),
  120000,
);
const report = await readJSON(path.join(busy.dir, `${busy.jobId}.result.json`));
assert.equal(await fs.readFile(done, "utf8"), "done");
assert.equal(report.status, "settled");
assert.match(report.summary, /DRAIN-DONE/);
assert.equal((await ready(busy)).cleanExit, true);
await log("busy-child-persists-success-before-exit", { jobId: busy.jobId });
await herdr([
  "agent",
  "prompt",
  nextName,
  "This is the final lifecycle smoke test. Delegate only repos/backend with repo_agent_start role=explorer and ask it to submit repo_agent_report summary IDLE-CHILD-READY and end its turn without file edits. Do not work on frontend. Wait for automatic completion; after the child report, reply IDLE-TEST-READY.",
]);
const nextChild = await until(
  "new child completed",
  async () => {
    const [r] = await readJSON(path.join(next.scope, "agents.json"), []);
    return r?.jobId &&
      (await readJSON(path.join(r.dir, `${r.jobId}.result.json`)))
      ? r
      : false;
  },
  120000,
);
await until("next parent idle", () => idle(nextName));
await herdr(["agent", "prompt", nextName, "/quit"]);
await until("normal parent exit", () => liveness(next.instance) === "dead");
await until("normal exit idle child exits", () => dead(nextChild), 15000);
await log("normal-quit-cleans-idle-child");
const ordinaryName = `ordinary-${Date.now().toString(36)}`;
await herdr([
  "agent",
  "start",
  ordinaryName,
  "--kind",
  "pi",
  "--pane",
  nextChild.pane,
]);
await herdr(["agent", "prompt", ordinaryName, "/repo-agents"]);
await new Promise((r) => setTimeout(r, 1000));
const ordinaryScreen = await herdr(
  ["agent", "read", ordinaryName, "--source", "visible", "--lines", "100"],
  { raw: true },
);
await fs.writeFile(
  path.join(evidence, "ordinary-repo-screen.txt"),
  ordinaryScreen,
);
assert.doesNotMatch(
  ordinaryScreen,
  /This is a managed child|initialization failed/,
);
assert.match(ordinaryScreen, /repositories|Repository agents/);
await herdr(["agent", "prompt", ordinaryName, "/quit"]);
await log("ordinary-pi-in-former-child-pane-is-independent");
await writeJSON(path.join(evidence, "lifecycle-result.json"), {
  passed: true,
  events,
  verifiedAt: new Date().toISOString(),
});
