import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  registerProgress,
  requireProgress,
  recordProgressWrite,
  acknowledgeProgress,
  isProgress,
} from "../src/documents.mjs";
import { retainOutput, readArtifact, recordUsage } from "../src/artifacts.mjs";
import { scopedSourceBase, scopedInstructions } from "../src/scopes.mjs";
import { reviewProgress } from "../src/progress.mjs";
import {
  createTaskPane,
  maintainViews,
  shellAvailable,
} from "../src/views.mjs";
import { writeJSON, readJSON } from "../src/storage.mjs";
import {
  approvalScopeStatus,
  addReviewDependencies,
} from "../src/approval.mjs";
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-unified-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test("progress is explicit, scoped, and external edits must be reconciled", async (t) => {
  const root = await fixture(t),
    scope = path.join(root, "state");
  await fs.mkdir(path.join(root, "repo", ".git"), { recursive: true });
  await fs.writeFile(path.join(root, "tracker.md"), "ready");
  assert.equal(await isProgress(scope, "tracker.md"), false);
  await registerProgress(root, scope, "p", ["tracker.md"]);
  await assert.rejects(
    registerProgress(root, scope, "p", ["AGENTS.md"]),
    /Instruction/,
  );
  await assert.rejects(
    registerProgress(root, scope, "p", ["repo/docs.md"]),
    /Repository/,
  );
  await assert.rejects(
    registerProgress(root, scope, "p", ["../escape.md"]),
    /relative/,
  );
  await requireProgress(root, scope);
  await fs.writeFile(path.join(root, "tracker.md"), "user change");
  await assert.rejects(requireProgress(root, scope), /PROGRESS_INPUT_PENDING/);
  await assert.rejects(
    acknowledgeProgress(root, scope, "tracker.md", ""),
    /Explain/,
  );
  await acknowledgeProgress(
    root,
    scope,
    "tracker.md",
    "Status only; no requirements changed",
  );
  await requireProgress(root, scope);
  await fs.writeFile(path.join(root, "tracker.md"), "done");
  await recordProgressWrite(root, scope, "tracker.md");
  await requireProgress(root, scope);
});
test("reviewer does not bind declared progress but binds other metadata", async (t) => {
  const root = await fixture(t),
    scope = path.join(root, "state"),
    dir = path.join(root, "review");
  await fs.writeFile(path.join(root, "tracker.md"), "ready");
  await fs.writeFile(path.join(root, "contract.md"), "contract");
  await registerProgress(root, scope, "p", ["tracker.md"]);
  const request = {
    role: "reviewer",
    contract: {
      root,
      review: {
        workScope: scope,
        projectBinding: { scope, id: "p", revision: 1 },
        targets: {},
      },
    },
  };
  await writeJSON(path.join(scope, "projects", "p.json"), { revision: 1 });
  await addReviewDependencies(request, dir, "job", {
    files: ["tracker.md", "contract.md"],
  });
  const approval = await readJSON(path.join(dir, "job.scope.json"));
  assert.equal(Object.hasOwn(approval.files, "tracker.md"), false);
  assert.equal(Object.hasOwn(approval.files, "contract.md"), true);
  await fs.writeFile(path.join(root, "tracker.md"), "changed");
  assert.equal(
    (await approvalScopeStatus(approval)).reason,
    "progress_input_pending",
  );
  await recordProgressWrite(root, scope, "tracker.md");
  assert.equal((await approvalScopeStatus(approval)).valid, true);
  await fs.writeFile(path.join(root, "contract.md"), "new contract");
  assert.deepEqual((await approvalScopeStatus(approval)).changed, [
    "contract.md",
  ]);
});
test("large tool output retains errors and supports bounded retrieval", async (t) => {
  const root = await fixture(t),
    text = "begin\n" + "x".repeat(20000) + "\nERROR 42";
  const result = await retainOutput(
    root,
    "job",
    "bash",
    [{ type: "text", text }],
    { isError: true },
  );
  assert.ok(result.content[0].text.length < 8192);
  assert.match(result.content[0].text, /ERROR 42/);
  const output = await readArtifact(root, result.details.artifact, {
    query: "ERROR 42",
    limit: 1000,
  });
  assert.equal(output.isError, true);
  assert.match(output.text, /ERROR 42/);
  assert.equal(
    await retainOutput(root, "job", "read", [{ type: "text", text: "small" }]),
    null,
  );
  await assert.rejects(readArtifact(root, "../secrets"), /Invalid/);
  await recordUsage(root, {
    role: "assistant",
    usage: { input: 1000, cacheRead: 65000 },
  });
  assert.equal(
    (await readJSON(path.join(root, "context-pressure.json"))).rotateSuggested,
    true,
  );
});
test("root reviewer source is limited to assigned repositories plus metadata", async (t) => {
  const root = await fixture(t);
  for (const repo of ["a", "b"])
    await fs.mkdir(path.join(root, repo, ".git"), { recursive: true });
  const launch = { root, cwd: root },
    request = { bundle: "task", contract: { repos: ["a"] } };
  assert.deepEqual(
    await scopedSourceBase(request, launch, { action: "list" }),
    { roster: ["a"] },
  );
  assert.equal(
    (
      await scopedSourceBase(request, launch, {
        action: "read",
        file: "a/main.js",
      })
    ).base,
    root,
  );
  await assert.rejects(
    scopedSourceBase(request, launch, { action: "search", file: "b" }),
    /Narrow/,
  );
  await assert.rejects(
    scopedSourceBase(request, launch, { action: "read", file: "b/AGENTS.md" }),
    /outside/,
  );
  await fs.writeFile(path.join(root, "a", "AGENTS.md"), "child rules");
  const instructions = await scopedInstructions(root, ["a"]);
  assert.equal(
    instructions.find((i) => i.file === "a/AGENTS.md").text,
    "child rules",
  );
  assert.equal(
    instructions.find((i) => i.file === "AGENTS.md").signature,
    null,
  );
});
test("new job IDs and revisions do not reset no-progress review guard", async (t) => {
  const scope = await fixture(t),
    value = { id: "task", requirements: "same" },
    targets = { repo: { target: "sha" } };
  await reviewProgress(scope, "work", value, targets, { requirements: "same" });
  await reviewProgress(scope, "work", { ...value, revision: 2 }, targets, {
    requirements: "same",
  });
  await assert.rejects(
    reviewProgress(scope, "work", { ...value, revision: 3 }, targets, {
      requirements: "same",
    }),
    /NO_PROGRESS/,
  );
  await reviewProgress(
    scope,
    "work",
    value,
    { repo: { target: "changed" } },
    { requirements: "same" },
  );
});
test("task tab reused; capacity never closes or splits running panes", async (t) => {
  const scope = await fixture(t),
    calls = [],
    panes = [];
  const client = {
    workScope: scope,
    env: { HERDR_WORKSPACE_ID: "w1" },
    call: async (args) => {
      calls.push(args);
      if (args[0] === "tab") {
        panes.push({ pane_id: "w1:p2", tab_id: "w1:t2" });
        return { result: { tab: { tab_id: "w1:t2" }, root_pane: panes[0] } };
      }
      if (args[1] === "list") return { result: { panes } };
      if (args[1] === "split") {
        const pane = { pane_id: "w1:p" + (panes.length + 2), tab_id: "w1:t2" };
        panes.push(pane);
        return { result: { pane } };
      }
      throw Error("Unexpected mutation");
    },
  };
  for (let i = 0; i < 4; i++)
    await createTaskPane(
      client,
      { id: "id" + i, bundle: "task", label: "role", path: scope },
      undefined,
      [],
    );
  assert.equal(calls.filter((a) => a[0] === "tab").length, 1);
  assert.equal(calls.filter((a) => a[1] === "split").length, 3);
  await assert.rejects(
    createTaskPane(client, { bundle: "task" }, undefined, []),
    /CAPACITY/,
  );
  assert.equal(
    calls.some((a) => a[1] === "close"),
    false,
  );
});
test("cleanup never retires active or user-kept sessions", async (t) => {
  const scope = await fixture(t),
    dir = path.join(scope, "child");
  await writeJSON(path.join(scope, "agents.json"), [
    { id: "child", dir, bundle: "task", tab: "t", terminal: "term", pane: "p" },
  ]);
  await writeJSON(path.join(scope, "work", "task.json"), {
    status: "completed",
    lead: { dir },
  });
  await writeJSON(path.join(dir, "request.json"), { jobId: "j" });
  await writeJSON(path.join(dir, "j.result.json"), {
    brief: { outcome: "completed" },
    status: "settled",
  });
  await writeJSON(path.join(dir, "keep.json"), { keep: true });
  const calls = [],
    client = {
      scope,
      call: async (args) => {
        calls.push(args);
        return { result: { panes: [] } };
      },
      env: { HERDR_WORKSPACE_ID: "w" },
    };
  await maintainViews(client);
  assert.equal(await readJSON(path.join(dir, "retired.json")), null);
  assert.equal(
    calls.some((a) => a[1] === "close"),
    false,
  );
});

