import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Controller } from "../src/core.mjs";
import { processIdentity } from "../src/lifecycle.mjs";
import { writeJSON, readJSON } from "../src/storage.mjs";
import {
  createProject,
  createWork,
  prepareAssignment,
  getWork,
  getProject,
  workStatus,
} from "../src/hierarchy.mjs";
import { acknowledgeProgress } from "../src/documents.mjs";
import { saveSubmission } from "../src/reports.mjs";
import { legacyReviewDraft, repairWorkflowReport } from "../src/recovery.mjs";
import { boardSnapshot } from "../src/board.mjs";

const dead = () => ({
  pid: 2147483647,
  host: os.hostname(),
  started: "dead fixture",
  token: randomUUID(),
});
async function fixture(t, session = "old-conversation") {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflow-recovery-")),
  );
  const storage = path.join(root, "state");
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  execFileSync("git", ["init", "-q", repo]);
  await fs.writeFile(path.join(repo, "a.mjs"), "export const a=1;\n");
  await fs.writeFile(path.join(root, "todo-tracker.md"), "progress");
  const clients = [];
  const client = (owner, identity) => {
    const c = new Controller({
      root,
      storage,
      owner,
      identity,
      env: {},
      transport: async () => {
        throw Error("Recovery must not launch or message Herdr");
      },
    });
    clients.push(c);
    return c;
  };
  const old = client(session, dead());
  await old.connect({ sessionFile: path.join(root, "conversation.jsonl") });
  const p = await createProject(old, {
    title: "P",
    requirements: "Change a",
    progressDocuments: ["todo-tracker.md"],
  });
  const w = await createWork(old, {
    project: p.id,
    title: "A",
    requirements: "Change a",
    repos: ["repo"],
  });
  const next = client(session, { ...processIdentity(), token: randomUUID() });
  t.after(() => {
    for (const c of clients) c.lifecycle?.close();
    return fs.rm(root, { recursive: true, force: true });
  });
  return { root, storage, old, next, p, w, client, repo };
}
async function reviewer(f, { legacy = false } = {}) {
  const record = {
    id: "repo-" + randomUUID(),
    dir: path.join(f.old.scope, "repo-" + randomUUID()),
    repo: ".",
    role: "reviewer",
  };
  const jobId = randomUUID();
  const lead = {
    ...f.old,
    delegation: { bundle: f.w.id },
    records: async () => [],
  };
  await fs.writeFile(path.join(f.repo, "a.mjs"), "export const a=2;\n");
  const contract = await prepareAssignment(
    lead,
    record,
    jobId,
    "reviewer",
    f.w.id,
  );
  const request = {
    jobId,
    task: "Independently review exact candidate unique reason",
    role: "reviewer",
    bundle: f.w.id,
    contract,
  };
  await writeJSON(path.join(record.dir, "ready.json"), {
    instance: dead(),
    cleanExit: true,
  });
  await writeJSON(path.join(record.dir, "request.json"), request);
  await writeJSON(path.join(record.dir, `${jobId}.inspection.json`), {
    repo: {
      target: contract.review.targets.repo.target,
      files: { "a.mjs": { complete: true, next: null } },
    },
  });
  const brief = {
    outcome: "completed",
    summary: "PASS actual review",
    verdict: "pass",
    checks: ["actual check"],
    references: ["repo/a.mjs"],
  };
  await fs.writeFile(path.join(f.root, "todo-tracker.md"), "external progress");
  if (!legacy)
    await assert.rejects(
      saveSubmission(lead, request, record.dir, jobId, brief),
      /PROGRESS_INPUT_PENDING/,
    );
  const sessionFile = path.join(record.dir, "sessions", "old.jsonl");
  const time = "2026-10-01T00:00:00.000Z";
  const rows = [
    { type: "session", version: 3, timestamp: time },
    {
      type: "message",
      id: "u",
      parentId: null,
      timestamp: time,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: `Role: reviewer\nAssigned task/project ID: ${f.w.id}\n${request.task}`,
          },
        ],
      },
    },
    {
      type: "message",
      id: "c",
      parentId: "u",
      timestamp: time,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "report-call",
            name: "repo_agent_report",
            arguments: brief,
          },
        ],
      },
    },
    {
      type: "message",
      id: "r",
      parentId: "c",
      timestamp: time,
      message: {
        role: "toolResult",
        toolName: "repo_agent_report",
        toolCallId: "report-call",
        content: [
          { type: "text", text: "PROGRESS_INPUT_PENDING: todo-tracker.md" },
        ],
      },
    },
  ];
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(
    sessionFile,
    rows.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  const report = {
    jobId,
    role: "reviewer",
    status: "needs-report",
    sessionFile,
    finishedAt: "2026-10-01T01:00:00.000Z",
  };
  await writeJSON(path.join(record.dir, `${jobId}.result.json`), report);
  return {
    record: { ...record, jobId },
    jobId,
    request,
    report,
    rows,
    sessionFile,
    brief,
  };
}
test("same-conversation restart restores IDs and budgets without child adoption or source changes", async (t) => {
  const f = await fixture(t),
    rev = await reviewer(f);
  const before = await getWork(f.old.scope, f.w.id);
  const source = await fs.readFile(path.join(f.repo, "a.mjs"));
  const state = await f.next.connect();
  assert.equal(state.acquired, true);
  assert.equal(f.next.workScope, f.old.scope);
  assert.notEqual(f.next.scope, f.old.scope);
  assert.equal(state.runId, f.next.identity.token);
  assert.equal(state.workflowId, f.old.identity.token);
  assert.equal(state.workflowRecovery.adoptedAgents, 0);
  assert.deepEqual(await f.next.records(), []);
  const after = await getWork(f.next.workScope, f.w.id);
  assert.equal(after.id, before.id);
  assert.deepEqual(after.reviews, before.reviews);
  assert.deepEqual(after.repos, before.repos);
  assert.equal(after.revision, before.revision);
  assert.equal(after.reviewLimit, before.reviewLimit);
  assert.equal(after.members[0].retired, true);
  assert.deepEqual(await fs.readFile(path.join(f.repo, "a.mjs")), source);
  assert.equal(
    (await f.next.workflow({ action: "restore", runId: f.old.identity.token }))
      .status,
    "already-connected",
  );
  assert.equal((await getWork(f.next.workScope, f.w.id)).reviews.length, 1);
  assert.equal((await f.next.workflow({ action: "history" })).runs[0].tasks, 1);
  assert.equal(
    (await workStatus(f.next, f.w.id)).approvalStatus.nextAction,
    "repair_report",
  );
  assert.equal(
    (await readJSON(path.join(rev.record.dir, rev.jobId + ".result.json")))
      .status,
    "needs-report",
  );
});
test("fresh main can explicitly restore an exact run; another active workflow cannot be replaced", async (t) => {
  const f = await fixture(t);
  f.next.sessionId = "different-conversation";
  await f.next.connect();
  assert.equal(f.next.workScope, f.next.scope);
  await assert.rejects(
    f.next.workflow({ action: "restore", runId: "../../elsewhere" }),
    /exact run ID/,
  );
  await f.next.workflow({ action: "restore", runId: f.old.identity.token });
  assert.equal(f.next.workScope, f.old.scope);
  const p = await getProject(f.next.workScope, f.p.id);
  assert.equal(p.reviewLimit, 3);
  const other = await fixture(t);
  other.next.sessionId = "fresh-unrelated";
  await other.next.connect();
  await createProject(other.next, { title: "Other", requirements: "Other" });
  await assert.rejects(
    other.next.workflow({ action: "restore", runId: other.old.identity.token }),
    /already contains work/,
  );
});
test("alive, detached or unknown children block auto restore and replacement work", async (t) => {
  const f = await fixture(t),
    rev = await reviewer(f);
  await writeJSON(path.join(rev.record.dir, "ready.json"), {
    instance: processIdentity(),
    detached: true,
  });
  const state = await f.next.connect();
  assert.equal(state.workflowRecovery.status, "blocked");
  assert.equal(f.next.workScope, f.next.scope);
  await assert.rejects(
    createProject(f.next, { title: "Bypass", requirements: "New" }),
    /recovery is blocked/,
  );
  await assert.rejects(
    f.next.start({ role: "scout", repo: ".", task: "Bypass" }),
    /blocked workflow/,
  );
  await writeJSON(path.join(rev.record.dir, "ready.json"), {
    instance: { ...dead(), host: "other-host" },
  });
  await assert.rejects(
    f.next.workflow({ action: "restore", runId: f.old.identity.token }),
    /unknown/,
  );
  await writeJSON(path.join(rev.record.dir, "ready.json"), {
    instance: dead(),
  });
  await f.next.workflow({ action: "restore", runId: f.old.identity.token });
  assert.equal(
    (await f.next.workflow({ action: "status" })).recovery.status,
    "restored",
  );
});
test("cross-process report repair preserves the review slot and rechecks progress then source", async (t) => {
  const f = await fixture(t),
    rev = await reviewer(f);
  await f.next.connect();
  const params = { action: "repair_report", kind: "task", id: f.w.id };
  assert.equal(
    (await f.next.workflow(params)).failure.kind,
    "progress_input_pending",
  );
  await acknowledgeProgress(
    f.root,
    f.next.workScope,
    "todo-tracker.md",
    "Progress only",
  );
  await fs.writeFile(path.join(f.repo, "a.mjs"), "export const a=3;\n");
  assert.equal((await f.next.workflow(params)).failure.kind, "stale_target");
  await fs.writeFile(path.join(f.repo, "a.mjs"), "export const a=2;\n");
  assert.equal((await f.next.workflow(params)).status, "report-repaired");
  assert.equal((await workStatus(f.next, f.w.id)).reviewValid, true);
  assert.equal((await getWork(f.next.workScope, f.w.id)).reviews.length, 1);
  assert.equal((await f.next.workflow(params)).status, "not-repairable");
  const leadRecord = {
    id: "repo-" + randomUUID(),
    dir: path.join(f.next.scope, "repo-" + randomUUID()),
  };
  await prepareAssignment(
    f.next,
    leadRecord,
    randomUUID(),
    "task_lead",
    f.w.id,
  );
  const lead = { ...f.next, delegation: { bundle: f.w.id } };
  await workStatus(lead, f.w.id, true);
  assert.equal((await getWork(f.next.workScope, f.w.id)).status, "completed");
  await assert.rejects(
    repairWorkflowReport(
      { ...f.next, delegation: { bundle: randomUUID() } },
      params,
    ),
    /assigned task/,
  );
  assert.equal(
    (await readJSON(path.join(rev.record.dir, rev.jobId + ".result.json")))
      .brief.verdict,
    "pass",
  );
});
test("legacy failed report recovers exact structured call and provenance, never approval from prose", async (t) => {
  const f = await fixture(t),
    rev = await reviewer(f, { legacy: true });
  await f.next.connect();
  await acknowledgeProgress(
    f.root,
    f.next.workScope,
    "todo-tracker.md",
    "Status-only external edit",
  );
  const result = await f.next.workflow({ action: "repair_report", id: f.w.id });
  assert.equal(result.status, "report-repaired");
  const draft = await readJSON(
    path.join(rev.record.dir, `${rev.jobId}.draft.json`),
  );
  assert.equal(draft.provenance.source, "legacy-report-tool-call");
  assert.equal(draft.provenance.toolCallId, "report-call");
  assert.match(draft.provenance.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await getWork(f.old.scope, f.w.id)).reviews.length, 1);
  rev.rows[2].message.content = [{ type: "text", text: "PASS" }];
  await fs.writeFile(
    rev.sessionFile,
    rev.rows.map((x) => JSON.stringify(x)).join("\n"),
  );
  await assert.rejects(
    legacyReviewDraft(rev.record, rev.request, rev.report),
    /structured/,
  );
});
test("legacy recovery rejects other requests, broken tool pairing and later work", async (t) => {
  const f = await fixture(t),
    rev = await reviewer(f, { legacy: true });
  for (const [mutate, reason] of [
    [
      (rows) => {
        rows[3].message.toolCallId = "wrong";
      },
      /recorded progress/,
    ],
    [
      (rows) => {
        rows[1].message.content[0].text = "Role: reviewer\nDifferent request";
      },
      /unambiguously/,
    ],
    [
      (rows) => {
        rows[2].message.content.push({
          type: "toolCall",
          id: "later",
          name: "repo_source",
          arguments: {},
        });
      },
      /structured/,
    ],
    [
      (rows) => {
        rows[3].message.content[0].text = "Unknown stale failure";
      },
      /recorded progress/,
    ],
  ]) {
    const copy = structuredClone(rev.rows);
    mutate(copy);
    await fs.writeFile(
      rev.sessionFile,
      copy.map((x) => JSON.stringify(x)).join("\n"),
    );
    await assert.rejects(
      legacyReviewDraft(rev.record, rev.request, rev.report),
      reason,
    );
  }
  await fs.writeFile(
    rev.sessionFile,
    rev.rows.map((x) => JSON.stringify(x)).join("\n"),
  );
  await writeJSON(
    path.join(rev.record.dir, `${rev.jobId}.draft-invalidated.json`),
    { reason: "later work" },
  );
  await assert.rejects(
    legacyReviewDraft(rev.record, rev.request, rev.report),
    /invalidated/,
  );
});
test("restored binding survives same-process fresh conversation and another restart", async (t) => {
  const f = await fixture(t);
  await f.next.connect();
  f.next.sessionId = "fresh";
  await f.next.connect({ handoff: true });
  assert.equal(f.next.workScope, f.old.scope);
  await f.next.release("test-exit");
  // Released metadata is still insufficient while the identity is alive.
  const last = await readJSON(path.join(f.next.scope, "parent.json"));
  last.instance = dead();
  f.next.lifecycle.transaction(() => f.next.lifecycle.save(last));
  await writeJSON(path.join(f.next.scope, "parent.json"), last);
  const newer = f.client("fresh", {
    ...processIdentity(),
    token: randomUUID(),
  });
  await newer.connect();
  assert.equal(newer.workScope, f.old.scope);
  assert.deepEqual(await newer.records(), []);
  assert.equal(
    (await newer.workflow({ action: "status" })).workflowId,
    f.old.identity.token,
  );
});
test("new execution family board resolves tasks from durable work scope", async (t) => {
  const f = await fixture(t);
  await f.next.connect();
  const dir = path.join(f.next.scope, "repo-" + randomUUID());
  await writeJSON(path.join(f.next.scope, "agents.json"), [
    {
      id: path.basename(dir),
      dir,
      bundle: f.w.id,
      role: "task_lead",
      repo: ".",
    },
  ]);
  const board = await boardSnapshot(f.next.scope);
  assert.equal(board.workflow.restored, true);
  assert.equal(board.workflow.tasks, 1);
  assert.equal(board.rows[0].task, "A");
  assert.equal(board.rows[0].taskStatus, "working");
});

