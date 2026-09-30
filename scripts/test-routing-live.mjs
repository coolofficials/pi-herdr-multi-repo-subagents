import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { herdr } from "../src/core.mjs";
import { familyRecords } from "../src/views.mjs";
import { readJSON, writeJSON } from "../src/storage.mjs";

assert.equal(
  process.env.HERDR_ENV,
  "1",
  "Use a genuine dedicated Herdr test pane.",
);
let base = path.resolve(process.argv[2] ?? "");
assert.ok(
  process.argv[2],
  "Provide a new isolated fixture/evidence directory.",
);
await fs.mkdir(base, { recursive: false }).catch(async (error) => {
  if (
    error.code !== "EEXIST" ||
    (await readJSON(path.join(base, "routing-fixture.json")))?.type !==
      "pi-routing-fixture"
  )
    throw error;
});
base = await fs.realpath(base);
await writeJSON(path.join(base, "routing-fixture.json"), {
  type: "pi-routing-fixture",
});
const until = async (check, timeout = 600000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw Error("Timeout. Inspect saved test evidence; never blindly resubmit.");
};
async function repo(dir) {
  await fs.mkdir(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  await fs.writeFile(
    path.join(dir, "index.mjs"),
    'export const label = "before";\n',
  );
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      scripts: {
        test: "node -e 'process.exit(73)'",
        build: "node -e 'process.exit(74)'",
      },
    }),
  );
  await fs.writeFile(path.join(dir, "README.md"), "Local label: before\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Fixture",
  ]);
}
function calls(session) {
  return session.flatMap((e) =>
    e.message?.role === "assistant"
      ? (e.message.content ?? []).filter((c) => c.type === "toolCall")
      : [],
  );
}
async function transcript(file) {
  return (await fs.readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
async function scenario(kind) {
  const root = path.join(base, kind),
    evidence = path.join(base, "evidence", kind);
  const savedResult = await readJSON(path.join(evidence, "result.json"));
  if (
    savedResult?.status === "passed" &&
    (await readJSON(path.join(savedResult.scope, "parent.json")))?.status ===
      "released"
  )
    return;
  const prior = await readJSON(path.join(evidence, "launch.json"));
  if (!prior) {
    await fs.mkdir(root);
    await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(
      path.join(root, "AGENTS.md"),
      "# Isolated test fixture\nPerform only the requested outcome. No blanket source survey or mandatory npm test/build. Choose checks for the requested result. Never publish this fixture.\n",
    );
    await repo(path.join(root, "repos", "app"));
    let prompt;
    if (kind === "clone") {
      const specs = [];
      for (let i = 1; i <= 4; i++) {
        const source = path.join(root, "references", `source-${i}`);
        await repo(source);
        specs.push({ source, destination: `repos/copy-${i}` });
      }
      prompt = `Clone these four local fixture repositories into their listed task-relative destinations: ${JSON.stringify(specs)}. This is only a clone request; no product changes. Finish the requested work and report the paths and checked-out commits. Do not publish anything.`;
    } else if (kind === "text" || kind === "text-v2") {
      prompt =
        "In repos/app/README.md change Local label: before to Local label: after. This is only a local documentation wording change. Confirm the requested text; do not publish anything.";
    } else if (kind === "reviewed") {
      prompt =
        "Change the exported label in repos/app/index.mjs from before to after. I explicitly require independent task review and final project review for this change. Use the Task Lead workflow, Node import to verify the value, then complete the project after Reviewer and Oracle approve. No npm test/build and no publishing.";
    } else {
      prompt =
        "Isolated execution-mode integration test. Deliberately start one single task for repos/app with one direct Implementer (no Task Lead). First assign that worker ONLY to inspect index.mjs and call repo_execution to escalate because changing its exported label is a public contract change, then report incomplete. On its automatic report, promote the SAME task to reviewed, retaining its original baseline. Resume the same Implementer to change label from before to after and verify by importing it with Node, without npm test/build. Request an independent Reviewer for this direct task with repo_request_review(task ID); complete the task with repo_work complete only after PASS. Request Oracle for the project, then complete the project. Never reimplement finished work, change baseline or create a Task Lead. Keep compact reports and stop on real blockers.";
    }
    const created = await herdr([
      "tab",
      "create",
      "--workspace",
      process.env.HERDR_WORKSPACE_ID,
      "--label",
      `Routing ${kind}`,
      "--cwd",
      root,
      "--env",
      `PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR}`,
      "--no-focus",
    ]);
    const pane = created.result.root_pane.pane_id,
      name = `route-${kind}-${Date.now().toString(36)}`;
    await writeJSON(path.join(evidence, "launch.json"), {
      root,
      pane,
      name,
      prompt,
    });
    let started = await herdr([
      "agent",
      "start",
      name,
      "--kind",
      "pi",
      "--pane",
      pane,
      "--",
      "--session-dir",
      path.join(evidence, "sessions"),
    ]);
  }
  const { pane, name } = await readJSON(path.join(evidence, "launch.json"));
  const submission = await readJSON(path.join(evidence, "submitted.json"));
  let session = submission?.session;
  const runs = path.join(
    process.env.PI_CODING_AGENT_DIR,
    "pi-herdr-multi-repo-subagents",
    "runs",
    createHash("sha256").update(root).digest("hex").slice(0, 20),
  );
  const scope = await until(async () => {
    for (const run of await fs.readdir(runs).catch(() => [])) {
      const parent = await readJSON(path.join(runs, run, "parent.json"));
      if (parent?.pane === pane && parent.status === "active")
        return parent.scope;
    }
  }, 30000);
  if (!session)
    session = (await readJSON(path.join(scope, "parent.json"))).sessionFile;
  if (!submission) {
    await writeJSON(path.join(evidence, "submitted.json"), {
      session,
      intent: true,
    });
    await herdr([
      "agent",
      "prompt",
      name,
      (await readJSON(path.join(evidence, "launch.json"))).prompt,
    ]);
  }
  const project = await until(async () => {
    for (const file of await fs
      .readdir(path.join(scope, "projects"))
      .catch(() => [])) {
      const p = await readJSON(path.join(scope, "projects", file));
      if (p?.status === "completed") return p;
    }
  });
  await until(
    async () =>
      ["idle", "done"].includes(
        (await herdr(["agent", "get", name])).result.agent.agent_status ??
          (await herdr(["agent", "get", name])).result.agent.status,
      ),
    30000,
  );
  const work = await readJSON(
    path.join(scope, "work", project.tasks[0] + ".json"),
  );
  const records = await familyRecords(scope);
  const mainCalls = calls(await transcript(session));
  assert.ok(
    mainCalls.every((c) => c.name.startsWith("repo_")),
    "Orchestrator must not read/edit code or run shell",
  );
  assert.equal(project.tasks.length, 1);
  assert.equal(
    records.filter((r) => r.role === "task_lead").length,
    kind === "reviewed" ? 1 : 0,
  );
  const workers = records.filter((r) => r.role === "implementer");
  assert.equal(workers.length, 1);
  const workerCalls = calls(
    await transcript(
      (await readJSON(path.join(workers[0].dir, "ready.json"))).sessionFile,
    ),
  );
  if (kind === "clone") {
    assert.equal(work.executionMode, "single");
    assert.equal(work.reviews.length, 0);
    assert.equal(project.reviews.length, 0);
    assert.deepEqual(
      records.map((r) => r.role),
      ["implementer"],
    );
    assert.ok(
      !workerCalls.some(
        (c) =>
          c.name === "read" &&
          /index\.mjs|package\.json/.test(c.arguments?.path ?? ""),
      ),
      "Clone does not need source reads",
    );
    assert.ok(
      !workerCalls.some((c) =>
        /npm (test|run build)|git show|cat .*index\.mjs/.test(
          c.arguments?.command ?? "",
        ),
      ),
      "No unrequested build/tests/source survey",
    );
    for (let i = 1; i <= 4; i++)
      assert.equal(
        execFileSync(
          "git",
          ["-C", path.join(root, "repos", `copy-${i}`), "rev-parse", "HEAD"],
          { encoding: "utf8" },
        ).trim(),
        execFileSync(
          "git",
          [
            "-C",
            path.join(root, "references", `source-${i}`),
            "rev-parse",
            "HEAD",
          ],
          { encoding: "utf8" },
        ).trim(),
      );
  } else if (kind === "text" || kind === "text-v2") {
    assert.equal(work.executionMode, "single");
    assert.equal(work.reviews.length, 0);
    assert.equal(project.reviews.length, 0);
    assert.deepEqual(
      records.map((r) => r.role),
      ["implementer"],
    );
    assert.equal(
      await fs.readFile(path.join(root, "repos/app/README.md"), "utf8"),
      "Local label: after\n",
    );
    assert.ok(
      !workerCalls.some((c) =>
        /npm (test|run build)/.test(c.arguments?.command ?? ""),
      ),
    );
  } else {
    assert.equal(work.executionMode, "reviewed");
    assert.equal(work.reviews.length, 1);
    assert.equal(project.reviews.length, 1);
    assert.deepEqual(
      records.map((r) => r.role).sort(),
      kind === "reviewed"
        ? ["implementer", "oracle", "reviewer", "task_lead"]
        : ["implementer", "oracle", "reviewer"],
    );
    if (kind !== "reviewed")
      assert.ok(workerCalls.some((c) => c.name === "repo_execution"));
    if (kind !== "reviewed")
      assert.ok(
        mainCalls.some(
          (c) => c.name === "repo_work" && c.arguments.action === "promote",
        ),
      );
    assert.match(
      await fs.readFile(path.join(root, "repos/app/index.mjs"), "utf8"),
      /after/,
    );
  }
  await writeJSON(path.join(evidence, "result.json"), {
    kind,
    status: "passed",
    root,
    scope,
    project,
    work,
    roles: records.map((r) => r.role),
    mainCalls: mainCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
    workerCalls: workerCalls.map((c) => ({
      name: c.name,
      arguments: c.arguments,
    })),
  });
  await herdr(["agent", "send-keys", name, "ctrl+d"]);
  await until(
    async () =>
      !(await herdr(["agent", "list"])).result.agents.some(
        (a) => a.name === name || records.some((r) => r.id === a.name),
      ),
    60000,
  );
  console.log(`ROUTING-${kind.toUpperCase()}-PASS`);
}
try {
  await scenario("clone");
  await scenario("text-v2");
  await scenario("promotion");
  await scenario("reviewed");
  await writeJSON(path.join(base, "result.json"), {
    status: "passed",
    scenarios: ["clone", "text-v2", "promotion", "reviewed"],
    agents: (await herdr(["agent", "list"])).result.agents,
  });
  await fs
    .rename(
      path.join(base, "error.json"),
      path.join(base, "initial-harness-error.json"),
    )
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  console.log("ROUTING-LIVE-COMPLETE");
} catch (error) {
  await writeJSON(path.join(base, "error.json"), {
    message: String(error),
    at: new Date().toISOString(),
  });
  console.error(error);
  process.exitCode = 1;
}
