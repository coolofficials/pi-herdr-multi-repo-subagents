import path from "node:path";
import { executionState } from "./execution.mjs";
import { getWork, getProject, listWork } from "./hierarchy.mjs";

const roles = {
  orchestrator: "Orchestrator",
  task_lead: "Task Lead",
  implementer: "Implementer",
  reviewer: "Reviewer",
  oracle: "Oracle",
  scout: "Scout",
  researcher: "Researcher",
};
export const clean = (value) =>
  String(value ?? "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const short = (value, limit = 80) => {
  const chars = [...clean(value)];
  return chars.length > limit
    ? chars.slice(0, limit - 1).join("") + "…"
    : chars.join("");
};
const roleTitle = (role) => roles[role] ?? clean(role);
export async function scopeTitle(scope, role, bundle, fallback) {
  if (!scope || !bundle) return fallback;
  try {
    return (
      role === "oracle"
        ? await getProject(scope, bundle)
        : await getWork(scope, bundle)
    ).title;
  } catch {
    return fallback;
  }
}
export async function childRows(records, scope) {
  return Promise.all(
    records
      .filter((r) => r.jobId)
      .map(async (record) => {
        const state = await executionState(record);
        const issue =
          ["interrupted", "recovered", "needs_report"].includes(state.phase) ||
          (state.report && state.report.brief?.outcome !== "completed");
        return {
          id: record.id,
          role: record.role ?? "implementer",
          repo: record.repo,
          title: await scopeTitle(
            scope,
            record.role,
            record.bundle,
            state.request?.task ?? record.repo,
          ),
          phase: state.phase,
          pending: state.pending,
          issue: Boolean(issue),
          status: issue
            ? state.report?.status === "settled"
              ? (state.report?.brief?.outcome ?? state.phase)
              : (state.report?.status ?? state.phase)
            : state.phase,
        };
      }),
  );
}
// Pure presentation: delivery acknowledgements never remove a still-running child.
export function describe({
  role,
  title,
  repo,
  idle,
  own,
  children = [],
  tasks,
  parent,
}) {
  const waiting = children.filter((c) => c.pending && !c.issue);
  const attention = children.filter((c) => c.issue);
  const done = children.filter((c) => !c.pending && !c.issue).length;
  let state = idle
    ? "idle"
    : role === "orchestrator" || role === "task_lead"
      ? "coordinating"
      : "working";
  if (idle && waiting.length)
    state = `waiting for ${waiting.length} ${waiting.length === 1 ? "child" : "children"}`;
  else if (idle && own?.pending)
    state =
      own.phase === "repairing_report"
        ? "repairing report"
        : "awaiting continuation";
  else if (idle && own?.phase === "settled") state = "reported";
  if (own && ["needs_report", "interrupted", "recovered"].includes(own.phase))
    state = own.phase.replaceAll("_", " ");
  if (attention.length) state += ` · ${attention.length} need attention`;
  const identity = roleTitle(role);
  const scope =
    role === "orchestrator" ? "Scope" : role === "oracle" ? "Project" : "Task";
  const lines = [`[${identity}] ${scope}: ${short(title)}`];
  if (tasks)
    lines[0] += ` | tasks: ${tasks.active} active / ${tasks.done} done`;
  lines.push(
    `State: ${state}${repo && repo !== "." ? ` | Repo: ${short(repo, 48)}` : ""}${parent ? ` | Reports to: ${roleTitle(parent)}` : ""}`,
  );
  const visible = [...attention, ...waiting];
  for (const child of visible.slice(0, 3)) {
    const target =
      child.repo &&
      child.repo !== "." &&
      !["task_lead", "oracle", "reviewer"].includes(child.role)
        ? child.repo
        : child.title;
    lines.push(
      `  → ${roleTitle(child.role)} [${short(child.id, 32)}] | ${short(target, 48)} | ${clean(child.status).replaceAll("_", " ")}`,
    );
  }
  if (visible.length > 3)
    lines.push(
      `  +${visible.length - 3} more · /repo-agents board for all tasks`,
    );
  if (children.length)
    lines.push(
      `Children: ${waiting.length} pending · ${attention.length} attention · ${done} reported`,
    );
  return {
    sessionName:
      role === "orchestrator"
        ? "Orchestrator"
        : `${identity} · ${short(title, 100)}`,
    status: `[${identity}] ${state}`,
    lines,
  };
}
export function publish(pi, ctx, view) {
  for (const key of ["repo-agents", "repo-discovery", "repo-role"])
    ctx.ui.setStatus(key, undefined);
  ctx.ui.setStatus("repo-workflow", view.status);
  if (ctx.hasUI)
    ctx.ui.setWidget("repo-workflow", view.lines, { placement: "aboveEditor" });
  if (pi.getSessionName?.() !== view.sessionName)
    pi.setSessionName(view.sessionName);
}
async function coordinatorView(pi, ctx, client) {
  const tasks = await listWork(client.workScope);
  const children = await childRows(
    (await client.records()).filter((r) => r.owner === client.owner),
    client.workScope,
  );
  publish(
    pi,
    ctx,
    describe({
      role: "orchestrator",
      title: path.basename(client.root),
      idle: ctx.isIdle(),
      children,
      tasks: {
        active: tasks.filter((t) => t.status !== "completed").length,
        done: tasks.filter((t) => t.status === "completed").length,
      },
    }),
  );
}
async function childView(pi, ctx, launch, dir, coordinator) {
  const own = await executionState({ dir });
  const role = own.request?.role ?? launch.role ?? "implementer";
  const title = await scopeTitle(
    launch.workScope,
    role,
    launch.bundle,
    own.request?.task ?? path.basename(launch.cwd),
  );
  const repo = path.relative(launch.root, launch.cwd) || ".";
  const children = coordinator
    ? await childRows(await coordinator.records(), launch.workScope)
    : [];
  publish(
    pi,
    ctx,
    describe({
      role,
      title,
      repo,
      own,
      idle: ctx.isIdle(),
      children,
      parent:
        launch.parentRole ??
        (launch.ancestors?.length ? "task_lead" : "orchestrator"),
    }),
  );
}

// Display failures must not block dispatch, report settlement or parent-exit handling.
export async function showCoordinator(pi, ctx, client) {
  try {
    await coordinatorView(pi, ctx, client);
  } catch {
    ctx.ui.setStatus(
      "repo-workflow",
      "[Orchestrator] status display unavailable",
    );
  }
}
export async function showChild(pi, ctx, launch, dir, coordinator) {
  try {
    await childView(pi, ctx, launch, dir, coordinator);
  } catch {
    ctx.ui.setStatus(
      "repo-workflow",
      `[${roleTitle(launch.role ?? "child")}] status display unavailable`,
    );
  }
}
