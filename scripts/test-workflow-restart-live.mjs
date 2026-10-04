// Real Pi process/Herdr smoke, with deterministic review fixtures and no model requests.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
assert.equal(
  process.env.HERDR_ENV,
  "1",
  "Run in a dedicated genuine Herdr test pane.",
);
const base = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Provide a new isolated test directory.");
await fs.mkdir(base, { recursive: false });
const root = path.join(base, "task"),
  profile = path.join(base, "profile"),
  evidence = path.join(base, "evidence");
await fs.mkdir(path.join(root, "repo"), { recursive: true });
await fs.mkdir(profile);
await fs.mkdir(evidence);
await exec("git", ["init", "-q", path.join(root, "repo")]);
await fs.writeFile(path.join(root, "repo", "a.mjs"), "export const a=1;\n");
await fs.writeFile(path.join(root, "todo-tracker.md"), "Fixture progress\n");
await fs.writeFile(
  path.join(root, "pi-herdr.json"),
  JSON.stringify({ board: false }),
);
await fs.writeFile(
  path.join(profile, "settings.json"),
  JSON.stringify({ packages: [], quietStartup: true }),
);
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const source = path.dirname(entry);
const probe = path.join(base, "probe.ts");
await fs.writeFile(
  probe,
  `
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Controller } from ${JSON.stringify(path.join(source, "core.mjs"))};
import { createProject, createWork, prepareAssignment, getWork, workStatus } from ${JSON.stringify(path.join(source, "hierarchy.mjs"))};
import { saveSubmission } from ${JSON.stringify(path.join(source, "reports.mjs"))};
import { acknowledgeProgress } from ${JSON.stringify(path.join(source, "documents.mjs"))};
import { writeJSON, readJSON } from ${JSON.stringify(path.join(source, "storage.mjs"))};
export default function probe(pi) {
  pi.on("session_start", async (_, ctx) => {
    try {
      assert.equal(process.env.HERDR_ENV, "1");
      assert.ok(process.env.HERDR_PANE_ID);
      const client = new Controller({ root: ctx.cwd, owner: ctx.sessionManager.getSessionId() });
      await client.connect({ sessionFile: ctx.sessionManager.getSessionFile() });
      const saved = ${JSON.stringify(evidence)};
      const phase = process.env.PI_RECOVERY_TEST_PHASE;
      if (phase === "first") {
        pi.sendMessage({ customType: "workflow-test", content: "Deterministic owned recovery fixture; no model review claimed.", display: false });
        const project = await createProject(client, { title: "Recovery fixture", requirements: "Change a", progressDocuments: ["todo-tracker.md"] });
        const work = await createWork(client, { project: project.id, title: "A", requirements: "Change a", repos: ["repo"] });
        await fs.writeFile(path.join(ctx.cwd, "repo", "a.mjs"), "export const a=2;\\n");
        const jobId = randomUUID(), id = "repo-" + randomUUID();
        const record = { id, dir: path.join(client.scope, id), role: "reviewer", repo: ".", jobId };
        const lead = { ...client, delegation: { bundle: work.id }, records: async () => [] };
        const contract = await prepareAssignment(lead, record, jobId, "reviewer", work.id);
        const request = { jobId, role: "reviewer", bundle: work.id, contract };
        await writeJSON(path.join(record.dir, "request.json"), request);
        await writeJSON(path.join(record.dir, "ready.json"), { instance: { pid: 2147483647, started: "dead synthetic review fixture", host: os.hostname() }, cleanExit: true });
        await writeJSON(path.join(record.dir, jobId + ".inspection.json"), { repo: { target: contract.review.targets.repo.target, files: { "a.mjs": { complete: true, next: null } } } });
        await fs.appendFile(path.join(ctx.cwd, "todo-tracker.md"), "External status-only edit\\n");
        await assert.rejects(saveSubmission(lead, request, record.dir, jobId, { outcome: "completed", verdict: "pass", summary: "Synthetic fixture verdict; no model quality claim", checks: ["Synthetic deterministic acceptance fixture"], references: ["repo/a.mjs"] }), /PROGRESS_INPUT_PENDING/);
        await writeJSON(path.join(record.dir, jobId + ".result.json"), { jobId, status: "needs-report", role: "reviewer" });
        // Pi defers persistence until an assistant answer. Persist only this
        // test-owned header/entries so the no-model fixture has a resumable file.
        await fs.mkdir(path.dirname(ctx.sessionManager.getSessionFile()), { recursive: true });
        await fs.writeFile(ctx.sessionManager.getSessionFile(), [ctx.sessionManager.getHeader(), ...ctx.sessionManager.getEntries()].map((e) => JSON.stringify(e)).join("\\n") + "\\n", { flag: "wx" }).catch((e) => { if (e.code !== "EEXIST") throw e; });
        await writeJSON(path.join(saved, "first.json"), { scope: client.scope, work: work.id, project: project.id, jobId, sessionFile: ctx.sessionManager.getSessionFile(), pid: process.pid, pane: process.env.HERDR_PANE_ID, tools: pi.getActiveTools() });
      } else {
        const old = await readJSON(path.join(saved, "first.json"));
        assert.notEqual(client.scope, old.scope);
        assert.equal(client.workScope, old.scope);
        assert.ok(pi.getActiveTools().includes("repo_workflow"));
        assert.ok(!pi.getActiveTools().includes("bash"));
        assert.deepEqual(await client.records(), []);
        const work = await getWork(client.workScope, old.work);
        assert.equal(work.reviewLimit, 3);
        assert.equal(work.reviews.length, 1);
        assert.equal(work.reviews[0].jobId, old.jobId);
        await acknowledgeProgress(client.root, client.workScope, "todo-tracker.md", "Fixture changed status only");
        const repaired = await client.workflow({ action: "repair_report", id: old.work, kind: "task" });
        assert.equal(repaired.status, "report-repaired");
        assert.equal((await workStatus(client, old.work)).reviewValid, true);
        const history = await client.workflow({ action: "evidence", id: old.work });
        assert.equal(history.report.brief.verdict, "pass");
        await writeJSON(path.join(saved, "second.json"), { status: "passed", scope: client.scope, workScope: client.workScope, work: old.work, jobId: old.jobId, attempts: work.reviews.length, reviewLimit: work.reviewLimit, adoptedAgents: (await client.records()).length, repaired: repaired.status, pid: process.pid, pane: process.env.HERDR_PANE_ID, tools: pi.getActiveTools(), limitation: "Real Pi process restart and tool loading; review artifacts are synthetic, no model-backed hierarchy/quality test." });
        await client.release("test-complete");
      }
      client.lifecycle?.close();
      process.exit(0);
    } catch (error) { await fs.writeFile(path.join(${JSON.stringify(evidence)}, "error-" + process.env.PI_RECOVERY_TEST_PHASE + ".txt"), String(error.stack)); process.exit(1); }
  });
}
`,
);
const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: profile,
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
};
const args = [
  "--mode",
  "rpc",
  "--offline",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--extension",
  entry,
  "--extension",
  probe,
  "--session-dir",
  path.join(evidence, "sessions"),
];
for (const phase of ["first", "second"]) {
  const first =
    phase === "second"
      ? JSON.parse(await fs.readFile(path.join(evidence, "first.json"), "utf8"))
      : null;
  try {
    const result = await exec(
      "pi",
      [...args, ...(first ? ["--session", first.sessionFile] : [])],
      {
        cwd: root,
        env: { ...env, PI_RECOVERY_TEST_PHASE: phase },
        timeout: 60000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    await fs.writeFile(
      path.join(evidence, phase + ".stdout.log"),
      result.stdout,
    );
    await fs.writeFile(
      path.join(evidence, phase + ".stderr.log"),
      result.stderr,
    );
  } catch (error) {
    await fs.writeFile(
      path.join(evidence, phase + ".stderr.log"),
      String(error.stderr ?? error),
    );
    throw error;
  }
}
const result = JSON.parse(
  await fs.readFile(path.join(evidence, "second.json"), "utf8"),
);
assert.equal(result.status, "passed");
console.log(JSON.stringify(result));
