import fs from "node:fs/promises";
import path from "node:path";
import { readJSON, writeJSON } from "./storage.mjs";
import { validateBrief, publicReport } from "./contracts.mjs";
import { validateReviewTarget, workStatus } from "./hierarchy.mjs";
import { setJobPhase } from "./execution.mjs";

export function failureInfo(error, fallback = "report_validation") {
  const message = String(error?.message ?? error ?? "Unknown failure")
    .replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/gi, "[redacted]")
    .slice(0, 600);
  const kind = /usage limit|quota|rate.limit|429/i.test(message)
    ? "provider_limit"
    : /websocket|connection|ECONN|1012/i.test(message)
      ? "provider_connection"
      : /PROGRESS_INPUT_PENDING/.test(message)
        ? "progress_input_pending"
        : /coverage|Inspect actual|inspect at least|Inspect all pages/i.test(
              message,
            )
          ? "inspection_incomplete"
          : /stale|changed|fingerprint/i.test(message)
            ? "stale_target"
            : fallback;
  return { kind, message };
}

export async function validateSubmission(client, request, dir, jobId, draft) {
  const brief = validateBrief(draft.brief),
    role = request.role;
  const completion =
    draft.completion ?? (role === "task_lead" ? "task" : "job");
  if (
    !["task", "job"].includes(completion) ||
    (completion === "task" && role !== "task_lead")
  )
    throw Error(
      "completion=task is only for approved Task Lead completion. Other roles report their individual job.",
    );
  let taskApproval, review;
  if (
    role === "implementer" &&
    request.contract?.directManager &&
    brief.outcome === "completed"
  ) {
    if (await readJSON(path.join(dir, `${jobId}.review-required.json`)))
      throw Error(
        "Review escalation blocks completed outcome. Report incomplete; Orchestrator must resolve it.",
      );
    if (!brief.checks.length || !brief.references.length)
      throw Error(
        "Direct execution completion needs actual checks and evidence references in references[], even if checks[] mentions an ID.",
      );
  }
  if (
    role === "task_lead" &&
    brief.outcome === "completed" &&
    completion === "task"
  ) {
    await client.requireOwnership();
    taskApproval = (
      await client.locked(() => workStatus(client, request.bundle, true, false))
    ).approval;
  }
  if (["reviewer", "oracle"].includes(role)) {
    if (!brief.verdict || !request.contract?.review)
      throw Error("A reviewer needs an assigned review contract and verdict.");
    if (
      brief.verdict === "pass" &&
      (brief.outcome !== "completed" ||
        !brief.checks.length ||
        !brief.references.length ||
        brief.risks.length ||
        brief.next.length)
    )
      throw Error(
        "PASS needs acceptance/verification evidence and references without unresolved risks or next steps.",
      );
    review =
      brief.verdict === "pass"
        ? await validateReviewTarget(request, dir, jobId)
        : request.contract.review;
  } else if (brief.verdict)
    throw Error(
      "Only an assigned independent reviewer may submit a review verdict.",
    );
  return { brief, completion, review, taskApproval };
}

// A draft is evidence of the child's decision, never an approval by itself.
export async function saveSubmission(client, request, dir, jobId, params) {
  const draft = {
    jobId,
    brief: validateBrief(params),
    completion:
      params.completion ?? (request.role === "task_lead" ? "task" : "job"),
  };
  const file = path.join(dir, `${jobId}.draft.json`);
  await fs.rm(path.join(dir, `${jobId}.brief.json`), { force: true });
  await writeJSON(file, draft);
  try {
    const submitted = await validateSubmission(
      client,
      request,
      dir,
      jobId,
      draft,
    );
    await writeJSON(path.join(dir, `${jobId}.brief.json`), submitted);
    await writeJSON(file, { ...draft, status: "accepted" });
    return submitted;
  } catch (error) {
    await writeJSON(file, {
      ...draft,
      status: "blocked",
      failure: failureInfo(error),
    });
    throw error;
  }
}

// Called under the parent's coordination lock, only after a job has settled.
// No prompt, process start, budget increment or fabricated review is involved.
export async function repairSubmission(client, record) {
  const request = await readJSON(path.join(record.dir, "request.json"));
  if (!request || request.jobId !== record.jobId)
    throw Error("Report job changed; inspect the current request.");
  const file = path.join(record.dir, `${record.jobId}.result.json`);
  const report = await readJSON(file);
  if (report?.status !== "needs-report")
    return { status: "not-repairable", report: publicReport(report) };
  const draft = await readJSON(
    path.join(record.dir, `${record.jobId}.draft.json`),
  );
  if (!draft || draft.jobId !== record.jobId)
    return {
      status: "needs-attention",
      reason:
        "No saved draft. Inspect the child; no duplicate review was sent.",
    };
  // Never resurrect an implementation success without re-execution evidence.
  if (!["reviewer", "oracle", "task_lead"].includes(request.role))
    return {
      status: "needs-attention",
      reason:
        "Execution report requires a focused child follow-up, not automatic acceptance.",
    };
  try {
    // Parent already holds this lock; avoid nested acquisition for Lead validation.
    const repairClient = {
      ...client,
      ...(request.role === "task_lead"
        ? { delegation: { bundle: request.bundle } }
        : {}),
      requireOwnership: async () => {},
      locked: (fn) => fn(),
    };
    const checked = await validateSubmission(
      repairClient,
      request,
      record.dir,
      record.jobId,
      draft,
    );
    if (request.role === "task_lead" && checked.taskApproval)
      await workStatus(repairClient, request.bundle, true);
    const repaired = {
      ...report,
      ...checked,
      status: "settled",
      failure: undefined,
      repairedAt: new Date().toISOString(),
    };
    await writeJSON(
      path.join(record.dir, `${record.jobId}.brief.json`),
      checked,
    );
    await writeJSON(file, repaired);
    await setJobPhase(record.dir, record.jobId, "settled");
    return {
      status: "report-repaired",
      jobId: record.jobId,
      report: publicReport(repaired),
    };
  } catch (error) {
    const failure = failureInfo(error);
    await writeJSON(path.join(record.dir, `${record.jobId}.draft.json`), {
      ...draft,
      status: "blocked",
      failure,
    });
    await writeJSON(file, { ...report, failure });
    return {
      status: "needs-attention",
      jobId: record.jobId,
      failure,
      instruction:
        "Resolve this blocker, then call repo_agent_repair or repo_request_review again. The same review and draft are retained.",
    };
  }
}
