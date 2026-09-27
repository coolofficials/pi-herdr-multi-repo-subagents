import { familyRecords } from "../src/views.mjs";
import { executionState } from "../src/execution.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { herdr, readJSON, writeJSON } from "../src/core.mjs";
import { workStatus, projectAction, getWork } from "../src/hierarchy.mjs";

const [rootArg, evidenceArg] = process.argv.slice(2);
if (!rootArg || !evidenceArg)
  throw Error(
    "Usage: node scripts/test-concurrency-live.mjs TASK_ROOT EVIDENCE_DIR (inside a dedicated Herdr test session)",
  );
assert.equal(process.env.HERDR_ENV, "1", "Run in a real dedicated Herdr pane.");
const root = await fs.realpath(rootArg),
  evidence = path.resolve(evidenceArg);
assert.equal(
  (await readJSON(path.join(root, "demo-fixture.json")))?.type,
  "pi-herdr-multi-repo-subagents-demo",
);
await fs.mkdir(evidence, { recursive: true });
let start = await readJSON(path.join(evidence, "hierarchy-start.json"));
if (start && start.root !== root)
  throw Error("Evidence belongs to another fixture.");
if (!start) {
  const created = await herdr([
    "tab",
    "create",
    "--workspace",
    process.env.HERDR_WORKSPACE_ID,
    "--label",
    "Concurrency verification",
    "--cwd",
    root,
    ...(process.env.PI_CODING_AGENT_DIR
      ? ["--env", `PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR}`]
      : []),
    "--no-focus",
  ]);
  const pane = created.result.root_pane.pane_id,
    name = "hierarchy-" + Date.now().toString(36);
  let launched = await herdr([
    "agent",
    "start",
    name,
    "--kind",
    "pi",
    "--pane",
    pane,
    "--",
    "--session-dir",
    path.join(evidence, "main-sessions"),
  ]);
  const bindingDeadline = Date.now() + 10000;
  while (!launched.result.agent.agent_session?.value) {
    if (Date.now() > bindingDeadline)
      throw Error(
        "Herdr session identity unavailable; inspect retained main, do not resubmit.",
      );
    await new Promise((r) => setTimeout(r, 250));
    launched = await herdr(["agent", "get", name]);
  }
  start = {
    root,
    pane,
    name,
    session: launched.result.agent.agent_session.value,
  };
  await writeJSON(path.join(evidence, "hierarchy-start.json"), start);
  const prompt = `Authorized isolated concurrency integration test. Create one project and TWO INDEPENDENT tasks, A backend timeoutResponse in repos/backend, B frontend retryLabel in repos/frontend according to references/timeout-contract.md. Delegate BOTH Task Leads before waiting for either result, so they execute concurrently. Each Lead delegates its own Implementer, then an independent Reviewer, and reports approved completion. Each Implementer must first run repo_check with command: node -e "setTimeout(() => console.log('CONCURRENCY-HOLD-DONE'), 60000)" (timeoutMs 90000), then implement the task, run npm test/build and report. This deliberate delay is authorized ONLY for this isolated test to observe overlapping execution. Do not run the delay in Reviewer. Orchestrator must not do implementation or raw inspection; end turns for automatic reports, do not poll. After both approved Lead reports request Oracle, complete project and finish CONCURRENCY-LIVE-COMPLETE. Preserve scoped instructions, use default task tabs/board. Register progressDocuments=["todo-tracker.md"] when creating project. Stop on genuine blockers.`;
  // Persist intent before submission: a timeout must not cause automatic resubmission.
  await writeJSON(path.join(evidence, "hierarchy-prompt-intent.json"), {
    name,
    prompt,
  });
  await herdr(["agent", "prompt", name, prompt]);
}
const storage = path.join(
  process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  "pi-herdr-multi-repo-subagents",
);
const runs = path.join(
  storage,
  "runs",
  createHash("sha256").update(root).digest("hex").slice(0, 20),
);
const until = async (fn) => {
  const deadline = Date.now() + Number(process.env.PI_TEST_TIMEOUT ?? 600000);
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline)
      throw Error(
        "Timed out; inspect retained panes and evidence, never blindly resubmit.",
      );
    await new Promise((r) => setTimeout(r, 2000));
  }
};
const scope = await until(async () => {
  for (const run of await fs.readdir(runs).catch(() => [])) {
    const p = await readJSON(path.join(runs, run, "parent.json"));
    if (p?.pane === start.pane && p.status === "active") return p.scope;
  }
});
const captures = new Set();
const capture = async (key, records) => {
  const panes = [];
  for (const record of [{ id: start.name, role: "orchestrator" }, ...records]) {
    try {
      const live = (await herdr(["agent", "get", record.id])).result.agent;
      const screen = await herdr(
        ["agent", "read", record.id, "--source", "visible", "--lines", "60"],
        { raw: true },
      );
      panes.push({ id: record.id, role: record.role, live, screen });
    } catch (error) {
      panes.push({ id: record.id, role: record.role, error: String(error) });
    }
  }
  await writeJSON(path.join(evidence, key + ".json"), {
    at: new Date().toISOString(),
    panes,
  });
  captures.add(key);
};
const project = await until(async () => {
  const records = await familyRecords(scope);
  const states = await Promise.all(
    records.map(async (r) => ({ ...r, execution: await executionState(r) })),
  );
  const active = states.filter(
    (r) => r.role === "implementer" && r.execution.pending,
  );
  if (active.length >= 2 && !captures.has("overlap")) {
    const live = await Promise.all(
      active.map(
        async (r) => (await herdr(["agent", "get", r.id])).result.agent,
      ),
    );
    if (live.every((a) => (a.status ?? a.agent_status) === "working"))
      await capture("overlap", records);
  }
  for (const role of ["reviewer", "oracle"])
    if (
      !captures.has(role) &&
      states.some((r) => r.role === role && r.execution.pending)
    )
      await capture(
        role,
        records.filter((r) => r.role === role),
      );
  const leads = states.filter((r) => r.role === "task_lead");
  if (
    !captures.has("waiting-multiple") &&
    leads.filter((r) => r.execution.phase === "waiting_children").length >= 2
  )
    await capture("waiting-multiple", records);
  if (
    !captures.has("one-remaining") &&
    leads.some((r) => r.execution.pending) &&
    leads.some((r) => r.execution.report)
  )
    await capture("one-remaining", leads);
  for (const name of await fs
    .readdir(path.join(scope, "projects"))
    .catch(() => [])) {
    const p = await readJSON(path.join(scope, "projects", name));
    if (p?.schema === 2 && p.status === "completed") return p;
  }
});
assert.equal(project.tasks.length, 2);
const client = { root, scope, workScope: scope };
const tasks = [];
for (const id of project.tasks) {
  const status = await workStatus(client, id);
  assert.equal(status.status, "completed");
  assert.equal(status.reviewValid, true);
  const work = await getWork(scope, id);
  const review = work.reviews.at(-1);
  const report = await readJSON(
    path.join(review.dir, `${review.jobId}.result.json`),
  );
  tasks.push({
    ...status,
    createdAt: work.createdAt,
    reviewJob: review.jobId,
    reviewedAt: report.finishedAt,
  });
}
assert.ok(
  Date.parse(tasks[1].createdAt) < Date.parse(tasks[0].reviewedAt),
  "Both tasks created before first approval",
);
assert.ok(
  await readJSON(path.join(evidence, "overlap.json")),
  "Live simultaneous Implementer evidence required",
);
const overlap = await readJSON(path.join(evidence, "overlap.json"));
assert.ok(
  overlap.panes.filter(
    (p) =>
      p.role === "implementer" &&
      (p.live?.status ?? p.live?.agent_status) === "working",
  ).length >= 2,
  "Two real Herdr working Implementers",
);
const waiting = await readJSON(path.join(evidence, "waiting-multiple.json"));
assert.ok(
  waiting?.panes.some(
    (p) =>
      p.role === "orchestrator" && p.screen.includes("waiting for 2 children"),
  ),
  "Main visibly waits for both Leads",
);
await until(async () => {
  const agent = (await herdr(["agent", "get", start.name])).result.agent;
  return ["idle", "done"].includes(agent.agent_status ?? agent.status);
});
assert.equal(
  (await projectAction(client, { action: "status", id: project.id }))
    .oracleValid,
  true,
);
const messages = (await fs.readFile(start.session, "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const calls = messages.flatMap((e) =>
  e.message?.role === "assistant"
    ? (e.message.content ?? []).filter((c) => c.type === "toolCall")
    : [],
);
assert.ok(calls.some((c) => c.name === "repo_request_review"));
assert.ok(
  !calls.some((c) =>
    [
      "read",
      "write",
      "edit",
      "bash",
      "repo_source",
      "repo_review_changes",
    ].includes(c.name),
  ),
);
const keys = messages
  .filter(
    (e) => e.type === "custom_message" && e.customType === "repo-agent-reports",
  )
  .flatMap((e) => e.details.deliveryKeys);
assert.equal(keys.length, new Set(keys).size, "Duplicate automatic delivery");
assert.ok(keys.some((k) => k.endsWith(":report")));
const result = {
  passed: true,
  root,
  ...start,
  scope,
  project: project.id,
  tasks: tasks.map((t) => ({
    id: t.id,
    title: t.title,
    reviewValid: t.reviewValid,
    attempts: t.attempts,
  })),
  oracleValid: true,
  automaticDeliveries: keys.length,
  verifiedAt: new Date().toISOString(),
};
await writeJSON(path.join(evidence, "hierarchy-result.json"), result);
console.log(JSON.stringify(result, null, 2));
