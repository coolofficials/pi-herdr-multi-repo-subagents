// @ts-check
import path from "node:path";
import { readJSON, writeJSON } from "./storage.mjs";
import { liveness } from "./lifecycle.mjs";

/** @typedef {'idle'|'running'|'waiting_children'|'needs_report'|'repairing_report'|'settled'|'interrupted'|'recovered'} JobPhase */
/** Read durable state once; recovery is terminal, never an implicit success.
 * @param {{dir:string}} member
 */
export async function executionState(member) {
  const [request, resultState, ready, activity, recovery] = await Promise.all([
    readJSON(path.join(member.dir, "request.json")),
    readJSON(path.join(member.dir, "job-state.json")),
    readJSON(path.join(member.dir, "ready.json")),
    readJSON(path.join(member.dir, "activity.json")),
    readJSON(path.join(member.dir, "recovered.json")),
  ]);
  const report = request
    ? await readJSON(path.join(member.dir, `${request.jobId}.result.json`))
    : null;
  /** @type {JobPhase} */
  let phase = "idle";
  if (recovery) phase = "recovered";
  else if (report)
    phase =
      report.status === "needs-report"
        ? "needs_report"
        : ["interrupted", "aborted", "cancelled-parent-exited"].includes(
              report.status,
            )
          ? "interrupted"
          : "settled";
  else if (request) {
    if (ready?.instance && liveness(ready.instance) === "dead")
      phase = "interrupted";
    else if (
      activity?.jobId === request.jobId &&
      ["waiting_children", "repairing_report"].includes(activity.status)
    )
      phase = activity.status;
    else phase = "running";
  }
  return {
    phase,
    request,
    report,
    ready,
    activity,
    recovery,
    checkpoint: resultState,
    pending: Boolean(request && !report && !recovery),
  };
}
/** @param {Array<{id:string,dir:string}>} members */
export async function childWorkState(members) {
  const waiting = /** @type {string[]} */ ([]),
    interrupted = /** @type {string[]} */ ([]);
  for (const member of members) {
    const state = await executionState(member);
    if (state.pending)
      (state.phase === "interrupted" ? interrupted : waiting).push(member.id);
  }
  return { waiting, interrupted };
}
/** @param {string} dir @param {string} jobId @param {JobPhase} phase @param {object} [extra] */
export async function setJobPhase(dir, jobId, phase, extra = {}) {
  await writeJSON(path.join(dir, "activity.json"), {
    jobId,
    status: phase,
    updatedAt: new Date().toISOString(),
    ...extra,
  });
}
/** Record an interrupted result without overwriting evidence from a settled job.
 * @param {string} dir
 */
export async function interruptRecoveredJob(dir) {
  const request = await readJSON(path.join(dir, "request.json"));
  if (
    request &&
    !(await readJSON(path.join(dir, `${request.jobId}.result.json`)))
  ) {
    await writeJSON(path.join(dir, `${request.jobId}.result.json`), {
      jobId: request.jobId,
      status: "interrupted",
      role: request.role,
      bundle: request.bundle,
      brief: {
        outcome: "incomplete",
        summary:
          "The process exited before reporting. Explicit recovery retired this job; inspect artifacts before resuming.",
        risks: ["No completion or review approval is implied by recovery."],
      },
      finishedAt: new Date().toISOString(),
    });
  }
  await writeJSON(path.join(dir, "job-state.json"), {
    jobId: null,
    messages: [],
    outcome: "interrupted",
  });
  if (request) await setJobPhase(dir, request.jobId, "recovered");
}
