import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { readJSON, writeJSON, resolveRepo } from "./core.mjs";
import { snapshot, reviewChanges } from "./workflow.mjs";
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
export async function createProject(client, { title, requirements }) {
  assertRoot(client);
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
  await save(scopeOf(client), "projects", p);
  return p;
}
async function idleMembers(client, members, ignoreId) {
  for (const member of members ?? []) {
    if (member.id === ignoreId) continue;
    const ready = await readJSON(path.join(member.dir, "ready.json"));
    const req = await readJSON(path.join(member.dir, "request.json"));
    const report = req
      ? await readJSON(path.join(member.dir, `${req.jobId}.result.json`))
      : null;
    // A dead accepted job still needs explicit recovery; no automatic re-assignment.
    if (req && !report)
      throw new Error(`Agent ${member.id} has unfinished/unreported work.`);
    if (ready?.cleanExit && liveness(ready.instance) === "dead") continue;
    const live = (await client.call(["agent", "get", member.id])).result?.agent;
    if (!["idle", "done"].includes(live?.status ?? live?.agent_status))
      throw new Error(`Agent ${member.id} is busy or unavailable.`);
  }
}
export async function createWork(
  client,
  {
    project = /** @type {string | undefined} */ (undefined),
    title = /** @type {string | undefined} */ (undefined),
    requirements = /** @type {string | undefined} */ (undefined),
    repos = /** @type {string[]} */ ([]),
  },
) {
  assertRoot(client);
  validateRequirements(requirements);
  if (
    !title?.trim() ||
    title.length > 160 ||
    !repos.length ||
    repos.length > 12
  )
    throw new Error("Provide a task title and 1–12 repositories.");
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
      item.repos.some((r) => selected.some((x) => x.repo === r))
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
    title,
    requirements,
    revision: 1,
    status: "working",
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
    if (!["task_lead", "oracle", "scout", "researcher"].includes(role))
      throw new Error(
        "Orchestrator delegates implementation and local review through a Task Lead.",
      );
    if (["task_lead", "oracle"].includes(role) && repo !== ".")
      throw new Error("Task Lead and Oracle run at the task root (repo='.').");
    if (role === "task_lead") {
      const w = await getWork(scopeOf(client), bundle);
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
  const review = {
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
    targets,
  };
  value.reviews.push(review);
  value.status = "reviewing";
  await save(scope, kind, value);
  return {
    requirements: value.requirements,
    originalRequirements:
      value.history?.[0]?.requirements ?? value.requirements,
    notes: value.notes ?? "",
    review,
    previousReview: prior
      ? {
          targets: prior.targets,
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
      reviewJob: w.reviews.at(-1).jobId,
      requirements: w.requirements,
      notes: w.notes,
      brief: w.completionBrief,
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
        (!ready?.cleanExit && !retired) ||
        liveness(ready?.instance) !== "dead" ||
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
  };
}
async function reviewValid(value) {
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
  for (const s of Object.values(latest.targets))
    if ((await snapshot(s.path)).fingerprint !== s.target) return false;
  if (value.tasks) {
    for (const approval of latest.taskApprovals ?? []) {
      const task = await getWork(latest.workScope, approval.id);
      if (
        task.status !== "completed" ||
        task.revision !== approval.revision ||
        task.noteRevision !== approval.noteRevision ||
        task.reviews.at(-1)?.jobId !== approval.reviewJob ||
        !(await reviewValid(task))
      )
        return false;
    }
  }
  return true;
}
export async function workStatus(client, id, complete = false) {
  if (client.delegation) assertTaskOwner(client, id);
  const scope = scopeOf(client),
    w = await getWork(scope, id);
  if (complete) {
    assertTaskOwner(client, id);
    await idleMembers(client, w.members);
    if (!(await reviewValid(w)))
      throw new Error(
        "Task completion requires a current independent Reviewer PASS for actual artifacts and current requirements/decisions.",
      );
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
    reviewValid: await reviewValid(w),
    attempts: w.reviews.length,
    reviewLimit: w.reviewLimit,
  };
}
export async function taskCandidate(client, id) {
  assertTaskOwner(client, id);
  const scope = scopeOf(client),
    w = await getWork(scope, id);
  if (w.status === "completed") throw new Error("Task is already completed.");
  if (w.pendingInput)
    throw new Error(
      "Summarize direct user refinements/decisions with repo_task_note before review candidacy. Escalate scope changes instead of accepting them locally.",
    );
  await idleMembers(client, w.members);
  for (const repo of Object.keys(w.repos)) {
    const implementer = w.members
      .filter((m) => m.repo === repo && m.role === "implementer")
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
    if (w.status !== "completed" || !(await reviewValid(w)))
      throw new Error(`Task ${id} is incomplete or its approval is stale.`);
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
  },
) {
  assertRoot(client);
  const scope = scopeOf(client);
  if (action === "create")
    return createProject(client, { title, requirements });
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
    const tasks = await approvedTasks(client, p);
    if (action === "complete") {
      if (!(await reviewValid(p)))
        throw new Error("Overall completion requires a current Oracle PASS.");
      const expected = p.reviews.at(-1).taskApprovals;
      if (
        JSON.stringify(expected) !==
        JSON.stringify(
          tasks.map((w) => ({
            id: w.id,
            revision: w.revision,
            noteRevision: w.noteRevision,
            reviewJob: w.reviews.at(-1).jobId,
          })),
        )
      )
        throw new Error("Task approvals changed after Oracle review.");
    }
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
      other.repos.some((r) => w.repos[r])
    )
      throw new Error("Another unfinished task owns this checkout.");
  w.history ??= [];
  w.history.push({ revision: w.revision, requirements: w.requirements });
  w.requirements = requirements;
  w.revision++;
  w.status = "working";
  p.status = "working";
  await save(scope, "work", w);
  await save(scope, "projects", p);
  return {
    id,
    revision: w.revision,
    status: w.status,
    instruction:
      "Resume its Task Lead. Original baseline and review budget are preserved; previous approvals are stale.",
  };
}
export async function taskNote(
  client,
  { text = /** @type {string | undefined} */ (undefined) },
) {
  const id = client.delegation?.bundle;
  assertTaskOwner(client, id);
  const scope = scopeOf(client),
    w = await getWork(scope, id);
  if (text !== undefined) {
    if (typeof text !== "string" || text.length > 8000)
      throw new Error("Task notes are limited to 8000 characters.");
    if (w.status === "completed")
      throw new Error(
        "Ask the Orchestrator to reopen completed work before refinements.",
      );
    await idleMembers(
      client,
      w.members.filter((m) => m.role === "reviewer"),
    );
    w.notes = text;
    w.noteRevision++;
    w.pendingInput = false;
    w.status = "working";
    await save(scope, "work", w);
  }
  return { id, text: w.notes, revision: w.noteRevision };
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
        review: { target: target.target },
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
    if ((await snapshot(s.path)).fingerprint !== s.target)
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
  return review;
}
export async function validateLeadCompletion(scope, bundle) {
  const w = await getWork(scope, bundle);
  if (w.status !== "completed" || !(await reviewValid(w)))
    throw new Error(
      "Task Lead cannot report completion before a current Reviewer approval and repo_work complete.",
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
  await save(scope, kind === "oracle" ? "projects" : "work", value);
  return value.reviewLimit;
}

export async function recordDirectInput(client, text) {
  const id = client.delegation?.bundle;
  assertTaskOwner(client, id);
  const scope = scopeOf(client),
    w = await getWork(scope, id);
  if (w.status === "completed")
    throw new Error("Reopen this task through Orchestrator first.");
  await idleMembers(
    client,
    w.members.filter((m) => m.role === "reviewer"),
  );
  w.inputRevision = (w.inputRevision ?? 0) + 1;
  w.pendingInput = true;
  w.status = "working";
  await writeJSON(
    path.join(scope, "work", `${id}.input-${w.inputRevision}.json`),
    { text, at: new Date().toISOString() },
  );
  await save(scope, "work", w);
}
