import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readJSON, writeJSON } from "./storage.mjs";
import { liveness } from "./lifecycle.mjs";
import {
  getWork,
  getProject,
  requireClassifiedInputs,
  workStatus,
} from "./hierarchy.mjs";
import { requireProgress } from "./documents.mjs";
import { reviewTargetMatches } from "./workflow.mjs";

const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
// An unfinished slot may move to one new, independent process. This never grants
// PASS, revises scope, repeats implementation, or creates/renumbers a review slot.
export async function prepareReviewContinuation(client, role, id) {
  if (!["reviewer", "oracle"].includes(role))
    throw Error("Only independent reviews can continue.");
  const scope = client.workScope;
  const value =
    role === "reviewer"
      ? await getWork(scope, id)
      : await getProject(scope, id);
  if (
    role === "reviewer"
      ? client.delegation
        ? client.delegation.bundle !== id
        : !value.directManager
      : Boolean(client.delegation)
  )
    throw Error(
      "Only the assigned Task Lead (or direct-task Orchestrator) continues task review; only Orchestrator continues Oracle.",
    );
  requireClassifiedInputs(value);
  await requireProgress(client.root, scope);
  const review = value.reviews.at(-1);
  if (!review || review.continuations?.length >= 1)
    throw Error(
      "This review slot has no unused continuation. Inspect its recorded process/report; another continuation requires explicit review-budget handling.",
    );
  const request = await readJSON(path.join(review.dir, "request.json"));
  const report = await readJSON(
    path.join(review.dir, `${review.jobId}.result.json`),
  );
  if (
    request?.jobId !== review.jobId ||
    request.role !== role ||
    request.bundle !== id ||
    request.contract?.root !== client.root ||
    JSON.stringify(request.contract.review) !== JSON.stringify(review) ||
    report?.status !== "needs-report"
  )
    throw Error(
      "Continue only the exact unfinished independent review slot; no accepted verdict or new review is replayed.",
    );
  const ready = await readJSON(path.join(review.dir, "ready.json"));
  if (liveness(ready?.instance) !== "dead")
    throw Error(
      "Old Reviewer must be confirmed dead before a fresh process continues its slot.",
    );
  const root = await fs.realpath(path.dirname(client.scope));
  if (
    (await fs.realpath(review.dir)) !== review.dir ||
    !review.dir.startsWith(root + path.sep)
  )
    throw Error("Review evidence is outside this root's managed storage.");
  if (
    value.revision !== review.requirementsRevision ||
    (value.noteRevision ?? 0) !== review.noteRevision ||
    (value.inputRevision ?? 0) !== review.inputRevision
  )
    throw Error(
      "Review contract changed; a continuation cannot bypass a new review attempt.",
    );
  const project =
    role === "oracle" ? value : await getProject(scope, value.project);
  if (project.revision !== review.projectBinding.revision)
    throw Error(
      "Project contract changed; do not continue an obsolete review.",
    );
  for (const target of Object.values(review.targets)) {
    if (!(await reviewTargetMatches(target)))
      throw Error(
        "Reviewed artifacts changed; a continuation cannot bypass the review budget.",
      );
  }
  for (const approval of request.contract.taskApprovals ?? []) {
    const task = await getWork(scope, approval.id);
    if (
      !(await workStatus(client, task.id)).completionValid ||
      task.status !== "completed" ||
      task.revision !== approval.revision ||
      task.noteRevision !== approval.noteRevision ||
      (task.reviews.at(-1)?.jobId ?? null) !== approval.reviewJob
    )
      throw Error(
        "Oracle's task approval set changed; do not continue an obsolete review.",
      );
  }
  return {
    id,
    role,
    kind: role === "oracle" ? "projects" : "work",
    source: review.dir,
    requestHash: fingerprint(request),
    slotHash: fingerprint(review),
    originalJobId: review.jobId,
  };
}
export async function attachReviewContinuation(client, plan, record) {
  const checked = await prepareReviewContinuation(client, plan.role, plan.id);
  if (
    checked.slotHash !== plan.slotHash ||
    checked.requestHash !== plan.requestHash
  )
    throw Error(
      "Continuation source changed during launch; no work submitted.",
    );
  const request = await readJSON(path.join(plan.source, "request.json"));
  const value =
    plan.kind === "work"
      ? await getWork(client.workScope, plan.id)
      : await getProject(client.workScope, plan.id);
  const original = value.reviews.at(-1);
  const review = {
    ...original,
    agentId: record.id,
    dir: record.dir,
    continuations: [
      {
        fromAgent: original.agentId,
        fromDir: original.dir,
        toAgent: record.id,
        toDir: record.dir,
        jobId: original.jobId,
        originalSlotHash: plan.slotHash,
        originalRequestHash: plan.requestHash,
        at: new Date().toISOString(),
      },
    ],
  };
  const contract = { ...request.contract, review };
  // Retain only host-issued read/dependency receipts. The new process must decide
  // independently and submit its own verdict; an old PASS draft is not copied.
  for (const suffix of ["inspection.json", "scope.json"]) {
    const evidence = await readJSON(
      path.join(plan.source, `${review.jobId}.${suffix}`),
    );
    if (evidence)
      await writeJSON(
        path.join(record.dir, `${review.jobId}.${suffix}`),
        evidence,
      );
  }
  value.reviews[value.reviews.length - 1] = review;
  value.status = "reviewing";
  if (plan.kind === "work")
    value.members.push({
      id: record.id,
      dir: record.dir,
      role: "reviewer",
      repo: ".",
    });
  await writeJSON(
    path.join(client.workScope, plan.kind, plan.id + ".json"),
    value,
  );
  return contract;
}
