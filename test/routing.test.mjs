import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createProject,
  createWork,
  getWork,
  authorizeDelegation,
  prepareAssignment,
  workStatus,
  projectAction,
  promoteWork,
  taskCandidate,
  reviseWork,
  inspectHierarchyReview,
  validateReviewTarget,
} from "../src/hierarchy.mjs";
import {
  executionSelection,
  singleGuidance,
  ROUTING_GUIDANCE,
} from "../src/routing.mjs";
import { writeJSON, readJSON } from "../src/storage.mjs";
import { processIdentity } from "../src/lifecycle.mjs";

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-routing-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scope = path.join(root, "state");
  for (const repo of ["a", "b"]) {
    await fs.mkdir(path.join(root, repo));
    execFileSync("git", ["init", "-q", path.join(root, repo)]);
    await fs.writeFile(path.join(root, repo, "hello.txt"), "before");
  }
  const records = [];
  const client = {
    root,
    scope,
    workScope: scope,
    records: async () => records,
    call: async () => ({ result: { agent: { status: "idle" } } }),
  };
  const project = await createProject(client, {
    title: "Project",
    requirements: "Requested outcomes only",
  });
  const make = (params = {}) =>
    createWork(client, {
      project: project.id,
      title: "Bounded task",
      requirements: "Change requested text",
      repos: ["a"],
      executionMode: "single",
      executionReason: "Local reversible change with a direct check",
      ...params,
    });
  async function report(
    work,
    {
      role = "implementer",
      outcome = "completed",
      checks = ["Read requested value"],
      refs = ["a/hello.txt"],
    } = {},
  ) {
    const record = {
      id: randomUUID(),
      dir: path.join(scope, randomUUID()),
      role,
      repo: role === "reviewer" ? "." : (work.executionRepo ?? "a"),
    };
    const jobId = randomUUID();
    const contract = await prepareAssignment(
      client,
      record,
      jobId,
      role,
      work.id,
    );
    await writeJSON(path.join(record.dir, "ready.json"), {
      instance: processIdentity(),
      managed: true,
    });
    await writeJSON(path.join(record.dir, "request.json"), {
      jobId,
      role,
      bundle: work.id,
      contract,
    });
    const brief = { outcome, summary: "Result", checks, references: refs };
    await writeJSON(path.join(record.dir, `${jobId}.result.json`), {
      jobId,
      status: "settled",
      brief,
    });
    records.push(record);
    return { record, jobId, contract, brief };
  }
  return { root, scope, client, project, make, report };
}
test("routing validates bounded reason; no classifier agent or mandatory full survey", () => {
  assert.throws(() => executionSelection("single"), /reason/);
  assert.throws(() => executionSelection("skip"), /must be/);
  assert.equal(executionSelection().executionMode, "reviewed");
  assert.match(ROUTING_GUIDANCE, /without a separate classifier/);
  assert.match(
    singleGuidance({ directManager: true, executionMode: "single" }),
    /do not explore all code/,
  );
});
test("single task uses one direct executor and completes project without Reviewer or Oracle", async (t) => {
  const f = await fixture(t),
    w = await f.make();
  await authorizeDelegation(f.client, {
    role: "implementer",
    bundle: w.id,
    repo: "a",
  });
  await assert.rejects(
    authorizeDelegation(f.client, {
      role: "implementer",
      bundle: w.id,
      repo: "b",
    }),
    /one execution/,
  );
  await assert.rejects(
    authorizeDelegation(f.client, {
      role: "task_lead",
      bundle: w.id,
      repo: ".",
    }),
    /do not use/,
  );
  await f.report(w);
  const status = await workStatus(f.client, w.id, true);
  assert.equal(status.status, "completed");
  assert.equal(status.completionValid, true);
  assert.equal(status.reviewValid, false);
  assert.equal(status.attempts, 0);
  await assert.rejects(
    projectAction(f.client, { action: "candidate", id: f.project.id }),
    /without Oracle/,
  );
  const p = await projectAction(f.client, {
    action: "complete",
    id: f.project.id,
  });
  assert.equal(p.status, "completed");
  assert.equal(p.requiresOracle, false);
  assert.equal(p.oracleValid, false);
});
test("single completion rejects missing evidence, unfinished reports and stale contracts", async (t) => {
  const f = await fixture(t),
    w = await f.make(),
    r = await f.report(w, { checks: [] });
  await assert.rejects(workStatus(f.client, w.id, true), /actual checks/);
  await writeJSON(path.join(r.record.dir, `${r.jobId}.result.json`), {
    jobId: r.jobId,
    status: "settled",
    brief: { ...r.brief, checks: ["checked"], references: [] },
  });
  await assert.rejects(workStatus(f.client, w.id, true), /evidence/);
  await reviseWork(f.client, w.id, "Revised scope");
  await assert.rejects(workStatus(f.client, w.id, true), /current settled/);
});
test("single receipts become stale on artifact or project requirement changes", async (t) => {
  const f = await fixture(t),
    w = await f.make();
  await f.report(w);
  await workStatus(f.client, w.id, true);
  await fs.writeFile(path.join(f.root, "a/hello.txt"), "later");
  assert.equal((await workStatus(f.client, w.id)).completionValid, false);
  await assert.rejects(
    projectAction(f.client, { action: "complete", id: f.project.id }),
    /stale/,
  );
  await fs.writeFile(path.join(f.root, "a/hello.txt"), "before");
  await projectAction(f.client, {
    action: "revise",
    id: f.project.id,
    requirements: "Different goal",
  });
  assert.equal((await workStatus(f.client, w.id)).completionValid, false);
});
test("escalation blocks single completion; promotion retains baseline and budget", async (t) => {
  const f = await fixture(t),
    w = await f.make(),
    r = await f.report(w);
  const before = await getWork(f.scope, w.id);
  await writeJSON(path.join(r.record.dir, `${r.jobId}.review-required.json`), {
    reason: "Shared contract",
  });
  await assert.rejects(workStatus(f.client, w.id, true), /Promote/);
  await promoteWork(f.client, w.id, "Shared contract discovered");
  const after = await getWork(f.scope, w.id);
  assert.deepEqual(after.repos, before.repos);
  assert.equal(after.reviewLimit, before.reviewLimit);
  await assert.rejects(workStatus(f.client, w.id, true), /Reviewer PASS/);
  await taskCandidate(f.client, w.id);
  await authorizeDelegation(f.client, {
    role: "reviewer",
    bundle: w.id,
    repo: ".",
  });
});
test("promoted direct task requires real independent inspection, then Oracle", async (t) => {
  const f = await fixture(t),
    w = await f.make();
  await fs.writeFile(path.join(f.root, "a/hello.txt"), "after");
  await f.report(w);
  await promoteWork(f.client, w.id, "Independent review requested");
  await taskCandidate(f.client, w.id);
  const review = await f.report(
    { ...w, executionRepo: "." },
    { role: "reviewer" },
  );
  const request = { role: "reviewer", bundle: w.id, contract: review.contract };
  await assert.rejects(
    validateReviewTarget(request, review.record.dir, review.jobId),
    /Inspect actual/,
  );
  const roster = await inspectHierarchyReview(request, { repo: "a" });
  assert.ok(roster.changed.length);
  const evidence = {
    a: {
      target: review.contract.review.targets.a.target,
      files: { "hello.txt": { complete: true } },
    },
  };
  await writeJSON(
    path.join(review.record.dir, `${review.jobId}.inspection.json`),
    evidence,
  );
  const approved = await validateReviewTarget(
    request,
    review.record.dir,
    review.jobId,
  );
  await writeJSON(path.join(review.record.dir, `${review.jobId}.result.json`), {
    jobId: review.jobId,
    status: "settled",
    brief: { ...review.brief, verdict: "pass" },
    review: approved,
  });
  const status = await workStatus(f.client, w.id, true);
  assert.equal(status.reviewValid, true);
  await assert.rejects(
    projectAction(f.client, { action: "complete", id: f.project.id }),
    /Oracle PASS/,
  );
  assert.equal(
    (await projectAction(f.client, { action: "candidate", id: f.project.id }))
      .status,
    "candidate",
  );
});
test("root administrative work has no source snapshot; multi-repo single work has one root executor", async (t) => {
  const f = await fixture(t);
  const w = await f.make({ project: undefined, repos: [] });
  const saved = await getWork(f.scope, w.id);
  assert.equal(saved.executionRepo, ".");
  assert.deepEqual(saved.repos, {});
  await authorizeDelegation(f.client, {
    role: "implementer",
    bundle: w.id,
    repo: ".",
  });
  await assert.rejects(f.make(), /unfinished task/);
  await f.report(w);
  await workStatus(f.client, w.id, true);
  assert.equal(
    (await projectAction(f.client, { action: "status", id: saved.project }))
      .status,
    "completed",
  );
  await assert.rejects(
    promoteWork(f.client, w.id, "Need code review"),
    /no code baseline/,
  );
  const multi = await f.make({ repos: ["a", "b"] });
  assert.equal(multi.executionRepo, ".");
  await authorizeDelegation(f.client, {
    role: "implementer",
    bundle: multi.id,
    repo: ".",
  });
});
test("legacy and explicit reviewed tasks never permit direct execution or ungated completion", async (t) => {
  const f = await fixture(t),
    w = await f.make({ executionMode: "reviewed", executionReason: undefined });
  await assert.rejects(
    authorizeDelegation(f.client, {
      role: "implementer",
      bundle: w.id,
      repo: "a",
    }),
    /Task Lead/,
  );
  await assert.rejects(workStatus(f.client, w.id, true), /Task Lead/);
  await assert.rejects(
    projectAction(f.client, { action: "complete", id: f.project.id }),
    /incomplete/,
  );
});
test("reopening root operations cannot overlap unfinished repository work", async (t) => {
  const f = await fixture(t);
  const rootWork = await f.make({ project: undefined, repos: [] });
  await f.report(rootWork);
  await workStatus(f.client, rootWork.id, true);
  const repoWork = await f.make();
  await assert.rejects(
    reviseWork(f.client, rootWork.id, "Another administrative operation"),
    /Another unfinished task/,
  );
  await f.report(repoWork);
  await workStatus(f.client, repoWork.id, true);
  await reviseWork(f.client, rootWork.id, "Another administrative operation");
  await assert.rejects(
    reviseWork(f.client, repoWork.id, "Another text change"),
    /Another unfinished task/,
  );
});
test("direct review candidacy rejects stale project requirements before review dispatch", async (t) => {
  const f = await fixture(t),
    w = await f.make();
  await f.report(w);
  await promoteWork(f.client, w.id, "Independent review required");
  await projectAction(f.client, {
    action: "revise",
    id: f.project.id,
    requirements: "Updated project requirements",
  });
  await assert.rejects(
    taskCandidate(f.client, w.id),
    /Project requirements changed/,
  );
  assert.equal((await getWork(f.scope, w.id)).reviews.length, 0);
});

