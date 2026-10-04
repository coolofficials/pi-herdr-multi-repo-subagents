import { executionMode, executionSelection } from "./routing.mjs";
import { reviewProgress } from "./progress.mjs";
import { registerProgress, requireProgress } from "./documents.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { readJSON, writeJSON } from "./storage.mjs";
import { resolveRepo } from "./core.mjs";
import {
  approvalScopeValid,
  taskApprovalScope,
  approvalScopeStatus,
  fileState,
} from "./approval.mjs";
import { executionState } from "./execution.mjs";
import { snapshot, reviewChanges, reviewTargetMatches } from "./workflow.mjs";
import { publicReport } from "./contracts.mjs";
import { liveness } from "./lifecycle.mjs";

const scopeOf = (client) => client.workScope ?? client.scope;
const idCheck = (id) => {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
    throw new Error("Invalid work/project ID.");
  return id;
};
const fileOf = (scope, kind, id) =>
  path.join(scope, kind, `${idCheck(id)}.json`);
const save = (scope, kind, value) =>
  writeJSON(fileOf(scope, kind, value.id), value);
const hash = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);
export async function getWork(scope, id) {
  const work = await readJSON(fileOf(scope, "work", id));
  if (!work || work.schema !== 2)
    throw new Error(
      "Unknown hierarchical task. Finish v0.4 work in its original version; it is not migrated automatically.",
    );
  return work;
}
export async function getProject(scope, id) {
  const project = await readJSON(fileOf(scope, "projects", id));
  if (!project) throw new Error("Unknown project work.");
  return project;
}
const assertRoot = (client) => {
  if (client.delegation)
    throw new Error(
      "Only the Orchestrator owns project requirements and task assignment.",
    );
};
export function assertTaskOwner(client, id) {
  if (client.delegation?.bundle !== id)
    throw new Error("Only the assigned Task Lead may advance this task.");
}
const validateRequirements = (text) => {
  if (typeof text !== "string" || !text.trim() || text.length > 8000)
    throw new Error("Requirements must contain 1–8000 characters.");
};
async function readRecords(scope, kind) {
  const files = await fs.readdir(path.join(scope, kind)).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const result = [];
  for (const file of files.filter((name) =>
    /^[a-f0-9-]{36}\.json$/.test(name),
  )) {
    const value = await readJSON(path.join(scope, kind, file));
    if (value) result.push(value);
  }
  return result;
}
export async function listWork(scope) {
  return (await readRecords(scope, "work"))
    .filter((w) => w.schema === 2)
    .map((w) => ({
      id: w.id,
      project: w.project,
      title: w.title,
      status: w.status,
      repos: Object.keys(w.repos),
      executionMode: executionMode(w),
      executionReason: w.executionReason,
      rootOperation: w.rootOperation ?? false,
    }));
}
export async function listProjects(scope) {
  return (await readRecords(scope, "projects")).map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    tasks: p.tasks,
  }));
}
export async function createProject(
  client,
  { title, requirements, progressDocuments = /** @type {string[]} */ ([]) },
) {
  assertRoot(client);
  if (client.lifecycle?.status().workflowRecovery?.status === "blocked")
    throw Error(
      "Prior workflow recovery is blocked. Use repo_workflow status/history/restore; do not create replacement work to reset its review budget.",
    );
  validateRequirements(requirements);
  if (!title?.trim() || title.length > 160)
    throw new Error("Provide a project title up to 160 characters.");
  const p = {
    id: randomUUID(),
    schema: 2,
    title,
    requirements,
    revision: 1,
    tasks: [],
    reviews: [],
    reviewLimit: 3,
    status: "working",
    createdAt: new Date().toISOString(),
  };
  await registerProgress(client.root, scopeOf(client), p.id, progressDocuments);
  await save(scopeOf(client), "projects", p);
  return p;
}
async function idleMembers(client, members, ignoreId) {
  for (const member of members ?? []) {
    if (member.id === ignoreId) continue;
    if (
      member.workflowRetirement &&
      (liveness(member.workflowRetirement.instance) === "dead" ||
        (member.workflowRetirement.recovered &&
          (await readJSON(path.join(member.dir, "recovered.json")))))
    )
      continue;
    const state = await executionState(member);
    if (state.phase === "recovered") continue;
    if (state.pending)
      throw new Error(
        `Agent ${member.id} has unfinished work (${state.phase}); inspect or recover its confirmed exit.`,
      );
    if (state.ready?.cleanExit && liveness(state.ready.instance) === "dead")
      continue;
    const live = (await client.call(["agent", "get", member.id])).result?.agent;
    if (!["idle", "done"].includes(live?.status ?? live?.agent_status))
      throw new Error(`Agent ${member.id} is busy or unavailable.`);
  }
}
export async function retireRecoveredMember(scope, record) {
  for (const item of await listWork(scope)) {
    const work = await getWork(scope, item.id);
    const member = work.members.find((m) => m.id === record.id);
    const isLead = work.lead?.id === record.id;
    if (!member && !isLead) continue;
    if (member) member.retired = true;
    if (isLead) work.lead.retired = true;
    work.recoveries ??= [];
    if (!work.recoveries.some((r) => r.id === record.id))
      work.recoveries.push({ id: record.id, at: new Date().toISOString() });
    await save(scope, "work", work);
  }
}
export async function createWork(
  client,
  {
    project = /** @type {string | undefined} */ (undefined),
    title = /** @type {string | undefined} */ (undefined),
    requirements = /** @type {string | undefined} */ (undefined),
    repos = /** @type {string[]} */ ([]),
    executionMode: selectedMode = "reviewed",
    executionReason = /** @type {string|undefined} */ (undefined),
  },
) {
  assertRoot(client);
  const route = executionSelection(selectedMode, executionReason);
  validateRequirements(requirements);
  if (
    !title?.trim() ||
    title.length > 160 ||
    (!repos.length && selectedMode !== "single") ||
    repos.length > 12
  )
    throw new Error("Provide a task title and 1–12 repositories.");
  const standalone = !project && selectedMode === "single";
  if (standalone)
    project = (await createProject(client, { title, requirements })).id;
  const scope = scopeOf(client),
    p = await getProject(scope, project);
  if (p.tasks.length >= 32)
    throw new Error(
      "A project supports at most 32 coherent tasks; split larger initiatives into projects.",
    );
  if (p.status === "completed")
    throw new Error("Reopen/revise the project before adding work.");
  if (p.status === "reviewing") {
    const last = p.reviews.at(-1);
    await idleMembers(client, [{ id: last.agentId, dir: last.dir }]);
  }
  const selected = await Promise.all(
    [...new Set(repos)].map((r) => resolveRepo(client.root, r)),
  );
  for (const item of await listWork(scope)) {
    if (
      item.status !== "completed" &&
      (!selected.length ||
        item.rootOperation ||
        item.repos.some((r) => selected.some((x) => x.repo === r)))
    )
      throw new Error(
        "An unfinished task owns a requested repository. Finish that task first; tasks sharing a checkout are serialized.",
      );
  }
  await idleMembers(
    client,
    (await client.records()).filter((r) =>
      selected.some((x) => x.path === r.path),
    ),
  );
  const work = {
    id: randomUUID(),
    schema: 2,
    project,
    projectRevision: p.revision,
    title,
    requirements,
    revision: 1,
    status: "working",
    ...route,
    directManager: selectedMode === "single",
    executionRepo: selected.length === 1 ? selected[0].repo : ".",
    rootOperation: selected.length === 0,
    repos: Object.create(null),
    reviews: [],
    reviewLimit: 3,
    members: [],
    notes: "",
    noteRevision: 0,
    createdAt: new Date().toISOString(),
  };
  for (const r of selected) {
    const base = await snapshot(r.path);
    const baseline = path.join(
      scope,
      "work",
      `${work.id}-${hash(r.repo)}.baseline.json`,
    );
    await writeJSON(baseline, base);
    work.repos[r.repo] = { path: r.path, baseline, base: base.fingerprint };
  }
  p.tasks.push(work.id);
  if (standalone) p.standalone = true;
  p.status = "working";
  await save(scope, "work", work);
  await save(scope, "projects", p);
  return {
    id: work.id,
    project,
    title,
    requirements,
    repos: Object.keys(work.repos),
    status: work.status,
    ...route,
    executionRepo: work.executionRepo,
  };
}
export async function authorizeDelegation(client, { role, bundle, repo }) {
  if (client.delegation) {
    const d = client.delegation;
    if (!["implementer", "reviewer", "scout", "researcher"].includes(role))
      throw new Error("Task Lead cannot create other leads or Oracles.");
    if (bundle !== d.bundle)
      throw new Error("Delegate only inside your assigned task.");
    const w = await getWork(scopeOf(client), bundle);
    requireClassifiedInputs(w);
    if (w.status === "completed")
      throw new Error(
        "Task is completed. Ask the Orchestrator to reopen it before new work.",
      );
    if (repo !== "." && !w.repos[repo])
      throw new Error("Repository is outside this task.");
    if (repo === "." && !["reviewer", "scout", "researcher"].includes(role))
      throw new Error(
        "Implementation/verification must run in an assigned repository.",
      );
    if (role === "reviewer" && repo !== ".")
      throw new Error(
        "Review the whole task from repo='.' in an independent reviewer pane.",
      );
    if (role === "reviewer" && w.status !== "candidate")
      throw new Error(
        "Task Lead must explicitly declare completion candidacy before review.",
      );
    if (role === "reviewer" && w.reviews.length >= w.reviewLimit)
      throw new Error(
        "Task review budget exhausted; ask the user to extend it.",
      );
    if (["implementer"].includes(role) && w.status === "reviewing")
      await idleMembers(
        client,
        w.members.filter((m) => m.role === "reviewer"),
      );
  } else {
    if (["implementer", "reviewer"].includes(role)) {
      const w = await getWork(scopeOf(client), bundle);
      if (!w.directManager)
        throw Error(
          "Orchestrator delegates implementation and local review through a Task Lead.",
        );
      if (w.status === "completed")
        throw Error("Reopen the task before requesting further work.");
      if ((await getProject(scopeOf(client), w.project)).status === "reviewing")
        throw Error("Finish Oracle review before changing tasks.");
      if (role === "implementer" && repo !== w.executionRepo)
        throw Error(
          "Single task uses one execution agent in its assigned executionRepo.",
        );
      if (
        role === "reviewer" &&
        (repo !== "." ||
          executionMode(w) !== "reviewed" ||
          w.status !== "candidate")
      )
        throw Error(
          "Promote and declare task candidacy before independent review.",
        );
      if (role === "reviewer" && w.reviews.length >= w.reviewLimit)
        throw Error("Task review budget exhausted; ask the user to extend it.");
      if (role === "implementer" && w.status === "reviewing")
        await idleMembers(
          client,
          w.members.filter((m) => m.role === "reviewer"),
        );
    } else if (!["task_lead", "oracle", "scout", "researcher"].includes(role))
      throw Error("Unknown delegation role.");
    if (["task_lead", "oracle"].includes(role) && repo !== ".")
      throw new Error("Task Lead and Oracle run at the task root (repo='.').");
    if (role === "task_lead") {
      const w = await getWork(scopeOf(client), bundle);
      if (w.directManager)
        throw Error("Direct execution tasks do not use a Task Lead.");
      if (w.status === "completed")
        throw new Error("Reopen the task before requesting further work.");
      if ((await getProject(scopeOf(client), w.project)).status === "reviewing")
        throw new Error("Finish Oracle review before changing tasks.");
    }
    if (role === "oracle") {
      const p = await getProject(scopeOf(client), bundle);
      if (p.status !== "candidate")
        throw new Error(
          "Orchestrator must explicitly declare overall completion candidacy before Oracle review.",
        );
      if (p.reviews.length >= p.reviewLimit)
        throw new Error(
          "Oracle review budget exhausted; ask the user to extend it.",
        );
    }
    if (["scout", "researcher"].includes(role) && bundle)
      throw new Error(
        "Top-level research has no task bundle. Delegate task-specific research through its lead.",
      );
  }
}
async function makeReview(client, value, record, jobId, kind, repos) {
  const scope = scopeOf(client),
    targets = Object.create(null),
    prior = value.reviews.at(-1);
  for (const [repo, state] of Object.entries(repos)) {
    const current = await snapshot(state.path),
      targetFile = path.join(
        scope,
        kind,
        `${value.id}-${jobId}-${hash(repo)}.target.json`,
      );
    await writeJSON(targetFile, current);
    targets[repo] = {
      path: state.path,
      baseline: state.baseline,
      target: current.fingerprint,
      snapshot: targetFile,
    };
  }
  if (prior) {
    const previousEvidence = await readJSON(
      path.join(prior.dir, `${prior.jobId}.inspection.json`),
      {},
    );
    const retained = Object.create(null);
    for (const [repo, target] of Object.entries(targets)) {
      const old = prior.targets[repo];
      if (!old) continue;
      const oldSnapshot = await readJSON(old.snapshot),
        newSnapshot = await readJSON(target.snapshot);
      const files = Object.create(null);
      for (const [file, coverage] of Object.entries(
        previousEvidence[repo]?.files ?? {},
      )) {
        if (
          coverage.complete &&
          oldSnapshot.entries[file]?.hash === newSnapshot.entries[file]?.hash &&
          oldSnapshot.entries[file]?.mode === newSnapshot.entries[file]?.mode
        )
          files[file] = coverage;
      }
      retained[repo] = { target: target.target, files };
    }
    await writeJSON(
      path.join(record.dir, `${jobId}.inspection.json`),
      retained,
    );
  }
  const project =
    kind === "projects" ? value : await getProject(scope, value.project);
  const progressEvidence = {};
  const previousScope =
    prior &&
    (await readJSON(path.join(prior.dir, `${prior.jobId}.scope.json`)));
  for (const file of Object.keys(previousScope?.files ?? {}))
    progressEvidence[file] = await fileState(client.root, file);
  for (const member of value.members ?? []) {
    const checks = await fs
      .readdir(path.join(member.dir, "checks"))
      .catch(() => []);
    for (const name of checks.filter((n) => n.endsWith(".result.json"))) {
      const check = await readJSON(path.join(member.dir, "checks", name));
      if (check)
        progressEvidence[`check:${member.repo}:${check.command}`] = {
          exitCode: check.exitCode,
          hash: check.hash,
          complete: check.complete,
        };
    }
  }
  await reviewProgress(scope, kind, value, targets, project, progressEvidence);
  const review = {
    projectBinding: { scope, id: project.id, revision: project.revision },
    workScope: scope,
    kind,
    id: value.id,
    jobId,
    agentId: record.id,
    dir: record.dir,
    attempt: value.reviews.length + 1,
    limit: value.reviewLimit,
    requirementsRevision: value.revision,
    noteRevision: value.noteRevision ?? 0,
    inputRevision: value.inputRevision ?? 0,
    executionMode: executionMode(value),
    targets,
  };
  value.reviews.push(review);
  value.status = "reviewing";
  await save(scope, kind, value);
  return {
    root: client.root,
    requirements: value.requirements,
    originalRequirements:
      value.history?.[0]?.requirements ?? value.requirements,
    notes: value.notes ?? "",
    review,
    previousReview: prior
      ? {
          targets: prior.targets,
          scope:
            (await readJSON(path.join(prior.dir, `${prior.jobId}.result.json`)))
              ?.review?.approvalScope ??
            (await readJSON(path.join(prior.dir, `${prior.jobId}.scope.json`))),
          brief:
            publicReport(
              await readJSON(
                path.join(prior.dir, `${prior.jobId}.result.json`),
              ),
            )?.brief ?? null,
        }
      : null,
  };
}
export async function prepareAssignment(client, record, jobId, role, bundle) {
  const scope = scopeOf(client);
  if (role === "oracle") {
    const p = await getProject(scope, bundle),
      tasks = await approvedTasks(client, p);
    const repos = Object.create(null);
    for (const w of tasks)
      for (const [r, s] of Object.entries(w.repos)) repos[r] ??= s;
    const contract = await makeReview(
      client,
      p,
      record,
      jobId,
      "projects",
      repos,
    );
    contract.project = bundle;
    contract.taskApprovals = tasks.map((w) => ({
      id: w.id,
      revision: w.revision,
      noteRevision: w.noteRevision,
      reviewJob: w.reviews.at(-1)?.jobId ?? null,
      requirements: w.requirements,
      notes: w.notes,
      brief: w.completionBrief,
      executionMode: executionMode(w),
    }));
    // Persist the exact task approval set in the oracle contract and project review.
    p.reviews.at(-1).taskApprovals = contract.taskApprovals.map(
      ({ id, revision, noteRevision, reviewJob }) => ({
        id,
        revision,
        noteRevision,
        reviewJob,
      }),
    );
    contract.review.taskApprovals = p.reviews.at(-1).taskApprovals;
    await save(scope, "projects", p);
    return contract;
  }
  if (!bundle) return null;
  const w = await getWork(scope, bundle);
  if (role === "task_lead") {
    if (w.lead && w.lead.id !== record.id) {
      const ready = await readJSON(path.join(w.lead.dir, "ready.json"));
      const retired = await readJSON(path.join(w.lead.dir, "recovered.json"));
      if (
        (!retired &&
          !(
            w.lead.workflowRetirement &&
            liveness(w.lead.workflowRetirement.instance) === "dead"
          ) &&
          (!ready?.cleanExit || liveness(ready?.instance) !== "dead")) ||
        (await client.records()).some((r) => r.id === w.lead.id)
      )
        throw new Error(
          "Task already has a lead. Resume it, or explicitly recover/forget its confirmed dead process after inspecting descendants.",
        );
      await idleMembers(client, w.members);
    }
    w.lead = { id: record.id, dir: record.dir };
    await save(scope, "work", w);
    return {
      bundle,
      requirements: w.requirements,
      originalRequirements: w.history?.[0]?.requirements ?? w.requirements,
      requirementsRevision: w.revision,
      notes: w.notes,
      repos: Object.keys(w.repos),
      project: w.project,
    };
  }
  const member = { id: record.id, dir: record.dir, role, repo: record.repo };
  if (w.directManager && role === "implementer")
    w.executor = { ...member, jobId };
  if (!w.members.some((m) => m.id === record.id)) w.members.push(member);
  if (role === "reviewer") {
    await idleMembers(client, w.members, record.id);
    await save(scope, "work", w);
    const contract = await makeReview(
      client,
      w,
      record,
      jobId,
      "work",
      w.repos,
    );
    return { ...contract, bundle };
  }
  if (["implementer"].includes(role)) w.status = "working";
  await save(scope, "work", w);
  return {
    bundle,
    requirements: w.requirements,
    originalRequirements: w.history?.[0]?.requirements ?? w.requirements,
    requirementsRevision: w.revision,
    notes: w.notes,
    repos: Object.keys(w.repos),
    root: client.root,
    workScope: scope,
    projectRevision:
      w.projectRevision ?? (await getProject(scope, w.project)).revision,
    executionMode: executionMode(w),
    executionReason: w.executionReason,
    directManager: w.directManager ?? false,
  };
}
async function reviewValid(value) {
  if (executionMode(value) === "single") return false;
  const latest = value.reviews.at(-1);
  if (!latest) return false;
  const report = await readJSON(
    path.join(latest.dir, `${latest.jobId}.result.json`),
  );
  if (
    value.pendingInput ||
    latest.inputRevision !== (value.inputRevision ?? 0) ||
    report?.status !== "settled" ||
    report?.brief?.outcome !== "completed" ||
    report?.brief?.verdict !== "pass" ||
    report?.review?.jobId !== latest.jobId ||
    latest.requirementsRevision !== value.revision ||
    latest.noteRevision !== (value.noteRevision ?? 0) ||
    (value.tasks &&
      JSON.stringify(latest.taskApprovals?.map((t) => t.id)) !==
        JSON.stringify(value.tasks))
  )
    return false;
  if (!value.tasks && report.review.approvalScope) {
    if (!(await approvalScopeValid(report.review.approvalScope))) return false;
  } else {
    for (const s of Object.values(latest.targets))
      if (!(await reviewTargetMatches(s))) return false;
  }
  if (value.tasks) {
    for (const approval of latest.taskApprovals ?? []) {
      const task = await getWork(latest.workScope, approval.id);
      if (
        task.status !== "completed" ||
        task.revision !== approval.revision ||
        task.noteRevision !== approval.noteRevision ||
        (task.reviews.at(-1)?.jobId ?? null) !== approval.reviewJob ||
        !(await completionValid(task))
      )
        return false;
    }
  }
  return true;
}
async function directReport(work) {
  const executor = work.executor;
  if (!executor) throw Error("Direct task has no execution agent report.");
  const state = await executionState(executor);
  if (
    state.pending ||
    state.phase !== "settled" ||
    state.request?.jobId !== executor.jobId ||
    state.request?.bundle !== work.id ||
    state.request?.contract?.requirementsRevision !== work.revision ||
    state.request?.contract?.projectRevision !== work.projectRevision ||
    state.report?.brief?.outcome !== "completed" ||
    !state.report.brief.checks?.length ||
    !state.report.brief.references?.length
  )
    throw Error(
      "Direct completion needs the current settled Implementer report with actual checks and evidence references.",
    );
  if (
    executionMode(work) === "single" &&
    (await readJSON(
      path.join(executor.dir, `${executor.jobId}.review-required.json`),
    ))
  )
    throw Error(
      "Execution requested independent review. Promote this task; single completion is blocked.",
    );
  return state.report;
}
async function completionValid(work) {
  if (executionMode(work) !== "single") return reviewValid(work);
  if (
    work.status !== "completed" ||
    !work.singleCompletion ||
    work.pendingInput ||
    work.escalation
  )
    return false;
  try {
    const report = await directReport(work);
    const receipt = work.singleCompletion;
    const project = await getProject(receipt.scope, work.project);
    if (
      receipt.jobId !== report.jobId ||
      receipt.revision !== work.revision ||
      receipt.projectRevision !== project.revision
    )
      return false;
    for (const [file, expected] of Object.entries(receipt.files))
      if (
        JSON.stringify(await fileState(receipt.root, file)) !==
        JSON.stringify(expected)
      )
        return false;
    return true;
  } catch {
    return false;
  }
}
async function completeDirectWork(client, work) {
  const scope = scopeOf(client);
  await requireProgress(client.root, scope);
  requireClassifiedInputs(work);
  await idleMembers(client, work.members);
  const project = await getProject(scope, work.project);
  if (work.status === "completed") {
    if (!(await completionValid(work)))
      throw Error(
        "Completed task evidence is stale. Reopen before accepting new work.",
      );
    return workStatus(client, work.id);
  }
  if (project.status === "reviewing")
    throw Error("Finish Oracle before changing task state.");
  if (project.revision !== work.projectRevision)
    throw Error(
      "Project requirements changed; revise and resume this task before completion.",
    );
  const report = await directReport(work);
  if (executionMode(work) === "reviewed" && !(await reviewValid(work)))
    throw Error(
      "Direct task completion requires a current independent Reviewer PASS.",
    );
  if (executionMode(work) === "single") {
    const files = Object.create(null);
    for (const [repo, state] of Object.entries(work.repos)) {
      const base = await readJSON(state.baseline),
        current = await snapshot(state.path);
      for (const file of new Set([
        ...Object.keys(base.entries),
        ...Object.keys(current.entries),
      ])) {
        const before = base.entries[file],
          after = current.entries[file];
        if (before?.hash !== after?.hash || before?.mode !== after?.mode)
          files[path.join(repo, file)] = after
            ? { hash: after.hash, mode: after.mode }
            : null;
      }
    }
    const request = await readJSON(
      path.join(work.executor.dir, "request.json"),
    );
    for (const instruction of request.contract.instructions ?? [])
      files[instruction.file] = await fileState(client.root, instruction.file);
    for (const ref of report.brief.references ?? []) {
      if (Object.keys(work.repos).some((repo) => ref.startsWith(repo + "/"))) {
        try {
          files[ref] = await fileState(client.root, ref);
        } catch {
          /* Non-file artifact references stay in the report. */
        }
      }
    }
    work.singleCompletion = {
      scope,
      root: client.root,
      jobId: report.jobId,
      revision: work.revision,
      projectRevision: project.revision,
      files,
    };
  }
  work.status = "completed";
  work.completedAt = new Date().toISOString();
  work.completionBrief = publicReport(report)?.brief;
  await save(scope, "work", work);
  for (const member of work.members.filter((m) => m.role === "implementer"))
    await writeJSON(path.join(member.dir, "retired.json"), {
      reason: "task-completed",
      at: new Date().toISOString(),
    });
  if (project.standalone && executionMode(work) === "single")
    await projectAction(client, { action: "complete", id: project.id });
  return workStatus(client, work.id);
}
export async function promoteWork(client, id, reason) {
  assertRoot(client);
  executionSelection("single", reason);
  const scope = scopeOf(client),
    work = await getWork(scope, id);
  await requireProgress(client.root, scope);
  const project = await getProject(scope, work.project);
  if (project.status === "reviewing")
    throw Error("Finish Oracle before promoting a task.");
  await idleMembers(client, work.members);
  if (work.lead) await idleMembers(client, [work.lead]);
  if (executionMode(work) === "reviewed") return workStatus(client, id);
  if (!Object.keys(work.repos).length)
    throw Error(
      "Root administrative work has no code baseline. Create a reviewed task in the affected repositories before code edits; preserve this operation's evidence.",
    );
  work.executionMode = "reviewed";
  work.executionReason = reason.trim();
  work.routeHistory ??= [];
  work.routeHistory.push({
    mode: "reviewed",
    reason: reason.trim(),
    at: new Date().toISOString(),
  });
  work.status = "working";
  project.status = "working";
  await save(scope, "work", work);
  await save(scope, "projects", project);
  return {
    ...(await workStatus(client, id)),
    instruction:
      "Original baselines, reports, pane and review budget retained. If the executor already delivered completed work, request Reviewer directly; otherwise resume that executor, then request Reviewer. No Task Lead is needed.",
  };
}
export async function approvalStatus(value) {
  if (executionMode(value) === "single")
    return {
      valid: false,
      reason: "single_execution_not_independently_reviewed",
      nextAction: "inspect_execution_report",
    };
  if (await reviewValid(value)) return { valid: true };
  const latest = value.reviews.at(-1);
  if (!latest)
    return {
      valid: false,
      reason: "review_missing",
      nextAction: "request_review",
    };
  const report = await readJSON(
    path.join(latest.dir, `${latest.jobId}.result.json`),
  );
  if (report?.status === "needs-report")
    return {
      valid: false,
      reason: "report_missing",
      nextAction: "repair_report",
    };
  if (
    latest.requirementsRevision !== value.revision ||
    latest.noteRevision !== (value.noteRevision ?? 0)
  )
    return {
      valid: false,
      reason: "contract_changed",
      nextAction: "review_changed_scope",
    };
  if (report?.review?.approvalScope) {
    const status = await approvalScopeStatus(report.review.approvalScope);
    if (!status.valid) return status;
  }
  return {
    valid: false,
    reason: "review_not_approved",
    nextAction: "inspect_review",
    preserved: ["execution-records"],
  };
}
export async function workStatus(client, id, complete = false, commit = true) {
  if (client.delegation) assertTaskOwner(client, id);
  const scope = scopeOf(client),
    w = await getWork(scope, id);
  if (complete && w.directManager) {
    assertRoot(client);
    return completeDirectWork(client, w);
  }
  if (complete) {
    await requireProgress(client.root, scope);
    assertTaskOwner(client, id);
    requireClassifiedInputs(w);
    await idleMembers(client, w.members);
    if (!(await reviewValid(w)))
      throw new Error(
        "Task completion requires a current independent Reviewer PASS for actual artifacts and current requirements/decisions.",
      );
    if (!commit)
      return {
        id: w.id,
        status: w.status,
        approval: {
          task: w.id,
          revision: w.revision,
          reviewJob: w.reviews.at(-1).jobId,
        },
      };
    w.status = "completed";
    w.completedAt = new Date().toISOString();
    w.completionBrief = publicReport(
      await readJSON(
        path.join(
          w.reviews.at(-1).dir,
          `${w.reviews.at(-1).jobId}.result.json`,
        ),
      ),
    )?.brief;
    await save(scope, "work", w);
    for (const member of w.members.filter((m) =>
      ["implementer"].includes(m.role),
    ))
      await writeJSON(path.join(member.dir, "retired.json"), {
        reason: "task-approved",
        at: new Date().toISOString(),
      });
  }
  return {
    id,
    title: w.title,
    project: w.project,
    requirements: w.requirements,
    revision: w.revision,
    status: w.status,
    repos: Object.keys(w.repos),
    executionMode: executionMode(w),
    executionReason: w.executionReason,
    executionRepo: w.executionRepo,
    directManager: w.directManager ?? false,
    completionValid: await completionValid(w),
    reviewValid: await reviewValid(w),
    approvalStatus: await approvalStatus(w),
    attempts: w.reviews.length,
    reviewLimit: w.reviewLimit,
    lead: w.lead
      ? {
          retired: Boolean(w.lead.workflowRetirement),
          id: w.lead.id,
          role: "task_lead",
          instruction: w.lead.workflowRetirement
            ? "This is a retired historical Lead. Start a new task_lead for this same task ID, carrying its decisions/evidence; do not prompt or adopt the old process."
            : "Address this current lead from its owning Orchestrator; its children belong to the lead's scope.",
        }
      : null,
    latestReview: w.reviews.at(-1)
      ? { agent: w.reviews.at(-1).agentId, job: w.reviews.at(-1).jobId }
      : null,
  };
}
export async function taskCandidate(client, id) {
  const scope = scopeOf(client),
    w = await getWork(scope, id);
  if (w.directManager) assertRoot(client);
  else assertTaskOwner(client, id);
  if (executionMode(w) !== "reviewed")
    throw Error(
      "Promote single execution before requesting independent review.",
    );
  if (w.status === "completed") throw new Error("Task is already completed.");
  requireClassifiedInputs(w);
  await idleMembers(client, w.members);
  if (w.directManager) {
    if ((await getProject(scope, w.project)).revision !== w.projectRevision)
      throw Error(
        "Project requirements changed; revise the direct task before review.",
      );
    await directReport(w);
  }
  for (const repo of w.directManager
    ? [w.executionRepo]
    : Object.keys(w.repos)) {
    const implementer = w.members
      .filter(
        (m) =>
          (!m.retired || w.approvalOnly || m.workflowRetirement) &&
          m.repo === repo &&
          m.role === "implementer",
      )
      .at(-1);
    const req = implementer
      ? await readJSON(path.join(implementer.dir, "request.json"))
      : null;
    const report = req
      ? await readJSON(path.join(implementer.dir, `${req.jobId}.result.json`))
      : null;
    if (
      report?.status !== "settled" ||
      report?.brief?.outcome !== "completed" ||
      req?.contract?.requirementsRevision !== w.revision
    )
      throw new Error(
        `A completed Implementer report is required for ${repo} before candidacy.`,
      );
  }
  w.status = "candidate";
  await save(scope, "work", w);
  return {
    id,
    status: w.status,
    instruction:
      "Request the independent Reviewer now; this is not completion approval.",
  };
}
async function approvedTasks(client, p) {
  if (!p.tasks.length) throw new Error("Project has no tasks.");
  const tasks = [];
  for (const id of p.tasks) {
    const w = await getWork(scopeOf(client), id);
    requireClassifiedInputs(w);
    if (w.status !== "completed" || !(await completionValid(w)))
      throw new Error(`Task ${id} is incomplete or its approval is stale.`);
    if (w.directManager) {
      await idleMembers(client, w.members);
      await directReport(w);
      tasks.push(w);
      continue;
    }
    if (!w.lead) throw new Error("Task has no lead report.");
    await idleMembers(client, w.members);
    await idleMembers(client, [w.lead]);
    const req = await readJSON(path.join(w.lead.dir, "request.json"));
    const report =
      req &&
      (await readJSON(path.join(w.lead.dir, `${req.jobId}.result.json`)));
    if (
      report?.brief?.outcome !== "completed" ||
      report?.status !== "settled" ||
      report?.taskApproval?.revision !== w.revision ||
      report?.taskApproval?.reviewJob !== w.reviews.at(-1).jobId
    )
      throw new Error(
        "Task Lead must deliver an approved completion report before overall review.",
      );
    tasks.push(w);
  }
  return tasks;
}
export async function projectAction(
  client,
  {
    action,
    id = /** @type {string | undefined} */ (undefined),
    title = /** @type {string | undefined} */ (undefined),
    requirements = /** @type {string | undefined} */ (undefined),
    progressDocuments = /** @type {string[]} */ ([]),
  },
) {
  assertRoot(client);
  const scope = scopeOf(client);
  if (action === "create")
    return createProject(client, { title, requirements, progressDocuments });
  if (action === "list")
    return { projects: (await listProjects(scope)).slice(-50) };
  const p = await getProject(scope, id);
  if (
    ["candidate", "complete", "revise"].includes(action) &&
    p.status === "reviewing"
  ) {
    const latest = p.reviews.at(-1);
    await idleMembers(client, [{ id: latest.agentId, dir: latest.dir }]);
  }
  if (action === "candidate" || action === "complete") {
    await requireProgress(client.root, scope);
    const tasks = await approvedTasks(client, p);
    if (action === "complete") {
      if (
        tasks.some((w) => executionMode(w) === "reviewed") &&
        !(await reviewValid(p))
      )
        throw new Error("Overall completion requires a current Oracle PASS.");
      const expected = p.reviews.at(-1)?.taskApprovals;
      if (
        expected &&
        JSON.stringify(expected) !==
          JSON.stringify(
            tasks.map((w) => ({
              id: w.id,
              revision: w.revision,
              noteRevision: w.noteRevision,
              reviewJob: w.reviews.at(-1)?.jobId ?? null,
            })),
          )
      )
        throw new Error("Task approvals changed after Oracle review.");
    }
    if (
      action === "candidate" &&
      tasks.every((w) => executionMode(w) === "single")
    )
      throw Error(
        "All tasks use single execution; call repo_project complete without Oracle.",
      );
    p.status = action === "complete" ? "completed" : "candidate";
    await save(scope, "projects", p);
  }
  if (action === "revise") {
    validateRequirements(requirements);
    for (const task of p.tasks) {
      const w = await getWork(scope, task);
      await idleMembers(client, w.members);
      if (w.lead) await idleMembers(client, [w.lead]);
    }
    p.history ??= [];
    p.history.push({ revision: p.revision, requirements: p.requirements });
    p.requirements = requirements;
    p.revision++;
    p.status = "working";
    await save(scope, "projects", p);
  }
  let valid = false;
  try {
    valid = await reviewValid(p);
  } catch {
    valid = false;
  }
  return {
    id: p.id,
    title: p.title,
    requirements: p.requirements,
    revision: p.revision,
    status: p.status,
    tasks: p.tasks,
    requiresOracle: (
      await Promise.all(p.tasks.map((task) => getWork(scope, task)))
    ).some((w) => executionMode(w) === "reviewed"),
    oracleValid: valid,
    attempts: p.reviews.length,
    reviewLimit: p.reviewLimit,
  };
}
export async function reviseWork(client, id, requirements) {
  assertRoot(client);
  validateRequirements(requirements);
  const scope = scopeOf(client),
    w = await getWork(scope, id),
    p = await getProject(scope, w.project);
  if (p.status === "reviewing") {
    const last = p.reviews.at(-1);
    await idleMembers(client, [{ id: last.agentId, dir: last.dir }]);
  }
  await idleMembers(client, w.members);
  if (w.lead) await idleMembers(client, [w.lead]);
  for (const other of await listWork(scope))
    if (
      other.id !== id &&
      other.status !== "completed" &&
      (w.rootOperation ||
        other.rootOperation ||
        other.repos.some((r) => w.repos[r]))
    )
      throw new Error("Another unfinished task owns this checkout.");
  w.history ??= [];
  w.history.push({ revision: w.revision, requirements: w.requirements });
  w.requirements = requirements;
  w.projectRevision = p.revision;
  delete w.singleCompletion;
  delete w.approvalOnly;
  delete w.escalation;
  w.revision++;
  w.status = "working";
  p.status = "working";
  await save(scope, "work", w);
  await save(scope, "projects", p);
  return {
    id,
    revision: w.revision,
    status: w.status,
    instruction: w.directManager
      ? "Resume its direct Implementer; mode and baseline are preserved."
      : "Resume its Task Lead. Original baseline and review budget are preserved; previous approvals are stale.",
  };
}
export async function taskNote(
  client,
  { text = /** @type {string|undefined} */ (undefined), kind = "decision" },
) {
  const id = client.delegation?.bundle;
  assertTaskOwner(client, id);
  if (!["decision", "progress"].includes(kind))
    throw Error("Note kind must be decision or progress.");
  const scope = scopeOf(client),
    w = await getWork(scope, id);
  const field = kind === "progress" ? "progressNotes" : "notes";
  if (text !== undefined) {
    if (typeof text !== "string" || text.length > 8000)
      throw Error("Task notes are limited to 8000 characters.");
    if (w[field] === text) return { id, kind, text, revision: w.noteRevision };
    if (kind === "decision") {
      if (w.status === "completed")
        throw Error(
          "Ask the Orchestrator to reopen completed work before refinements.",
        );
      await idleMembers(
        client,
        w.members.filter((m) => m.role === "reviewer"),
      );
      w.noteRevision++;
      w.status = "working";
    }
    w[field] = text;
    await save(scope, "work", w);
  }
  return {
    id,
    kind,
    text: w[field] ?? "",
    revision: w.noteRevision,
    approvalAffected: kind === "decision",
  };
}
export async function inspectHierarchyReview(
  request,
  {
    repo = /** @type {string | undefined} */ (undefined),
    evidenceTask = /** @type {string | undefined} */ (undefined),
    section = "requirements",
    ...params
  },
) {
  const review = request?.contract?.review;
  if (!review?.targets) throw new Error("No hierarchical review assigned.");
  if (evidenceTask) {
    const task = request.contract.taskApprovals?.find(
      (t) => t.id === evidenceTask,
    );
    if (!task || !["requirements", "notes", "brief"].includes(section))
      throw new Error(
        "Select an assigned task and requirements/notes/brief evidence section.",
      );
    const raw =
      typeof task[section] === "string"
        ? task[section]
        : JSON.stringify(task[section]);
    const offset = params.offset ?? 0;
    return {
      task: evidenceTask,
      section,
      text: raw.slice(offset, offset + 12000),
      nextOffset: offset + 12000 < raw.length ? offset + 12000 : null,
    };
  }
  if (!repo)
    return {
      repositories: Object.keys(review.targets),
      requirements: request.contract.requirements,
      notes: request.contract.notes,
      taskApprovals: request.contract.taskApprovals?.map(
        ({ id, revision, reviewJob }) => ({ id, revision, reviewJob }),
      ),
    };
  const target = review.targets[repo];
  if (!target) throw new Error("Repository not in this review.");
  return reviewChanges(
    {
      contract: {
        baseline: target.baseline,
        review: { target: target.target, snapshot: target.snapshot },
        previousReview: {
          snapshot: request.contract.previousReview?.targets?.[repo]?.snapshot,
        },
      },
    },
    target.path,
    params,
  );
}
export async function validateReviewTarget(request, dir, jobId) {
  const review = request?.contract?.review;
  if (!review?.targets) throw new Error("No independent review assigned.");
  await requireProgress(request.contract.root, review.workScope);
  const current =
    review.kind === "projects"
      ? await getProject(review.workScope, review.id)
      : await getWork(review.workScope, review.id);
  if (
    current.pendingInput ||
    (current.inputRevision ?? 0) !== review.inputRevision ||
    current.revision !== review.requirementsRevision ||
    (current.noteRevision ?? 0) !== review.noteRevision ||
    current.reviews.at(-1)?.jobId !== review.jobId
  )
    throw new Error("Review requirements or assigned target are stale.");
  const evidence = await readJSON(
    path.join(dir, `${jobId}.inspection.json`),
    {},
  );
  for (const [repo, s] of Object.entries(review.targets)) {
    if (!(await reviewTargetMatches(s)))
      throw new Error(
        "Reviewed artifacts changed; request a new review attempt.",
      );
    if (evidence[repo]?.target !== s.target)
      throw new Error(`Inspect actual changes in ${repo} before PASS.`);
    const base = await readJSON(s.baseline),
      target = await readJSON(s.snapshot);
    const changed = [
      ...new Set([
        ...Object.keys(base.entries),
        ...Object.keys(target.entries),
      ]),
    ].filter(
      (file) =>
        base.entries[file]?.hash !== target.entries[file]?.hash ||
        base.entries[file]?.mode !== target.entries[file]?.mode,
    );
    if (review.kind === "projects") {
      if (
        changed.length &&
        !changed.some((file) => evidence[repo]?.files?.[file]?.complete)
      )
        throw new Error(
          `Inspect actual integration-relevant changes in ${repo} before Oracle PASS; task evidence alone is insufficient.`,
        );
    } else {
      for (const file of changed)
        if (!evidence[repo]?.files?.[file]?.complete)
          throw new Error(
            `Inspect all pages of baseline changes for ${repo}/${file} before PASS. Unchanged inspected files may be reused on re-review.`,
          );
    }
  }
  if (review.kind === "work")
    return {
      ...review,
      approvalScope: await taskApprovalScope(request, dir, jobId),
    };
  return review;
}
export async function validateLeadCompletion(scope, bundle) {
  const w = await getWork(scope, bundle);
  requireClassifiedInputs(w);
  if (w.status !== "completed" || !(await reviewValid(w)))
    throw new Error(
      "Task Lead completion requires a current Reviewer approval and a committed task completion state.",
    );
  return {
    task: bundle,
    revision: w.revision,
    reviewJob: w.reviews.at(-1).jobId,
  };
}
export async function extendReview(client, kind, id) {
  assertRoot(client);
  const scope = scopeOf(client),
    value =
      kind === "oracle"
        ? await getProject(scope, id)
        : await getWork(scope, id);
  value.reviewLimit++;
  await fs.rm(
    path.join(
      scope,
      "progress",
      `${kind === "oracle" ? "projects" : "work"}-${id}.json`,
    ),
    { force: true },
  );
  await save(scope, kind === "oracle" ? "projects" : "work", value);
  return value.reviewLimit;
}

