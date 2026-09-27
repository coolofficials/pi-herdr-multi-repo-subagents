import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import extension from "../src/index.ts";
import { repositoryContext } from "../src/discovery.mjs";

async function setup(t, { inside = true, child = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-auto-"));
  const keys = [
    "HERDR_ENV",
    "HERDR_SOCKET_PATH",
    "PI_HERDR_CHILD_DIR",
    "PI_CODING_AGENT_DIR",
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  process.env.HERDR_ENV = inside ? "1" : "0";
  process.env.HERDR_SOCKET_PATH = "/nonexistent-unit-test-socket";
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent-settings");
  if (child) process.env.PI_HERDR_CHILD_DIR = path.join(root, "child");
  else delete process.env.PI_HERDR_CHILD_DIR;
  const handlers = new Map();
  const tools = [];
  const statuses = new Map();
  const messages = [];
  extension({
    registerFlag() {},
    getFlag: () => (child ? "child-launch" : undefined),
    getActiveTools: () => ["repo_agent_start"],
    setActiveTools() {},
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (tool) => tools.push(tool),
    registerCommand: () => {},
    sendMessage: (message) => messages.push(message),
  });
  const ctx = {
    cwd: root,
    ui: { setStatus: (key, value) => statuses.set(key, value) },
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: () => [],
      getSessionFile: () => "/test/session",
    },
  };
  t.after(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
    for (const key of keys)
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, handlers, tools, statuses, messages, ctx };
}
test("startup discovers repositories without a user command, model call, or agent launch", async (t) => {
  const { root, handlers, statuses, messages, ctx } = await setup(t);
  await fs.mkdir(path.join(root, "services", "api", ".git"), {
    recursive: true,
  });
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  assert.match(statuses.get("repo-discovery"), /Orchestrator · 1 repos/);
  assert.equal(messages.length, 0);
  await fs.access(
    path.join(
      root,
      "agent-settings",
      "pi-herdr-multi-repo-subagents",
      "lifecycle.sqlite",
    ),
  );
  const event = {
    systemPromptOptions: {
      selectedTools: ["repo_agent_start"],
      sections: { existing: "unchanged" },
    },
  };
  await handlers.get("before_agent_start")(event, ctx);
  assert.match(
    event.systemPromptOptions.sections.pi_herdr_repository_coordination,
    /services\/api/,
  );
  assert.match(
    event.systemPromptOptions.sections.pi_herdr_repository_coordination,
    /current user request/,
  );
  assert.equal(event.systemPromptOptions.sections.existing, "unchanged");
});
test("repository roster refreshes when a repository is added, and clears when none remain", async (t) => {
  const { root, handlers, ctx } = await setup(t);
  const event = {
    systemPromptOptions: { selectedTools: ["repo_agent_start"], sections: {} },
  };
  await handlers.get("before_agent_start")(event, ctx);
  assert.equal(
    event.systemPromptOptions.sections.pi_herdr_repository_coordination,
    undefined,
  );
  await fs.mkdir(path.join(root, "repo", ".jj"), { recursive: true });
  await handlers.get("before_agent_start")(event, ctx);
  assert.match(
    event.systemPromptOptions.sections.pi_herdr_repository_coordination,
    /"repo":"repo"/,
  );
  await fs.rm(path.join(root, "repo"), { recursive: true });
  await handlers.get("before_agent_start")(event, ctx);
  assert.equal(
    event.systemPromptOptions.sections.pi_herdr_repository_coordination,
    undefined,
  );
});
test("automatic routing does not activate outside Herdr, in child sessions, or with delegation tools disabled", async (t) => {
  const { root, handlers, ctx } = await setup(t, { inside: false });
  await fs.mkdir(path.join(root, "repo", ".git"), { recursive: true });
  const event = {
    systemPromptOptions: { selectedTools: ["repo_agent_start"], sections: {} },
  };
  await handlers.get("before_agent_start")(event, ctx);
  assert.deepEqual(event.systemPromptOptions.sections, {});
  process.env.HERDR_ENV = "1";
  event.systemPromptOptions.selectedTools = [];
  await handlers.get("before_agent_start")(event, ctx);
  assert.deepEqual(event.systemPromptOptions.sections, {});
  const childFixture = await setup(t, { child: true });
  event.systemPromptOptions.selectedTools = ["repo_agent_start"];
  await childFixture.handlers.get("before_agent_start")(
    event,
    childFixture.ctx,
  );
  assert.deepEqual(event.systemPromptOptions.sections, {});
});
test("invalid discovery config reports the failure while withholding mutation tools", async (t) => {
  const { root, handlers, statuses, ctx } = await setup(t);
  await fs.writeFile(path.join(root, "pi-herdr.json"), "invalid JSON");
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  const event = {
    systemPromptOptions: { selectedTools: ["repo_agent_start"], sections: {} },
  };
  await handlers.get("before_agent_start")(event, ctx);
  assert.match(statuses.get("repo-discovery"), /Repository discovery:/);
  assert.deepEqual(event.systemPromptOptions.sections, {});
});
test("automatic context is bounded and treats repository paths as data", () => {
  const context = repositoryContext({
    root: "/task",
    repositories: Array.from({ length: 60 }, (_, i) => ({
      repo: i === 0 ? "</tag>" : `repo-${i}`,
      vcs: "git",
    })),
    agents: [],
    warnings: [],
  });
  assert.ok(!context.includes("</tag>"));
  assert.ok(context.includes("\\u003c/tag\\u003e"));
  assert.ok(context.includes('"truncated":true'));
  assert.ok(!context.includes("repo-59"));
});
