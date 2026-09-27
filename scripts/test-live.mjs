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
let pane, name, session;
const savedStart = await readJSON(path.join(evidence, "live-start.json"));
if (savedStart) {
  if (savedStart.root !== root)
    throw new Error("Evidence belongs to another root.");
  ({ pane, name, session } = savedStart);
} else {
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
  pane = creation.result.root_pane.pane_id;
  name = `demo-${Date.now().toString(36)}`;
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
  if (process.env.PI_TEST_MODEL)
    args.push("--model", process.env.PI_TEST_MODEL);
  const started = await herdr(args);
  session = started.result.agent.agent_session.value;
  await writeJSON(path.join(evidence, "live-start.json"), {
    root,
    pane,
    name,
    session,
  });
}
const prompt = `This is an authorized live integration test in a generated fixture. Use repo_agent_list. Start an explorer in repos/backend to inspect AGENTS.md and references/timeout-contract.md with repo_source scope=task and return a structured research brief. End your turn for automatic completion. Plan from that brief and create a repo_work bundle covering repos/backend and repos/frontend with the contract, acceptance conditions, npm test/build checks and the cross-module check retryLabel(timeoutResponse(1250)) === 'Retry in 1250 ms'. Reset the backend child to implementer and start the frontend child as implementer with this bundle. Delegate implementation and assigned tests/build; do not read or edit source yourself. After both implementation reports, use repo_agent_prompt on backend to add/test the 0ms boundary and perform the cross-module verification. Then reset each child to reviewer with the same bundle in fresh conversations. Reviewers must inspect changes with repo_review_changes and submit evidence and verdict through repo_agent_report. Resolve material findings within the review budget. Complete the bundle with repo_work only after current-state independent reviews pass. Update todo-tracker.md via repo_task_document. Keep child panes open. End with DEMO-INTEGRATION-COMPLETE.`;
if (!savedStart) await herdr(["agent", "prompt", name, prompt]);
async function waitFor(marker) {
  const deadline = Date.now() + Number(process.env.PI_TEST_TIMEOUT ?? 300000);
  for (;;) {
    const entries = (
      await fs.readFile(session, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      })
    )
      .trim()
      .split("\n")
      .filter(Boolean)
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
const alreadyReset = (await fs.readFile(session, "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .some(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.content?.some(
        (part) =>
          part.type === "text" &&
          part.text.trim().endsWith("DEMO-RESET-COMPLETE"),
      ),
  );
if (!alreadyReset)
  await herdr([
    "agent",
    "prompt",
    name,
    "Test fresh-session handoff now. Explain why the completed implementation context can be replaced for an independent handoff review. Use repo_agent_reset for backend with role=explorer, no bundle, and a concise handoff, asking it only to read index.mjs/index.test.mjs and summarize current behavior and coverage, ending with RESET-CHILD-COMPLETE. Do not modify code. End your turn and let automatic reporting resume you. Once the report arrives, update the tracker and end with DEMO-RESET-COMPLETE.",
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
const consumed = new Set(keys.filter((key) => key.endsWith(":report")));
for (const entry of toolResults) {
  if (entry.message.details?.report)
    consumed.add(`${entry.message.details.jobId}:report`);
}
assert.ok(
  keys.length >= 1,
  "At least one completion must resume the parent automatically",
);
assert.ok(
  consumed.size >= 7,
  "Research, implementation, follow-up, independent reviews and fresh handoff must be consumed",
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
  reportsConsumed: consumed.size,
  tabs: tabs.result.tabs,
  verifiedAt: new Date().toISOString(),
};
await writeJSON(path.join(evidence, "live-result.json"), summary);
console.log(JSON.stringify(summary, null, 2));