export function requireClassifiedInputs(work) {
  if (work.pendingInput || work.pendingReceipts?.length)
    throw new Error(
      "Classify received input with repo_task_input before advancing work. Questions do not invalidate approvals.",
    );
  if (work.escalation)
    throw new Error(
      "A scope/acceptance change is awaiting Orchestrator resolution. Report the blocker; do not advance implementation/review.",
    );
}
export async function recordDirectInput(client, text) {
  const id = client.delegation?.bundle;
  assertTaskOwner(client, id);
  const scope = scopeOf(client),
    work = await getWork(scope, id);
  work.pendingReceipts ??= [];
  if (work.pendingReceipts.length >= 50)
    throw new Error(
      "Resolve the current input inbox before accepting more messages.",
    );
  const receipt = {
    id: randomUUID(),
    text,
    kind: "unclassified",
    receivedAt: new Date().toISOString(),
  };
  await writeJSON(
    path.join(scope, "inputs", id, `${receipt.id}.json`),
    receipt,
  );
  work.pendingReceipts.push(receipt.id);
  await save(scope, "work", work);
  return receipt.id;
}
export async function taskInput(
  client,
  {
    action,
    id = /** @type {string|undefined} */ (undefined),
    kind = /** @type {string|undefined} */ (undefined),
    summary = /** @type {string|undefined} */ (undefined),
  },
) {
  const task = client.delegation?.bundle;
  assertTaskOwner(client, task);
  const scope = scopeOf(client),
    work = await getWork(scope, task);
  if (action === "list")
    return {
      task,
      pending: work.pendingReceipts ?? [],
      escalation: work.escalation ?? null,
    };
  idCheck(id);
  const file = path.join(scope, "inputs", task, `${id}.json`),
    receipt = await readJSON(file);
  if (!receipt) throw new Error("Unknown input for this task.");
  if (action === "read") return receipt;
  if (
    action !== "classify" ||
    !["question", "refinement", "escalation"].includes(kind)
  )
    throw new Error("Classify as question, refinement or escalation.");
  if (work.inputDecisions?.[id]) {
    const decision = work.inputDecisions[id];
    await writeJSON(file, { ...receipt, ...decision });
    return { ...decision, status: "already-classified" };
  }
  if (receipt.kind !== "unclassified")
    return { id, kind: receipt.kind, status: "already-classified" };
  if (typeof summary !== "string" || !summary.trim() || summary.length > 1200)
    throw new Error(
      "Provide a concise classification/decision summary (1–1200 characters).",
    );
  if (kind === "refinement") {
    if (work.status === "completed")
      throw new Error(
        "Completed work needs Orchestrator reopening; classify this request as escalation instead.",
      );
    await idleMembers(
      client,
      work.members.filter((m) => m.role === "reviewer"),
    );
    const notes = `${work.notes}\n${summary}`.trim();
    if (notes.length > 8000)
      throw new Error(
        "Task decisions exceed 8000 characters; compact existing notes before accepting this refinement.",
      );
    work.notes = notes;
    work.noteRevision++;
    work.inputRevision = (work.inputRevision ?? 0) + 1;
    work.status = "working";
  }
  if (kind === "escalation") work.escalation = { input: id, summary };
  // Persist the acceptance decision before acknowledging its receipt. Retry repairs a partial write.
  work.inputDecisions ??= {};
  const decision = { id, kind, summary };
  work.inputDecisions[id] = decision;
  for (const old of Object.keys(work.inputDecisions).slice(0, -100))
    delete work.inputDecisions[old];
  work.pendingReceipts = (work.pendingReceipts ?? []).filter((x) => x !== id);
  await save(scope, "work", work);
  await writeJSON(file, {
    ...receipt,
    ...decision,
    classifiedAt: new Date().toISOString(),
  });
  return {
    task,
    ...decision,
    status: "classified",
    approvalChanged: kind === "refinement",
    instruction:
      kind === "escalation"
        ? "Report the decision needed to Orchestrator; do not implement the scope change."
        : kind === "question"
          ? "Answer locally; no approval change or parent report is needed."
          : "Continue implementation through the task's Implementers.",
  };
}

export async function reopenReview(client, id) {
  assertRoot(client);
  const scope = scopeOf(client),
    w = await getWork(scope, id),
    p = await getProject(scope, w.project);
  await requireProgress(client.root, scope);
  requireClassifiedInputs(w);
  await idleMembers(client, w.members);
  if (w.lead) await idleMembers(client, [w.lead]);
  if (p.status === "reviewing") {
    const r = p.reviews.at(-1);
    await idleMembers(client, [{ id: r.agentId, dir: r.dir }]);
  }
  for (const other of await listWork(scope))
    if (
      other.id !== id &&
      other.status !== "completed" &&
      other.repos.some((r) => w.repos[r])
    )
      throw Error("Another unfinished task owns this checkout.");
  w.approvalOnly = true;
  w.status = "working";
  p.status = "working";
  await save(scope, "work", w);
  await save(scope, "projects", p);
  return {
    id,
    status: w.status,
    revision: w.revision,
    attempts: w.reviews.length,
    preserved: ["execution-records", "requirements", "review-budget"],
    nextAction:
      "Resume Task Lead, assess changed scope and request review. Only request implementation if findings require it.",
  };
}
