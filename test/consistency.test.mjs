import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readJSON, writeJSON, serialExecutor } from "../src/storage.mjs";
import {
  taskApprovalScope,
  approvalScopeValid,
  addReviewDependencies,
} from "../src/approval.mjs";
import {
  createProject,
  createWork,
  getWork,
  recordDirectInput,
  taskInput,
  requireClassifiedInputs,
  prepareAssignment,
} from "../src/hierarchy.mjs";
import { interruptRecoveredJob, executionState } from "../src/execution.mjs";

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-consistency-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"),
    scope = path.join(root, "state");
  await fs.mkdir(repo);
  execFileSync("git", ["init", "-q", repo]);
  await fs.writeFile(path.join(repo, "a.mjs"), "export const a=1;\n");
  await fs.writeFile(path.join(repo, "dep.mjs"), "export const dep=1;\n");
  const client = {
    root,
    scope,
    workScope: scope,
    records: async () => [],
    call: async () => ({ result: { agent: { status: "idle" } } }),
  };
  const project = await createProject(client, {
    title: "Project",
    requirements: "Keep contracts stable",
  });
  const task = await createWork(client, {
    project: project.id,
    title: "A",
    requirements: "Change a",
    repos: ["repo"],
  });
  const lead = { ...client, delegation: { bundle: task.id } };
  return { root, repo, scope, client, project, task, lead };
}
async function review(f) {
  await fs.writeFile(path.join(f.repo, "a.mjs"), "export const a=2;\n");
  const dir = path.join(f.root, "review"),
    job = randomUUID();
  const contract = await prepareAssignment(
    f.lead,
    { id: "reviewer", dir, repo: "." },
    job,
    "reviewer",
    f.task.id,
  );
  return { dir, job, request: { role: "reviewer", contract } };
}
test("task approval survives unrelated file changes; dependency changes invalidate it", async (t) => {
  const f = await fixture(t),
    r = await review(f);
  await addReviewDependencies(r.request, r.dir, r.job, {
    files: ["repo/dep.mjs"],
  });
  const scope = await taskApprovalScope(r.request, r.dir, r.job);
  assert.equal(await approvalScopeValid(scope), true);
  await fs.writeFile(path.join(f.repo, "b.mjs"), "export const b=1;\n");
  assert.equal(await approvalScopeValid(scope), true);
  await fs.writeFile(path.join(f.repo, "dep.mjs"), "export const dep=2;\n");
  assert.equal(await approvalScopeValid(scope), false);
});
test("absence, whole-repository and project contract dependencies are enforced", async (t) => {
  const f = await fixture(t),
    r = await review(f);
  await addReviewDependencies(r.request, r.dir, r.job, {
    files: ["repo/optional.json"],
  });
  const scoped = await taskApprovalScope(r.request, r.dir, r.job);
  await fs.writeFile(path.join(f.repo, "optional.json"), "{}");
  assert.equal(await approvalScopeValid(scoped), false);
  await fs.rm(path.join(f.repo, "optional.json"));
  await addReviewDependencies(r.request, r.dir, r.job, {
    wholeRepositories: ["repo"],
  });
  const whole = await taskApprovalScope(r.request, r.dir, r.job);
  await fs.writeFile(path.join(f.repo, "unrelated"), "new");
  assert.equal(await approvalScopeValid(whole), false);
  await fs.rm(path.join(f.repo, "unrelated"));
  await writeJSON(path.join(f.scope, "projects", f.project.id + ".json"), {
    ...f.project,
    revision: 2,
  });
  assert.equal(await approvalScopeValid(scoped), false);
});
test("question classification preserves revisions, refinement is idempotent, escalation blocks advancement", async (t) => {
  const f = await fixture(t);
  const id = await recordDirectInput(f.lead, "status?");
  const before = await getWork(f.scope, f.task.id);
  assert.throws(() => requireClassifiedInputs(before), /Classify/);
  await taskInput(f.lead, {
    action: "classify",
    id,
    kind: "question",
    summary: "Status only",
  });
  const after = await getWork(f.scope, f.task.id);
  assert.equal(after.noteRevision, before.noteRevision);
  assert.equal(after.inputRevision, before.inputRevision);
  requireClassifiedInputs(after);
  const edit = await recordDirectInput(f.lead, "Change detail");
  const args = {
    action: "classify",
    id: edit,
    kind: "refinement",
    summary: "Change detail in scope",
  };
  await taskInput(f.lead, args);
  await taskInput(f.lead, args);
  const changed = await getWork(f.scope, f.task.id);
  assert.equal(changed.noteRevision, before.noteRevision + 1);
  assert.equal(changed.inputRevision, 1);
  const scope = await recordDirectInput(f.lead, "Expand scope");
  await taskInput(f.lead, {
    action: "classify",
    id: scope,
    kind: "escalation",
    summary: "Need broader requirements",
  });
  const escalated = await getWork(f.scope, f.task.id);
  assert.throws(() => requireClassifiedInputs(escalated), /Orchestrator/);
});
test("recovery writes interruption once without fabricating a successful report", async (t) => {
  const f = await fixture(t),
    dir = path.join(f.root, "dead");
  await writeJSON(path.join(dir, "request.json"), {
    jobId: "job",
    role: "implementer",
  });
  await interruptRecoveredJob(dir);
  const report = await readJSON(path.join(dir, "job.result.json"));
  assert.equal(report.status, "interrupted");
  assert.equal(report.brief.outcome, "incomplete");
  await interruptRecoveredJob(dir);
  assert.deepEqual(await readJSON(path.join(dir, "job.result.json")), report);
  await writeJSON(path.join(dir, "recovered.json"), { status: "recovered" });
  assert.equal((await executionState({ dir })).phase, "recovered");
  assert.equal((await executionState({ dir })).pending, false);
});

test("parallel inspection updates retain every entry and failed operations do not poison the queue", async (t) => {
  const f = await fixture(t),
    file = path.join(f.root, "inspection.json"),
    run = serialExecutor();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      run(async () => {
        const state = await readJSON(file, {});
        await new Promise((r) => setTimeout(r, 1));
        state[i] = true;
        await writeJSON(file, state);
      }),
    ),
  );
  assert.equal(Object.keys(await readJSON(file)).length, 20);
  await assert.rejects(
    run(async () => {
      throw Error("interrupted");
    }),
    /interrupted/,
  );
  assert.equal(await run(async () => 42), 42);
});
