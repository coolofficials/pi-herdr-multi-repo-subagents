import path from "node:path";
import { readJSON, writeJSON } from "./storage.mjs";
import { listWork, getWork } from "./hierarchy.mjs";
import { childWorkState } from "./execution.mjs";

const file = (client) => path.join(client.scope, "coordination-state.json");
export async function coordinationState(client, params) {
  const state = await readJSON(file(client), {});
  if (params.action === "status")
    return { states: Object.values(state).slice(-30) };
  if (params.action !== "set") throw Error("Use status or set.");
  const { id, status, nextAction, reason, question } = params;
  await getWork(client.workScope, id);
  if (client.delegation && client.delegation.bundle !== id)
    throw Error("Only the assigned task may be classified.");
  if (
    ![
      "authorized",
      "waiting_children",
      "waiting_user",
      "blocked_system",
      "done",
    ].includes(status)
  )
    throw Error("Invalid coordination status.");
  if (
    typeof nextAction !== "string" ||
    !nextAction.trim() ||
    nextAction.length > 1200
  )
    throw Error("Record a concrete next action (1–1200 characters).");
  if (
    ["waiting_user", "blocked_system"].includes(status) &&
    (!reason?.trim() || reason.length > 1200)
  )
    throw Error("Waiting/blocked states need a concrete reason.");
  if (
    status === "waiting_user" &&
    (!question?.trim() || question.length > 1200)
  )
    throw Error("waiting_user requires the actual question asked to the user.");
  if (
    status === "waiting_children" &&
    !(await childWorkState(await client.records())).waiting.length
  )
    throw Error(
      "waiting_children requires an actual unfinished child. Record a real blocker or next action instead.",
    );
  state[id] = {
    id,
    status,
    nextAction,
    reason,
    question,
    updatedAt: new Date().toISOString(),
  };
  await writeJSON(file(client), state);
  return state[id];
}

export async function settlementAdvice(client, lastAssistantText = "") {
  const children = await childWorkState(await client.records());
  if (children.waiting.length && !children.interrupted.length) return null;
  const saved = await readJSON(file(client), {});
  const tasks = (await listWork(client.workScope)).filter(
    (w) =>
      w.status !== "completed" &&
      (!client.delegation || w.id === client.delegation.bundle),
  );
  const unresolved = tasks.filter((w) => {
    const s = saved[w.id];
    if (s?.status === "blocked_system") return false;
    if (s?.status === "waiting_user" && lastAssistantText.includes(s.question))
      return false;
    return true;
  });
  if (!unresolved.length) return null;
  return {
    tasks: unresolved.slice(0, 20).map((w) => ({
      id: w.id,
      title: w.title,
      taskStatus: w.status,
      coordination: saved[w.id] ?? null,
    })),
    instruction:
      "Unfinished work has no active child or concrete blocker/question. Continue already-authorized next actions, or use repo_coordination to record a real system blocker or the actual question you ask the user. A status question does not revoke existing authorization. Do not infer new authorization, bypass review, redeploy or endlessly retry errors. This is one bounded continuation only.",
  };
}