test("verification records exit code and retained log without automatic reuse", async (t) => {
  const { runCheck } = await import("../src/checks.mjs"),
    dir = await fixture(t);
  const result = await runCheck(dir, "job", dir, {
    command: "printf 'verified'; exit 7",
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.isError, true);
  assert.equal(result.complete, true);
  const artifact = await readArtifact(dir, result.id);
  assert.equal(artifact.text, "verified");
  const timed = await runCheck(dir, "job", dir, {
    command: "sleep 3",
    timeout: 1,
  });
  assert.equal(timed.reason, "timeout");
  assert.equal(timed.isError, true);
});

test("pane identity and foreground ownership are mandatory for cleanup/reuse", async (t) => {
  const root = await fixture(t),
    record = { pane: "p", tab: "t", terminal: "owned" };
  const wrong = {
    call: async () => ({
      result: { pane: { terminal_id: "user", tab_id: "t" } },
    }),
  };
  assert.equal(await shellAvailable(wrong, record), false);
  const busy = {
    call: async (args) =>
      args[1] === "get"
        ? { result: { pane: { terminal_id: "owned", tab_id: "t" } } }
        : {
            result: {
              process_info: {
                shell_pid: 10,
                foreground_process_group_id: 20,
                foreground_processes: [{ pid: 20 }],
              },
            },
          },
  };
  assert.equal(await shellAvailable(busy, record), false);
});

test("raw evidence is shared only with reviewers of the owning task", async (t) => {
  const { evidenceDirectory } = await import("../src/artifacts.mjs"),
    scope = await fixture(t);
  await writeJSON(path.join(scope, "work", "task.json"), {
    members: [{ id: "worker", dir: "/saved/worker" }],
  });
  const request = {
    role: "reviewer",
    contract: { review: { workScope: scope, kind: "work", id: "task" } },
  };
  assert.equal(
    await evidenceDirectory({}, request, "/own", "worker"),
    "/saved/worker",
  );
  await assert.rejects(
    evidenceDirectory({}, request, "/own", "other"),
    /outside/,
  );
  await assert.rejects(
    evidenceDirectory({}, { ...request, role: "task_lead" }, "/own", "worker"),
    /restricted/,
  );
});

test("completed project also retires its idle Oracle view", async (t) => {
  const { processIdentity } = await import("../src/lifecycle.mjs"),
    scope = await fixture(t),
    dir = path.join(scope, "oracle");
  await writeJSON(path.join(scope, "agents.json"), [
    {
      id: "oracle",
      dir,
      role: "oracle",
      bundle: "project",
      pane: "p",
      tab: "t",
      terminal: "terminal",
    },
  ]);
  await writeJSON(path.join(scope, "projects", "project.json"), {
    status: "completed",
  });
  await writeJSON(path.join(dir, "request.json"), { jobId: "j" });
  await writeJSON(path.join(dir, "j.result.json"), {
    status: "settled",
    brief: { outcome: "completed", verdict: "pass" },
  });
  await writeJSON(path.join(dir, "ready.json"), {
    managed: true,
    instance: processIdentity(),
  });
  const client = {
    scope,
    env: { HERDR_WORKSPACE_ID: "w" },
    call: async (args) =>
      args[0] === "agent"
        ? { result: { agent: { pane_id: "p", status: "idle" } } }
        : { result: { panes: [] } },
  };
  await maintainViews(client);
  assert.equal(
    (await readJSON(path.join(dir, "retired.json"))).reason,
    "task-approved",
  );
});