test("an empty legacy restart finds the unique original workflow of the same conversation", async (t) => {
  const f = await fixture(t);
  const middle = f.client("temporary-other", dead());
  await middle.connect();
  const parent = await readJSON(path.join(middle.scope, "parent.json"));
  parent.sessionId = f.old.sessionId;
  middle.lifecycle.transaction(() => middle.lifecycle.save(parent));
  await writeJSON(path.join(middle.scope, "parent.json"), parent);
  await f.next.connect();
  assert.equal(f.next.workScope, f.old.scope);
  assert.equal((await getWork(f.next.workScope, f.w.id)).id, f.w.id);
});
test("ambiguous historical workflows block automatic replacement", async (t) => {
  const f = await fixture(t);
  const another = f.client("different", dead());
  await another.connect();
  await createProject(another, {
    title: "Second workflow",
    requirements: "Other",
  });
  const parent = await readJSON(path.join(another.scope, "parent.json"));
  parent.sessionId = f.old.sessionId;
  await writeJSON(path.join(another.scope, "parent.json"), parent);
  const empty = f.client("third", dead());
  await empty.connect();
  const ep = await readJSON(path.join(empty.scope, "parent.json"));
  ep.sessionId = f.old.sessionId;
  empty.lifecycle.transaction(() => empty.lifecycle.save(ep));
  await writeJSON(path.join(empty.scope, "parent.json"), ep);
  const state = await f.next.connect();
  assert.equal(state.workflowRecovery.status, "blocked");
  assert.match(state.workflowRecovery.reason, /Multiple historical/);
  await assert.rejects(
    createProject(f.next, { title: "Bypass", requirements: "Bypass" }),
    /recovery is blocked/,
  );
});
test("legacy submission retries require unchanged original provenance", async (t) => {
  const f = await fixture(t),
    rev = await reviewer(f, { legacy: true });
  await f.next.connect();
  const params = { action: "repair_report", id: f.w.id };
  assert.equal(
    (await f.next.workflow(params)).failure.kind,
    "progress_input_pending",
  );
  await fs.appendFile(rev.sessionFile, "\n");
  await acknowledgeProgress(
    f.root,
    f.next.workScope,
    "todo-tracker.md",
    "Status only",
  );
  await assert.rejects(f.next.workflow(params), /provenance changed/);
  assert.equal(
    (await readJSON(path.join(rev.record.dir, `${rev.jobId}.result.json`)))
      .status,
    "needs-report",
  );
});
test("new Lead reads retained compact evidence without gaining another task's records", async (t) => {
  const f = await fixture(t),
    rev = await reviewer(f);
  await f.next.connect();
  f.next.delegation = { bundle: f.w.id };
  const result = await f.next.workflow({ action: "evidence", id: f.w.id });
  assert.equal(result.jobId, rev.jobId);
  assert.equal(result.report.status, "needs-report");
  assert.ok(!JSON.stringify(result).includes("thinkingSignature"));
  await assert.rejects(
    f.next.workflow({ action: "evidence", id: randomUUID() }),
    /assigned task/,
  );
  await assert.rejects(
    f.next.workflow({ action: "restore", runId: f.old.identity.token }),
    /Only the Orchestrator/,
  );
});
test("legacy target encoding requires complete matching bytes, modes and files", async (t) => {
  const { reviewTargetMatches } = await import("../src/workflow.mjs");
  const f = await fixture(t),
    rev = await reviewer(f);
  const target = structuredClone(rev.request.contract.review.targets.repo);
  const retained = await readJSON(target.snapshot);
  retained.schema = 2;
  for (const entry of Object.values(retained.entries)) {
    entry.kind = "file";
    entry.content = "inline";
    entry.size = Buffer.from(entry.data, "base64").length;
  }
  const { createHash } = await import("node:crypto");
  retained.fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        Object.keys(retained.entries)
          .sort()
          .map((f) => {
            const e = retained.entries[f];
            return [f, e.hash, e.mode, e.size, e.kind, e.content];
          }),
      ),
    )
    .digest("hex");
  await writeJSON(target.snapshot, retained);
  target.target = retained.fingerprint;
  assert.equal(await reviewTargetMatches(target), true);
  await fs.chmod(path.join(f.repo, "a.mjs"), 0o755);
  assert.equal(await reviewTargetMatches(target), false);
  await fs.chmod(path.join(f.repo, "a.mjs"), 0o644);
  await fs.writeFile(path.join(f.repo, "extra.mjs"), "extra");
  assert.equal(await reviewTargetMatches(target), false);
  await fs.rm(path.join(f.repo, "extra.mjs"));
  retained.entries["a.mjs"].data = Buffer.from("tampered").toString("base64");
  await writeJSON(target.snapshot, retained);
  assert.equal(await reviewTargetMatches(target), false);
});

