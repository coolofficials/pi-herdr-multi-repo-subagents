import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readJSON, writeJSON } from "./storage.mjs";
import { liveness } from "./lifecycle.mjs";
import { withOperationLock } from "./coordination-lock.mjs";
import { getWork, getProject, listWork, listProjects } from "./hierarchy.mjs";
import { repairSubmission } from "./reports.mjs";
import { validateBrief } from "./contracts.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const baseOf = (client) => path.dirname(client.scope);
const digest = (text) => createHash("sha256").update(text).digest("hex");
async function managedPath(base, file) {
  if (typeof file !== "string") throw Error("Missing retained metadata path.");
  const real = await fs.realpath(file);
  if (!real.startsWith(base + path.sep) || real !== path.resolve(file))
    throw Error(
      "Recovery metadata must remain inside this root's managed run directory without symlinks.",
    );
  return real;
}
async function run(client, runId) {
  if (!uuid.test(runId ?? ""))
    throw Error("Use an exact run ID from repo_workflow history.");
  const scope = await managedPath(
    baseOf(client),
    path.join(baseOf(client), runId),
  );
  const parent = await readJSON(path.join(scope, "parent.json"));
  if (!parent || parent.root !== client.root || parent.role === "task_lead")
    throw Error("Run is not an Orchestrator workflow for this task root.");
  const workScope = await managedPath(
    baseOf(client),
    parent.workScope ?? scope,
  );
  const origin = await readJSON(path.join(workScope, "parent.json"));
  if (!origin || origin.root !== client.root)
    throw Error("Workflow root does not match.");
  return { scope, workScope, parent };
}
async function scopes(client) {
  const entries = await fs.readdir(baseOf(client), { withFileTypes: true });
  const selected = entries.filter(
    (e) => e.isDirectory() && !e.isSymbolicLink() && uuid.test(e.name),
  );
  if (selected.length > 500)
    throw Error(
      "Too many retained runs for safe recovery; archive unrelated history first.",
    );
  return selected.map((e) => path.join(baseOf(client), e.name));
}
export async function workflowHistory(client) {
  const items = [];
  for (const scope of await scopes(client)) {
    const parent = await readJSON(path.join(scope, "parent.json"));
    if (!parent || parent.root !== client.root || parent.role === "task_lead")
      continue;
    // Old Lead metadata has no role; its transcript lives in the managed runs tree.
    if (
      !parent.role &&
      parent.sessionFile?.startsWith(baseOf(client) + path.sep)
    )
      continue;
    const workScope = parent.workScope ?? scope;
    await managedPath(baseOf(client), workScope);
    const projects = await listProjects(workScope);
    const work = await listWork(workScope);
    items.push({
      runId: path.basename(scope),
      workflowId: path.basename(workScope),
      current: scope === client.scope,
      processStatus: liveness(parent.instance),
      sameConversation: parent.sessionId === client.sessionId,
      updatedAt: parent.updatedAt,
      projects: projects.length,
      tasks: work.length,
      incomplete: work.filter((w) => w.status !== "completed").length,
    });
  }
  items.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return {
    runs: items.slice(0, 50),
    truncated: items.length > 50,
    instruction:
      "Restore an exact old run with repo_workflow restore or /repo-agents restore <run-id>. History never adopts processes or resets review budgets.",
  };
}
// Enumerate execution identities as well as workflow references: even forgotten or
// cleanly settled children can still be running and must not be adopted.
async function retainedFamily(client, source) {
  const members = new Map();
  const blockers = [];
  const related = new Set([source.scope, source.workScope]);
  for (const scope of await scopes(client)) {
    const p = await readJSON(path.join(scope, "parent.json"));
    if (
      p &&
      p.sessionId === source.parent.sessionId &&
      (!p.role || p.role === "orchestrator")
    )
      related.add(scope);
    if (p?.workScope === source.workScope) related.add(scope);
  }
  const owners = [];
  const add = (m) => {
    if (m?.dir) members.set(m.dir, { ...members.get(m.dir), ...m });
  };
  for (const scope of await scopes(client)) {
    const parent = await readJSON(path.join(scope, "parent.json"));
    if (scope !== client.scope && parent && related.has(scope)) {
      const status = liveness(parent.instance);
      owners.push({
        runId: path.basename(scope),
        instance: parent.instance,
        status,
      });
      if (status !== "dead")
        blockers.push(`parent ${path.basename(scope)} is ${status}`);
    }
    for (const m of await readJSON(path.join(scope, "agents.json"), [])) {
      await managedPath(baseOf(client), m.dir);
      const launch = await readJSON(path.join(m.dir, "launch.json"));
      if (related.has(scope) || related.has(launch?.workScope)) add(m);
    }
    // Forgotten/archived launches still have a process identity and evidence.
    const dirs = await fs.readdir(scope, { withFileTypes: true });
    for (const dir of dirs.filter(
      (d) =>
        d.isDirectory() &&
        !d.isSymbolicLink() &&
        /^repo-[a-f0-9-]+$/.test(d.name),
    )) {
      const file = path.join(scope, dir.name);
      const launch = await readJSON(path.join(file, "launch.json"));
      if (related.has(launch?.workScope)) add({ id: dir.name, dir: file });
    }
  }
  const tasks = await listWork(source.workScope),
    projects = await listProjects(source.workScope);
  for (const item of [
    ...tasks.map((x) => ({ ...x, kind: "work" })),
    ...projects.map((x) => ({ ...x, kind: "projects" })),
  ]) {
    const value = await readJSON(
      path.join(source.workScope, item.kind, item.id + ".json"),
    );
    for (const m of value.members ?? []) add(m);
    add(value.lead);
    add(value.executor);
    for (const review of value.reviews ?? [])
      add({ id: review.agentId, dir: review.dir });
  }
  for (const [dir, member] of members) {
    await managedPath(baseOf(client), dir);
    const ready = await readJSON(path.join(dir, "ready.json"));
    const instance =
      ready?.instance ?? (await readJSON(path.join(dir, "claim.json")));
    const recovered = await readJSON(path.join(dir, "recovered.json"));
    const status = instance
      ? liveness(instance)
      : recovered
        ? "dead"
        : "unknown";
    member.instance = instance;
    member.recovered = Boolean(recovered);
    if (status !== "dead")
      blockers.push(
        `child ${member.id} is ${status}; inspect it or use repo_agent_recover after confirmed exit`,
      );
  }
  return { members, owners, blockers, tasks, projects };
}
export async function restoreWorkflow(client, runId) {
  if (client.delegation)
    throw Error("Only the Orchestrator may restore a workflow.");
  await client.requireOwnership();
  const source = await run(client, runId);
  if (source.workScope === client.workScope)
    return {
      status: "already-connected",
      workflowId: path.basename(client.workScope),
      adoptedAgents: 0,
    };
  if (
    (await listWork(client.workScope)).length ||
    (await listProjects(client.workScope)).length ||
    (await client.records()).length
  )
    throw Error(
      "Current run already contains work. Restore in an empty main; workflows cannot be merged or replaced.",
    );
  return withOperationLock(
    source.workScope,
    async () => {
      await client.requireOwnership();
      const family = await retainedFamily(client, source);
      if (family.blockers.length)
        throw Error(
          "WORKFLOW_RECOVERY_BLOCKED: " +
            family.blockers.slice(0, 6).join("; "),
        );
      if (!family.projects.length)
        throw Error("No supported schema-2 workflow is retained in this run.");
      // Check complete schema/relationship sets before touching any membership.
      for (const p of family.projects) {
        const value = await getProject(source.workScope, p.id);
        if (
          value.schema !== 2 ||
          !Array.isArray(value.reviews) ||
          !Number.isInteger(value.reviewLimit)
        )
          throw Error(
            "Unsupported project schema; no migration or review-budget reset performed.",
          );
        for (const id of value.tasks) {
          const w = await getWork(source.workScope, id);
          if (
            !Array.isArray(w.members) ||
            !Array.isArray(w.reviews) ||
            !Number.isInteger(w.reviewLimit) ||
            w.reviews.length > w.reviewLimit
          )
            throw Error(
              "Unsupported task/review state; no partial migration or budget reset performed.",
            );
          for (const target of Object.values(w.repos))
            await managedPath(baseOf(client), target.baseline);
          for (const review of w.reviews)
            for (const target of Object.values(review.targets)) {
              await managedPath(baseOf(client), target.baseline);
              await managedPath(baseOf(client), target.snapshot);
            }
          if (w.project !== p.id)
            throw Error("Workflow task/project relationship is inconsistent.");
        }
      }
      const receipt = {
        schema: 1,
        status: "restored",
        fromRun: runId,
        toRun: client.identity.token,
        workflowId: path.basename(source.workScope),
        at: new Date().toISOString(),
        adoptedAgents: 0,
        preserved: [
          "IDs",
          "requirements",
          "baselines",
          "reviews",
          "reviewLimit",
          "progress",
          "inputs",
          "evidence",
        ],
        execution: [...family.members.values()].map((m) => ({
          id: m.id,
          dir: m.dir,
          instance: m.instance,
          recovered: m.recovered,
        })),
      };
      const journal = path.join(
        source.workScope,
        "restorations",
        client.identity.token + ".json",
      );
      await writeJSON(journal, { ...receipt, status: "preparing" });
      const retire = (m) => {
        if (!m) return;
        const proof = family.members.get(m.dir);
        m.retired = true;
        m.workflowRetirement = {
          instance: proof.instance,
          recovered: proof.recovered,
          receipt: journal,
        };
      };
      for (const item of family.tasks) {
        const w = await getWork(source.workScope, item.id);
        for (const m of w.members) retire(m);
        retire(w.lead);
        retire(w.executor);
        w.restoredBy = client.identity.token;
        await writeJSON(path.join(source.workScope, "work", w.id + ".json"), w);
      }
      // Release only matching reservations whose owning processes were proven dead.
      for (const m of family.members.values()) {
        const launch = await readJSON(path.join(m.dir, "launch.json"));
        const key =
          m.reservationKey ??
          (launch
            ? launch.role === "implementer"
              ? launch.cwd
              : `${launch.cwd}#${path.basename(launch.scope)}:${launch.role}:${launch.bundle ?? "research"}`
            : undefined);
        if (key) client.lifecycle.unreserve(key, m.id);
      }
      const state = client.lifecycle.bindWorkflow(source.workScope, receipt);
      client.workScope = source.workScope;
      await writeJSON(path.join(client.scope, "parent.json"), state);
      await writeJSON(journal, receipt);
      return {
        ...receipt,
        instruction:
          "Read existing repo_work/project status and reconcile pending progress. Repair a missing report with repo_workflow repair_report (same job/attempt). Start a new Task Lead for unfinished work using the retained contract; do not repeat implementation or create replacement tasks.",
      };
    },
    { identity: client.identity },
  );
}

