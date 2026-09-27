import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { herdr, readJSON, writeJSON } from "../src/core.mjs";

const [taskArg, evidenceArg] = process.argv.slice(2);
if (!taskArg || !evidenceArg)
  throw new Error(
    "Usage: npm run test:live -- TASK_ROOT EVIDENCE_DIRECTORY (inside Herdr)",
  );
if (process.env.HERDR_ENV !== "1") throw new Error("Run inside a Herdr pane.");
const root = await fs.realpath(taskArg);
const evidence = path.resolve(evidenceArg);
assert.equal(
  (await readJSON(path.join(root, "demo-fixture.json")))?.type,
  "pi-herdr-multi-repo-subagents-demo",
  "Use a fresh create-demo.mjs fixture.",
);
await fs.mkdir(evidence, { recursive: true });
const creation = await herdr([
  "tab",
  "create",
  "--workspace",
  process.env.HERDR_WORKSPACE_ID,
  "--label",
  "Demo coordinator",
  "--cwd",
  root,
  "--no-focus",
]);
const pane = creation.result.root_pane.pane_id;
const name = `demo-${Date.now().toString(36)}`;
const args = [
  "agent",
  "start",
  name,
  "--kind",
  "pi",
  "--pane",
  pane,
  "--",
  "--extension",
  fileURLToPath(new URL("../src/index.ts", import.meta.url)),
  "--session-dir",
  path.join(evidence, "parent-sessions"),
];
if (process.env.PI_TEST_MODEL) args.push("--model", process.env.PI_TEST_MODEL);
const started = await herdr(args);
const session = started.result.agent.agent_session.value;
const prompt = `This is an authorized live integration test in a generated fixture. Read AGENTS.md and references/timeout-contract.md. Discover repositories with repo_agent_list. Delegate implementation, npm test and npm run build to separate backend and frontend Pi agents using repo_agent_start; do not implement their code yourself. Start both before waiting. Let automatic notifications resume you; do not write polling loops or repeatedly call wait. After both reports, use repo_agent_prompt on backend to review the diff and add/test the 0ms boundary case. Once its follow-up report arrives, verify the two modules together from the task root: retryLabel(timeoutResponse(1250)) must equal 'Retry in 1250 ms'. Update todo-tracker.md according to applicable instructions. Keep all child tabs open. End with DEMO-INTEGRATION-COMPLETE.`;
await herdr(["agent", "prompt", name, prompt]);
async function waitFor(marker) {
  const deadline = Date.now() + Number(process.env.PI_TEST_TIMEOUT ?? 300000);
  for (;;) {
    const entries = (await fs.readFile(session, "utf8"))
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    if (
      entries.some(
        (e) =>
          e.type === "message" &&
          e.message.role === "assistant" &&
          e.message.content?.some(
            (c) => c.type === "text" && c.text.trim().endsWith(marker),
          ),
      )
    )
      return entries;
    const agent = (await herdr(["agent", "get", name])).result.agent;
    if (agent.agent_status === "blocked")
      throw new Error(`Coordinator blocked; inspect ${name} in ${pane}.`);
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for ${marker}; tabs retained. Do not resubmit blindly.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
await waitFor("DEMO-INTEGRATION-COMPLETE");
await herdr([
  "agent",
  "prompt",
  name,
  "Test fresh-session handoff now. Explain why the completed implementation context can be replaced for an independent handoff review. Use repo_agent_reset for backend with a concise handoff, asking it only to read index.mjs/index.test.mjs and summarize current behavior and coverage, ending with RESET-CHILD-COMPLETE. Do not modify code. End your turn and let automatic reporting resume you. Once the report arrives, update the tracker and end with DEMO-RESET-COMPLETE.",
]);
const entries = await waitFor("DEMO-RESET-COMPLETE");
const toolResults = entries.filter(
  (e) => e.type === "message" && e.message.role === "toolResult",
);
assert.equal(
  toolResults.filter(
    (e) => e.message.toolName === "repo_agent_start" && !e.message.isError,
  ).length,
  2,
);
assert.ok(
  toolResults.some(
    (e) => e.message.toolName === "repo_agent_prompt" && !e.message.isError,
  ),
);
assert.ok(
  toolResults.some(
    (e) => e.message.toolName === "repo_agent_reset" && !e.message.isError,
  ),
);
const notifications = entries.filter(
  (e) => e.type === "custom_message" && e.customType === "repo-agent-reports",
);
const keys = notifications.flatMap((e) => e.details.deliveryKeys);
assert.equal(keys.length, new Set(keys).size, "Duplicate automatic reports");
assert.ok(
  keys.length >= 4,
  "Both initial reports, follow-up and reset must arrive automatically",
);
const tabs = await herdr([
  "tab",
  "list",
  "--workspace",
  process.env.HERDR_WORKSPACE_ID,
]);
const summary = {
  root,
  coordinator: name,
  pane,
  session,
  notifications: keys.length,
  tabs: tabs.result.tabs,
  verifiedAt: new Date().toISOString(),
};
await writeJSON(path.join(evidence, "live-result.json"), summary);
console.log(JSON.stringify(summary, null, 2));