test("unfinished review continues once on the same job/attempt without adopting its old process", async (t) => {
  const { prepareReviewContinuation, attachReviewContinuation } =
    await import("../src/review-continuation.mjs");
  const f = await fixture(t),
    rev = await reviewer(f);
  const work = await getWork(f.old.scope, f.w.id);
  work.reviewLimit = 1; // Exhausted: completion of this existing slot is not another attempt.
  await writeJSON(path.join(f.old.scope, "work", f.w.id + ".json"), work);
  await f.next.connect();
  await acknowledgeProgress(
    f.root,
    f.next.workScope,
    "todo-tracker.md",
    "Status only",
  );
  const lead = { ...f.next, delegation: { bundle: f.w.id } };
  await assert.rejects(
    prepareReviewContinuation(f.next, "reviewer", f.w.id),
    /assigned Task Lead/,
  );
  const plan = await prepareReviewContinuation(lead, "reviewer", f.w.id);
  const fresh = {
    id: "repo-" + randomUUID(),
    dir: path.join(f.next.scope, "repo-" + randomUUID()),
  };
  const contract = await attachReviewContinuation(lead, plan, fresh);
  assert.equal(contract.review.jobId, rev.jobId);
  assert.equal(contract.review.attempt, 1);
  const request = {
    role: "reviewer",
    bundle: f.w.id,
    jobId: rev.jobId,
    contract,
  };
  await writeJSON(path.join(fresh.dir, "request.json"), request);
  assert.equal(
    await readJSON(path.join(fresh.dir, `${rev.jobId}.draft.json`)),
    null,
  );
  assert.equal(
    await readJSON(path.join(fresh.dir, `${rev.jobId}.result.json`)),
    null,
  );
  await assert.rejects(
    prepareReviewContinuation(lead, "reviewer", f.w.id),
    /no unused continuation/,
  );
  const changed = await getWork(f.next.workScope, f.w.id);
  assert.equal(changed.reviews.length, 1);
  assert.equal(changed.reviewLimit, 1);
  assert.equal(changed.reviews[0].continuations[0].fromDir, rev.record.dir);
  // Fresh independent verdict still goes through normal target/coverage validation.
  await saveSubmission(lead, request, fresh.dir, rev.jobId, rev.brief);
  assert.equal(
    (await readJSON(path.join(rev.record.dir, `${rev.jobId}.result.json`)))
      .status,
    "needs-report",
  );
  await writeJSON(path.join(fresh.dir, `${rev.jobId}.result.json`), {
    jobId: rev.jobId,
    status: "settled",
    ...(await readJSON(path.join(fresh.dir, `${rev.jobId}.brief.json`))),
  });
  assert.equal((await workStatus(f.next, f.w.id)).reviewValid, true);
});
test("continuation refuses changed contracts/artifacts, pending progress and live reviewers", async (t) => {
  const { prepareReviewContinuation } =
    await import("../src/review-continuation.mjs");
  const f = await fixture(t),
    rev = await reviewer(f);
  await f.next.connect();
  const lead = { ...f.next, delegation: { bundle: f.w.id } };
  await assert.rejects(
    prepareReviewContinuation(lead, "reviewer", f.w.id),
    /PROGRESS_INPUT_PENDING/,
  );
  await acknowledgeProgress(
    f.root,
    f.next.workScope,
    "todo-tracker.md",
    "Status only",
  );
  await fs.writeFile(path.join(f.repo, "a.mjs"), "changed again");
  await assert.rejects(
    prepareReviewContinuation(lead, "reviewer", f.w.id),
    /artifacts changed/,
  );
  await fs.writeFile(path.join(f.repo, "a.mjs"), "export const a=2;\n");
  await writeJSON(path.join(rev.record.dir, "ready.json"), {
    instance: processIdentity(),
  });
  await assert.rejects(
    prepareReviewContinuation(lead, "reviewer", f.w.id),
    /confirmed dead/,
  );
  await writeJSON(path.join(rev.record.dir, "ready.json"), {
    instance: dead(),
  });
  const work = await getWork(f.next.workScope, f.w.id);
  work.noteRevision++;
  await writeJSON(path.join(f.next.workScope, "work", f.w.id + ".json"), work);
  await assert.rejects(
    prepareReviewContinuation(lead, "reviewer", f.w.id),
    /contract changed/,
  );
});