// Legacy versions discarded failed submissions. Recover only a real structured
// assistant tool call on the session's final branch, never prose or manager guesses.
export async function legacyReviewDraft(record, request, report) {
  if (
    !["reviewer", "oracle"].includes(request.role) ||
    report.jobId !== request.jobId ||
    report.status !== "needs-report"
  )
    throw Error(
      "Only the exact failed independent review job can recover a legacy submission.",
    );
  const file = report.sessionFile;
  if (
    !file ||
    !path.resolve(file).startsWith(path.join(record.dir, "sessions") + path.sep)
  )
    throw Error(
      "Review transcript is outside its recorded agent session directory.",
    );
  if (
    await readJSON(
      path.join(record.dir, `${request.jobId}.draft-invalidated.json`),
    )
  )
    throw Error(
      "The submitted draft was invalidated by further work; do not resurrect it.",
    );
  const stat = await fs.lstat(file);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size > 64 * 1024 * 1024 ||
    (await fs.realpath(file)) !== path.resolve(file)
  )
    throw Error(
      "Unsupported legacy session file; no partial transcript recovery.",
    );
  const text = await fs.readFile(file, "utf8");
  const entries = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const beforeEnd = entries.filter(
    (e) =>
      e.timestamp && Date.parse(e.timestamp) <= Date.parse(report.finishedAt),
  );
  const byId = new Map(beforeEnd.filter((e) => e.id).map((e) => [e.id, e]));
  const branch = [],
    seen = new Set();
  let tip = beforeEnd.at(-1);
  while (tip?.id && !seen.has(tip.id)) {
    seen.add(tip.id);
    branch.unshift(tip);
    tip = byId.get(tip.parentId);
  }
  const users = branch.filter((e) => e.message?.role === "user");
  const body = (m) =>
    (m.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  const matches = users.filter(
    (e) =>
      body(e.message).includes(request.task ?? "\0") &&
      body(e.message).includes(`Role: ${request.role}`) &&
      body(e.message).includes(`Assigned task/project ID: ${request.bundle}`),
  );
  if (
    !request.task ||
    matches.length !== 1 ||
    users.at(-1)?.id !== matches[0]?.id
  )
    throw Error(
      "Cannot unambiguously bind the final session turn to this review request.",
    );
  const segment = branch.slice(branch.indexOf(matches[0]) + 1);
  let submission;
  for (const e of segment) {
    if (e.message?.role !== "assistant") continue;
    for (const call of e.message.content ?? []) {
      if (call.type !== "toolCall") continue;
      if (call.name === "repo_agent_report") submission = { entry: e.id, call };
      else submission = undefined; // Subsequent work invalidates a previously submitted decision.
    }
  }
  if (!submission)
    throw Error(
      "No final structured repo_agent_report submission; no PASS can be invented.",
    );
  const response = segment.find(
    (e) =>
      e.message?.role === "toolResult" &&
      e.message.toolCallId === submission.call.id &&
      e.message.toolName === "repo_agent_report",
  );
  if (!response || !/PROGRESS_INPUT_PENDING/.test(body(response.message)))
    throw Error(
      "Legacy recovery only accepts a recorded progress-classification rejection, not arbitrary failures.",
    );
  const brief = validateBrief(submission.call.arguments);
  const after = await fs.lstat(file);
  if (
    stat.ino !== after.ino ||
    stat.size !== after.size ||
    stat.mtimeMs !== after.mtimeMs
  )
    throw Error("Review transcript changed during recovery.");
  return {
    jobId: request.jobId,
    brief,
    completion: "job",
    status: "blocked",
    provenance: {
      source: "legacy-report-tool-call",
      sessionFile: file,
      sha256: digest(text),
      entry: submission.entry,
      toolCallId: submission.call.id,
      requestHash: digest(JSON.stringify(request)),
      recoveredAt: new Date().toISOString(),
    },
  };
}
export async function repairWorkflowReport(client, { kind = "task", id }) {
  if (!["task", "oracle"].includes(kind))
    throw Error("Select task or oracle report.");
  if (client.delegation && (kind !== "task" || client.delegation.bundle !== id))
    throw Error("Task Lead may repair only its assigned task review.");
  const value =
    kind === "task"
      ? await getWork(client.workScope, id)
      : await getProject(client.workScope, id);
  const review = value.reviews.at(-1);
  if (!review) throw Error("No existing review slot to repair.");
  await managedPath(baseOf(client), review.dir);
  const request = await readJSON(path.join(review.dir, "request.json"));
  if (
    !request ||
    request.jobId !== review.jobId ||
    request.contract?.root !== client.root ||
    request.contract?.review?.jobId !== review.jobId ||
    JSON.stringify(request.contract?.review) !== JSON.stringify(review) ||
    request.bundle !== id ||
    request.contract?.review?.workScope !== client.workScope ||
    request.contract.review.kind !== (kind === "task" ? "work" : "projects") ||
    request.contract.review.id !== id ||
    request.contract.review.agentId !== review.agentId ||
    request.role !== (kind === "task" ? "reviewer" : "oracle")
  )
    throw Error(
      "Review request/slot identity changed; no report recovery performed.",
    );
  const record = { id: review.agentId, dir: review.dir, jobId: review.jobId };
  const report = await readJSON(
    path.join(review.dir, `${review.jobId}.result.json`),
  );
  if (report?.status !== "needs-report")
    return repairSubmission(client, record);
  const instance = (await readJSON(path.join(review.dir, "ready.json")))
    ?.instance;
  if (liveness(instance) !== "dead")
    throw Error(
      "Historical report repair requires a confirmed dead review process. Use its immediate manager's repo_agent_repair for a live child.",
    );
  const saved = await readJSON(
    path.join(review.dir, `${review.jobId}.draft.json`),
  );
  if (saved?.provenance?.source === "legacy-report-tool-call") {
    const proof = saved.provenance;
    if (
      proof.sessionFile !== report.sessionFile ||
      proof.requestHash !== digest(JSON.stringify(request)) ||
      proof.sha256 !== digest(await fs.readFile(proof.sessionFile, "utf8"))
    )
      throw Error(
        "Legacy report provenance changed. Preserve the original record; no approval recovered.",
      );
  }
  if (!saved) {
    try {
      const draft = await legacyReviewDraft(record, request, report);
      await writeJSON(
        path.join(review.dir, `${review.jobId}.draft.json`),
        draft,
      );
    } catch (error) {
      return {
        status: "needs-attention",
        jobId: review.jobId,
        reason: String(error.message),
        instruction:
          "No report or review approval was fabricated. Preserve this workflow and its review budget; inspect the missing original evidence.",
      };
    }
  }
  const repaired = await repairSubmission(client, record);
  if (
    repaired.status === "needs-attention" &&
    repaired.failure?.kind === "inspection_incomplete"
  )
    repaired.instruction =
      "The original report cannot be approved without read evidence. Its assigned Task Lead (or Orchestrator for direct tasks/Oracle) may call repo_workflow resume_review with this same ID/kind. One new independent process continues the unchanged job/slot; no review-budget reset or repeated implementation.";
  return repaired;
}