test("single receipt preserves unrelated changes and cannot re-certify stale completed work", async (t) => {
  const f = await fixture(t),
    w = await f.make();
  await f.report(w);
  await workStatus(f.client, w.id, true);
  await fs.writeFile(path.join(f.root, "a/other.txt"), "unrelated");
  assert.equal((await workStatus(f.client, w.id)).completionValid, true);
  await fs.writeFile(path.join(f.root, "a/hello.txt"), "changed");
  await assert.rejects(workStatus(f.client, w.id, true), /Reopen/);
});

test("mixed project binds single receipts and reviewed approvals to the final Oracle gate", async (t) => {
  const f = await fixture(t),
    a = await f.make();
  await fs.writeFile(path.join(f.root, "a/hello.txt"), "after");
  await f.report(a);
  await workStatus(f.client, a.id, true);
  const b = await f.make({ title: "Reviewed B", repos: ["b"] });
  await f.report(b, { refs: ["b/hello.txt"] });
  await promoteWork(f.client, b.id, "Independent review required");
  await taskCandidate(f.client, b.id);
  const review = await f.report(
    { ...b, executionRepo: "." },
    { role: "reviewer", refs: ["b/hello.txt"] },
  );
  const req = { role: "reviewer", bundle: b.id, contract: review.contract };
  await writeJSON(
    path.join(review.record.dir, `${review.jobId}.inspection.json`),
    { b: { target: review.contract.review.targets.b.target, files: {} } },
  );
  const approved = await validateReviewTarget(
    req,
    review.record.dir,
    review.jobId,
  );
  await writeJSON(path.join(review.record.dir, `${review.jobId}.result.json`), {
    jobId: review.jobId,
    status: "settled",
    brief: { ...review.brief, verdict: "pass" },
    review: approved,
  });
  await workStatus(f.client, b.id, true);
  await assert.rejects(
    projectAction(f.client, { action: "complete", id: f.project.id }),
    /Oracle PASS/,
  );
  await projectAction(f.client, { action: "candidate", id: f.project.id });
  const oracle = {
      id: randomUUID(),
      dir: path.join(f.scope, "oracle"),
      role: "oracle",
      repo: ".",
    },
    job = randomUUID();
  const contract = await prepareAssignment(
    f.client,
    oracle,
    job,
    "oracle",
    f.project.id,
  );
  assert.equal(
    contract.taskApprovals.find((task) => task.id === a.id).reviewJob,
    null,
  );
  assert.equal(
    contract.taskApprovals.find((task) => task.id === a.id).executionMode,
    "single",
  );
  const coverage = Object.fromEntries(
    Object.entries(contract.review.targets).map(([repo, target]) => [
      repo,
      { target: target.target, files: { "hello.txt": { complete: true } } },
    ]),
  );
  await writeJSON(path.join(oracle.dir, `${job}.inspection.json`), coverage);
  const oracleReview = await validateReviewTarget(
    { role: "oracle", contract },
    oracle.dir,
    job,
  );
  await writeJSON(path.join(oracle.dir, `${job}.result.json`), {
    jobId: job,
    status: "settled",
    brief: {
      outcome: "completed",
      summary: "Integrated",
      checks: ["Both tasks checked"],
      references: ["a/hello.txt", "b/hello.txt"],
      verdict: "pass",
    },
    review: oracleReview,
  });
  assert.equal(
    (await projectAction(f.client, { action: "complete", id: f.project.id }))
      .status,
    "completed",
  );
  await fs.writeFile(
    path.join(f.root, "a/hello.txt"),
    "unreviewed later change",
  );
  await assert.rejects(
    projectAction(f.client, { action: "complete", id: f.project.id }),
    /stale/,
  );
});
