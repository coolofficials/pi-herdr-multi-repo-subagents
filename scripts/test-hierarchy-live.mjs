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
    "Usage: node scripts/test-hierarchy-live.mjs TASK_ROOT EVIDENCE_DIR (inside a dedicated Herdr test session)",
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
    "Hierarchy verification",
    "--cwd",
    root,
    "--no-focus",
  ]);
  const pane = created.result.root_pane.pane_id,
    name = "hierarchy-" + Date.now().toString(36);
  const launched = await herdr([
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
  start = {
    root,
    pane,
    name,
    session: launched.result.agent.agent_session.value,
  };
  await writeJSON(path.join(evidence, "hierarchy-start.json"), start);
  const prompt = `Authorized isolated hierarchy integration test. Create one project covering two sequential tasks: A implements the shared timeout contract in repos/backend and repos/frontend, including zero ms, npm test/build for both and the cross-module retryLabel(timeoutResponse(1250)) === 'Retry in 1250 ms'. B runs only after A's approved completion, adds new repos/backend/health.mjs exporting health() returning 'ok', verifies it with Node and changes no existing files. Create tasks with repo_work, delegate each to its own Task Lead, who delegates Implementers and uses repo_request_review for independent Reviewer approval. Keep roles separate. After B, check A's reviewValid remains true without another A review. Request Oracle for all task approvals, then complete the project. Preserve package.json, AGENTS.md and references/timeout-contract.md. Update the tracker. Do not read/edit code yourself or poll; end turns for automatic reports. Stop on genuine blockers. Finish with HIERARCHY-LIVE-COMPLETE.`;
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
const project = await until(async () => {
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
  Date.parse(tasks[0].reviewedAt) <= Date.parse(tasks[1].createdAt),
  "Task A must retain its approval without a re-review after B begins",
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
