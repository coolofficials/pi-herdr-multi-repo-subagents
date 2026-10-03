import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readJSON, writeJSON } from "../src/storage.mjs";
import {
  createProject,
  createWork,
  prepareAssignment,
  taskNote,
  getWork,
  workStatus,
} from "../src/hierarchy.mjs";
import {
  registerProgress,
  requireProgress,
  acknowledgeProgress,
} from "../src/documents.mjs";
import {
  saveSubmission,
  repairSubmission,
  failureInfo,
} from "../src/reports.mjs";
import { publicReport } from "../src/contracts.mjs";
import { registerEvidence, verificationEvidence } from "../src/evidence.mjs";
import { inspectionProgress } from "../src/inspection.mjs";
import { inspectSource } from "../src/access.mjs";
import { coordinationState, settlementAdvice } from "../src/coordination.mjs";
import { waitForLaunchShell } from "../src/launch-readiness.mjs";

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-repair-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scope = path.join(root, "state"),
    repo = path.join(root, "repo");
  await fs.mkdir(repo);
  execFileSync("git", ["init", "-q", repo]);
  await fs.writeFile(path.join(repo, "a.mjs"), "export const a=1;\n");
  await fs.writeFile(path.join(root, "todo-tracker.md"), "ready");
  const client = {
    root,
    scope,
    workScope: scope,
    records: async () => [],
    requireOwnership: async () => {},
    locked: (fn) => fn(),
    call: async () => ({ result: { agent: { status: "idle" } } }),
  };
  const project = await createProject(client, {
    title: "Project",
    requirements: "Change a",
    progressDocuments: ["todo-tracker.md"],
  });
  const work = await createWork(client, {
    project: project.id,
    title: "A",
    requirements: "Change a",
    repos: ["repo"],
  });
  const lead = { ...client, delegation: { bundle: work.id } };
  await fs.writeFile(path.join(repo, "a.mjs"), "export const a=2;\n");
  const dir = path.join(root, "reviewer"),
    jobId = randomUUID(),
    record = { id: "reviewer", dir, repo: ".", jobId };
  const contract = await prepareAssignment(
    lead,
    record,
    jobId,
    "reviewer",
    work.id,
  );
  const request = { jobId, role: "reviewer", bundle: work.id, contract };
  await writeJSON(path.join(dir, "request.json"), request);
  await writeJSON(path.join(dir, jobId + ".inspection.json"), {
    repo: {
      target: contract.review.targets.repo.target,
      files: { "a.mjs": { next: null, complete: true } },
    },
  });
  const brief = {
    outcome: "completed",
    summary: "PASS",
    verdict: "pass",
    checks: ["Actual acceptance check"],
    references: ["repo/a.mjs"],
  };
  return {
    root,
    scope,
    repo,
    client,
    lead,
    work,
    project,
    dir,
    jobId,
    record,
    request,
    brief,
  };
}
test("pending progress retains PASS draft; same-job repair is idempotent without another review", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "todo-tracker.md"), "external progress");
  await assert.rejects(
    saveSubmission(f.client, f.request, f.dir, f.jobId, f.brief),
    /PROGRESS_INPUT_PENDING/,
  );
  assert.equal(
    (await readJSON(path.join(f.dir, f.jobId + ".draft.json"))).brief.verdict,
    "pass",
  );
  await writeJSON(path.join(f.dir, f.jobId + ".result.json"), {
    jobId: f.jobId,
    status: "needs-report",
    role: "reviewer",
  });
  assert.equal(
    (await repairSubmission(f.lead, f.record)).failure.kind,
    "progress_input_pending",
  );
  await acknowledgeProgress(f.root, f.scope, "todo-tracker.md", "Status only");
  assert.equal(
    (await repairSubmission(f.lead, f.record)).status,
    "report-repaired",
  );
  const result = await readJSON(path.join(f.dir, f.jobId + ".result.json"));
  assert.equal(result.review.attempt, 1);
  assert.equal(result.brief.verdict, "pass");
  assert.equal((await getWork(f.scope, f.work.id)).reviews.length, 1);
  assert.equal(
    (await repairSubmission(f.lead, f.record)).status,
    "not-repairable",
  );
  assert.deepEqual(
    await readJSON(path.join(f.dir, f.jobId + ".result.json")),
    result,
  );
});
test("repair refuses changed code, contract and job identities", async (t) => {
  const f = await fixture(t);
  await saveSubmission(f.client, f.request, f.dir, f.jobId, f.brief);
  await writeJSON(path.join(f.dir, f.jobId + ".result.json"), {
    jobId: f.jobId,
    status: "needs-report",
  });
  await fs.writeFile(path.join(f.repo, "a.mjs"), "export const a=3;\n");
  assert.equal(
    (await repairSubmission(f.lead, f.record)).failure.kind,
    "stale_target",
  );
  await fs.writeFile(path.join(f.repo, "a.mjs"), "export const a=2;\n");
  await taskNote(f.lead, { text: "new implementation decision" });
  assert.equal(
    (await repairSubmission(f.lead, f.record)).failure.kind,
    "stale_target",
  );
  await assert.rejects(
    repairSubmission(f.lead, { ...f.record, jobId: "different" }),
    /job changed/,
  );
});
test("missing draft does not invent PASS; invalid PASS retains exact missing-field diagnostic", async (t) => {
  const f = await fixture(t);
  await writeJSON(path.join(f.dir, f.jobId + ".result.json"), {
    jobId: f.jobId,
    status: "needs-report",
  });
  assert.equal(
    (await repairSubmission(f.lead, f.record)).status,
    "needs-attention",
  );
  await assert.rejects(
    saveSubmission(f.client, f.request, f.dir, f.jobId, {
      ...f.brief,
      references: [],
    }),
    /references/,
  );
  assert.match(
    (await readJSON(path.join(f.dir, f.jobId + ".draft.json"))).failure.message,
    /references/,
  );
});
test("progress notes preserve approved work, decision notes invalidate it", async (t) => {
  const f = await fixture(t),
    accepted = await saveSubmission(
      f.client,
      f.request,
      f.dir,
      f.jobId,
      f.brief,
    );
  await writeJSON(path.join(f.dir, f.jobId + ".result.json"), {
    status: "settled",
    ...accepted,
  });
  assert.equal((await workStatus(f.lead, f.work.id)).reviewValid, true);
  await taskNote(f.lead, {
    kind: "progress",
    text: "PASS recorded; Oracle next",
  });
  assert.equal((await workStatus(f.lead, f.work.id)).reviewValid, true);
  await taskNote(f.lead, { kind: "decision", text: "Change error handling" });
  assert.equal((await workStatus(f.lead, f.work.id)).reviewValid, false);
});
test("shared tracker registration preserves pending edits across projects", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "todo-tracker.md"), "external edit");
  await registerProgress(f.root, f.scope, "second-project", [
    "todo-tracker.md",
  ]);
  await assert.rejects(
    requireProgress(f.root, f.scope),
    /PROGRESS_INPUT_PENDING/,
  );
  await acknowledgeProgress(
    f.root,
    f.scope,
    "todo-tracker.md",
    "Both projects use status only",
  );
  await requireProgress(f.root, f.scope);
  const docs = await readJSON(path.join(f.scope, "documents.json"));
  assert.equal(docs["todo-tracker.md"].projects.length, 2);
});
test("Lead job completion does not require approval or mark the task complete", async (t) => {
  const f = await fixture(t);
  const request = { jobId: "diagnostic", role: "task_lead", bundle: f.work.id };
  const saved = await saveSubmission(f.lead, request, f.dir, "diagnostic", {
    outcome: "completed",
    summary: "Found recovery command",
    completion: "job",
  });
  assert.equal(saved.completion, "job");
  assert.equal(saved.taskApproval, undefined);
  assert.notEqual((await getWork(f.scope, f.work.id)).status, "completed");
  await writeJSON(path.join(f.dir, f.jobId + ".result.json"), {
    status: "settled",
    brief: { outcome: "incomplete", summary: "No approval" },
  });
  await assert.rejects(
    saveSubmission(f.lead, request, f.dir, "diagnostic2", {
      outcome: "completed",
      summary: "Task done",
    }),
    /Reviewer PASS/,
  );
});
test("coverage exposes gaps and exact character offsets; listing alone is insufficient", async (t) => {
  const f = await fixture(t);
  await writeJSON(path.join(f.dir, f.jobId + ".inspection.json"), {
    repo: {
      target: f.request.contract.review.targets.repo.target,
      files: { "a.mjs": { next: 7000, complete: false } },
    },
  });
  const progress = await inspectionProgress(f.request, f.dir, f.jobId);
  assert.equal(progress.repositories[0].gateCoverageSatisfied, false);
  assert.deepEqual(progress.repositories[0].remaining, [
    { file: "a.mjs", nextOffset: 7000, unit: "characters", since: "baseline" },
  ]);
});
test("verification file snapshot is readable by assigned review only and survives original edits", async (t) => {
  const f = await fixture(t),
    ownerDir = path.join(f.root, "implementer"),
    id = "implementer";
  await fs.mkdir(path.join(f.root, "references"));
  const file = "references/ci.log";
  await fs.writeFile(path.join(f.root, file), "start\nactual error\nend\n");
  const work = await getWork(f.scope, f.work.id);
  work.members.push({ id, dir: ownerDir, role: "implementer", repo: "repo" });
  await writeJSON(path.join(f.scope, "work", f.work.id + ".json"), work);
  const launch = { root: f.root, cwd: f.repo, agentId: id };
  const evidence = await registerEvidence(
    launch,
    {
      jobId: "implementation",
      role: "implementer",
      bundle: f.work.id,
      contract: { repos: ["repo"], workScope: f.scope },
    },
    ownerDir,
    file,
  );
  await fs.writeFile(path.join(f.root, file), "different");
  const read = await verificationEvidence(
    { root: f.root, agentId: "reviewer" },
    f.request,
    f.dir,
    { action: "read", id: evidence.id, query: "actual error" },
  );
  assert.match(read.text, /actual error/);
  assert.equal(read.complete, true);
  assert.equal(read.file, file);
  assert.equal(read.sourceVersion, null);
  await assert.rejects(
    verificationEvidence(
      { agentId: "other" },
      { role: "scout" },
      "/tmp/not-an-owner",
      { action: "read", id: evidence.id },
    ),
    /not found/,
  );
  await assert.rejects(
    registerEvidence(launch, { role: "reviewer" }, ownerDir, file),
    /register evidence/,
  );
});
test("evidence registration rejects escaping, symlink and unassigned repo", async (t) => {
  const f = await fixture(t),
    launch = { root: f.root, cwd: f.repo, agentId: "worker" },
    request = { role: "implementer", contract: { repos: ["repo"] } };
  await assert.rejects(
    registerEvidence(launch, request, f.dir, "../outside.log"),
    /relative/,
  );
  await fs.mkdir(path.join(f.root, "references"));
  await fs.symlink(
    path.join(f.repo, "a.mjs"),
    path.join(f.root, "references", "link.log"),
  );
  await assert.rejects(
    registerEvidence(launch, request, f.dir, "references/link.log"),
    /Symlink/,
  );
  await fs.mkdir(path.join(f.root, "references", "other", ".git"), {
    recursive: true,
  });
  await fs.writeFile(path.join(f.root, "references/other/output.log"), "x");
  await assert.rejects(
    registerEvidence(launch, request, f.dir, "references/other/output.log"),
    /unassigned/,
  );
});
test("single-file literal search works and does not walk sibling files", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.repo, "sibling.mjs"), "a=2");
  const result = await inspectSource(f.repo, {
    action: "search",
    file: "a.mjs",
    query: "a=2",
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].file, "a.mjs");
  assert.equal(result.nextOffset, null);
});
test("coordination requires an actual question/blocker and notices stale waiting_children", async (t) => {
  const f = await fixture(t);
  assert.ok(await settlementAdvice(f.client));
  await assert.rejects(
    coordinationState(f.client, {
      action: "set",
      id: f.work.id,
      status: "waiting_user",
      nextAction: "Implement",
      reason: "Need input",
    }),
    /actual question/,
  );
  await coordinationState(f.client, {
    action: "set",
    id: f.work.id,
    status: "waiting_user",
    nextAction: "Implement",
    reason: "Ambiguous scope",
    question: "Which scope?",
  });
  assert.ok(await settlementAdvice(f.client, "Status only"));
  assert.equal(await settlementAdvice(f.client, "Which scope?"), null);
  await assert.rejects(
    coordinationState(f.client, {
      action: "set",
      id: f.work.id,
      status: "waiting_children",
      nextAction: "Assess report",
    }),
    /actual unfinished child/,
  );
  // A persisted wait from before completion must also be detected on resume.
  await writeJSON(path.join(f.scope, "coordination-state.json"), {
    [f.work.id]: { id: f.work.id, status: "waiting_children" },
  });
  assert.ok(await settlementAdvice(f.client));
  await coordinationState(f.client, {
    action: "set",
    id: f.work.id,
    status: "blocked_system",
    nextAction: "Repair report",
    reason: "Tracker needs classification",
  });
  assert.equal(await settlementAdvice(f.client), null);
});
test("compact provider failures remain actionable without raw transcripts or credentials", () => {
  assert.equal(failureInfo("Codex usage limit reached").kind, "provider_limit");
  assert.equal(
    failureInfo("WebSocket closed 1012").kind,
    "provider_connection",
  );
  const failure = failureInfo(
    "Authorization Bearer private-token sk-private-key",
  );
  assert.ok(!failure.message.includes("private-token"));
  assert.ok(!failure.message.includes("sk-private"));
  assert.match(
    publicReport({
      status: "error",
      failure: failureInfo("usage limit reached"),
    }).failure.nextAction,
    /provider capacity/,
  );
});
test("shell preflight waits for stable exact identity; occupied or replaced panes never start", async () => {
  const record = { pane: "p", terminal: "t", tab: "tab" };
  const client = {
    call: async (args) =>
      args[1] === "get"
        ? {
            result: { pane: { pane_id: "p", terminal_id: "t", tab_id: "tab" } },
          }
        : {
            result: {
              process_info: {
                pane_id: "p",
                shell_pid: 123,
                foreground_process_group_id: 123,
                foreground_processes: [{ pid: 123 }],
              },
            },
          },
  };
  assert.ok((await waitForLaunchShell(client, record)).observations >= 3);
  await assert.rejects(
    waitForLaunchShell(
      {
        call: async () => ({
          result: {
            pane: { pane_id: "p", terminal_id: "wrong", tab_id: "tab" },
          },
        }),
      },
      record,
    ),
    /identity changed/,
  );
  await assert.rejects(
    waitForLaunchShell(
      {
        call: async () => ({
          result: {
            pane: {
              pane_id: "p",
              terminal_id: "t",
              tab_id: "tab",
              agent: "occupied",
            },
          },
        }),
      },
      record,
    ),
    /occupied/,
  );
});
test("a rejected replacement report never leaves an old accepted brief", async (t) => {
  const f = await fixture(t);
  await saveSubmission(f.client, f.request, f.dir, f.jobId, f.brief);
  await assert.rejects(
    saveSubmission(f.client, f.request, f.dir, f.jobId, {
      ...f.brief,
      references: [],
    }),
    /references/,
  );
  assert.equal(await readJSON(path.join(f.dir, f.jobId + ".brief.json")), null);
});
test("a parent repairs its Lead completion under the assigned task boundary", async (t) => {
  const f = await fixture(t),
    checked = await saveSubmission(
      f.client,
      f.request,
      f.dir,
      f.jobId,
      f.brief,
    );
  await writeJSON(path.join(f.dir, f.jobId + ".result.json"), {
    status: "settled",
    ...checked,
  });
  const dir = path.join(f.root, "lead"),
    jobId = randomUUID(),
    request = { jobId, role: "task_lead", bundle: f.work.id };
  await writeJSON(path.join(dir, "request.json"), request);
  await writeJSON(path.join(dir, jobId + ".draft.json"), {
    jobId,
    brief: { outcome: "completed", summary: "Task approved" },
  });
  await writeJSON(path.join(dir, jobId + ".result.json"), {
    jobId,
    status: "needs-report",
  });
  const repaired = await repairSubmission(f.client, { dir, jobId });
  assert.equal(repaired.status, "report-repaired");
  assert.equal((await getWork(f.scope, f.work.id)).status, "completed");
});
test("progress handoff after committed task completion preserves approval and task status", async (t) => {
  const f = await fixture(t),
    checked = await saveSubmission(
      f.client,
      f.request,
      f.dir,
      f.jobId,
      f.brief,
    );
  await writeJSON(path.join(f.dir, f.jobId + ".result.json"), {
    status: "settled",
    ...checked,
  });
  await workStatus(f.lead, f.work.id, true);
  await taskNote(f.lead, {
    kind: "progress",
    text: "Approved; Oracle handoff",
  });
  const state = await workStatus(f.lead, f.work.id);
  assert.equal(state.status, "completed");
  assert.equal(state.reviewValid, true);
  await assert.rejects(
    taskNote(f.lead, { text: "New acceptance decision" }),
    /reopen/,
  );
});
test("package entry defers only to an explicitly pinned package bridge", async (t) => {
  const { usesExplicitBridge } = await import("../src/entry.mjs");
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "pkg/src"), { recursive: true });
  await writeJSON(path.join(f.root, "pkg/package.json"), {
    name: "pi-herdr-multi-repo-subagents",
  });
  const entry = path.join(f.root, "pkg/src/index.ts");
  assert.equal(
    await usesExplicitBridge([
      "--repo-agent-child",
      "launch",
      "--extension",
      entry,
    ]),
    true,
  );
  assert.equal(await usesExplicitBridge(["--extension", entry]), true);
  assert.equal(await usesExplicitBridge([]), false);
  assert.equal(
    await usesExplicitBridge([
      "--repo-agent-child",
      "launch",
      "--extension",
      path.join(f.root, "other/src/index.ts"),
    ]),
    false,
  );
});