export async function workflowEvidence(
  client,
  { kind = "task", id, offset = 0 },
) {
  if (
    !["task", "oracle"].includes(kind) ||
    !Number.isInteger(offset) ||
    offset < 0
  )
    throw Error("Select task/oracle and a nonnegative report offset.");
  if (client.delegation && (kind !== "task" || client.delegation.bundle !== id))
    throw Error(
      "Task Lead may read only its assigned task's compact evidence.",
    );
  const value =
    kind === "task"
      ? await getWork(client.workScope, id)
      : await getProject(client.workScope, id);
  const handles = [
    ...(value.members ?? []),
    ...(value.lead ? [{ ...value.lead, role: "task_lead" }] : []),
    ...value.reviews.map((r) => ({
      id: r.agentId,
      dir: r.dir,
      jobId: r.jobId,
      role: kind === "task" ? "reviewer" : "oracle",
    })),
  ];
  const reports = [];
  const seen = new Set();
  for (const member of handles) {
    await managedPath(baseOf(client), member.dir);
    const request = await readJSON(path.join(member.dir, "request.json"));
    const jobId = member.jobId ?? request?.jobId;
    if (!jobId || seen.has(`${member.dir}:${jobId}`)) continue;
    seen.add(`${member.dir}:${jobId}`);
    reports.push({ ...member, jobId });
  }
  const selected = reports[offset];
  if (!selected)
    return { id, total: reports.length, report: null, nextOffset: null };
  const report = await readJSON(
    path.join(selected.dir, `${selected.jobId}.result.json`),
  );
  // Import lazily to keep only validated compact report data at the manager boundary.
  const { publicReport } = await import("./contracts.mjs");
  return {
    id,
    total: reports.length,
    agent: selected.id,
    role: selected.role,
    repo: selected.repo,
    historical: Boolean(selected.workflowRetirement),
    jobId: selected.jobId,
    report: publicReport(report),
    nextOffset: offset + 1 < reports.length ? offset + 1 : null,
    instruction:
      "This is retained job evidence, not permission to prompt/adopt an old process or assume task completion. Check current contracts/approval status; reuse unchanged completed execution rather than repeat it.",
  };
}