test("restored task tab can reclaim an exited old shell without adopting its agent", async (t) => {
  const { createTaskPane } = await import("../src/views.mjs");
  const f = await fixture(t),
    rev = await reviewer(f);
  await f.next.connect();
  const old = {
    ...rev.record,
    bundle: f.w.id,
    pane: "w1:p1",
    tab: "w1:t1",
    terminal: "old-terminal",
  };
  await writeJSON(path.join(f.old.scope, "agents.json"), [old]);
  await writeJSON(path.join(f.old.scope, "views", f.w.id + ".json"), {
    tab: old.tab,
    anchor: old.pane,
    closed: false,
  });
  const calls = [];
  const panes = [1, 2, 3, 4].map((n) => ({
    pane_id: "w1:p" + n,
    tab_id: old.tab,
    terminal_id: n === 1 ? old.terminal : "other",
  }));
  const client = {
    scope: f.next.scope,
    workScope: f.old.scope,
    env: { HERDR_WORKSPACE_ID: "w1" },
    call: async (args) => {
      calls.push(args);
      if (args[1] === "list") return { result: { panes } };
      if (args[1] === "get") return { result: { pane: panes[0] } };
      if (args[1] === "process-info")
        return {
          result: {
            process_info: {
              shell_pid: 2147483647,
              foreground_process_group_id: 2147483647,
              foreground_processes: [{ pid: 2147483647 }],
            },
          },
        };
      if (args[1] === "close") return { result: {} };
      if (args[1] === "split")
        return { result: { pane: { pane_id: "w1:p5", tab_id: old.tab } } };
      throw Error("Unexpected call " + args);
    },
  };
  await createTaskPane(client, { bundle: f.w.id, path: f.root }, undefined, []);
  assert.equal(calls.filter((c) => c[1] === "close").length, 1);
  assert.deepEqual(await f.next.records(), []);
});
