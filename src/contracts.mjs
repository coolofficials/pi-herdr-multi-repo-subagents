export const ROLES = [
  "task_lead",
  "oracle",
  "scout",
  "researcher",
  "implementer",
  "reviewer",
];
export const READ_ONLY_ROLES = new Set([
  "task_lead",
  "scout",
  "researcher",
  "reviewer",
  "oracle",
]);
export const MAIN_TOOLS = new Set([
  "repo_agent_list",
  "repo_agent_start",
  "repo_agent_prompt",
  "repo_agent_read",
  "repo_agent_reset",
  "repo_agent_forget",
  "repo_agent_recover",
  "repo_task_document",
  "repo_work",
  "repo_request_review",
  "repo_project",
]);
export const LEAD_TOOLS = new Set([
  "repo_agent_list",
  "repo_agent_start",
  "repo_agent_prompt",
  "repo_agent_read",
  "repo_agent_reset",
  "repo_agent_forget",
  "repo_agent_recover",
  "repo_work",
  "repo_request_review",
  "repo_task_note",
  "repo_task_input",
  "repo_agent_report",
]);
export const CHILD_TOOLS = new Set([
  "repo_source",
  "repo_research_fetch",
  "repo_agent_report",
  "repo_review_changes",
  "repo_review_scope",
  "repo_task_note",
  "repo_task_input",
]);
export function roleName(role = "implementer") {
  if (!ROLES.includes(role)) throw new Error("Unknown repository role.");
  return role;
}
export function validateBrief(value) {
  if (!value || !["completed", "blocked", "incomplete"].includes(value.outcome))
    throw new Error("Report outcome must be completed, blocked or incomplete.");
  if (
    typeof value.summary !== "string" ||
    !value.summary.trim() ||
    value.summary.length > 1200
  )
    throw new Error("Report summary must contain 1–1200 characters.");
  /** @type {{outcome: string, summary: string, facts: string[], decisions: string[], checks: string[], risks: string[], next: string[], references: string[], verdict?: string}} */
  const brief = {
    outcome: value.outcome,
    summary: value.summary,
    facts: [],
    decisions: [],
    checks: [],
    risks: [],
    next: [],
    references: [],
  };
  for (const key of [
    "facts",
    "decisions",
    "checks",
    "risks",
    "next",
    "references",
  ]) {
    const entries = value[key] ?? [];
    if (
      !Array.isArray(entries) ||
      entries.length > 8 ||
      entries.some((x) => typeof x !== "string" || x.length > 400)
    )
      throw new Error(
        `${key}: use at most 8 entries, each at most 400 characters.`,
      );
    brief[key] = entries;
  }
  if (value.verdict !== undefined) {
    if (!["pass", "changes_requested", "unknown"].includes(value.verdict))
      throw new Error("Invalid review verdict.");
    brief.verdict = value.verdict;
  }
  const encoded = JSON.stringify(brief);
  if (encoded.length > 6000)
    throw new Error(
      "Report exceeds 6000 characters. Preserve blockers and references; summarize investigation and logs.",
    );
  if (
    /```|(?:^|\n)(?:diff --git |@@ .*@@)/m.test(encoded.replaceAll("\\n", "\n"))
  )
    throw new Error(
      "Do not include fenced code, diffs or logs in a report. Return findings and source references.",
    );
  return brief;
}
export function roleGuidance(role) {
  const responsibility = {
    task_lead:
      "Own one assigned task. Judge readiness only from implementer conversations and compact reports; never read code or execute shell commands. Delegate implementation and checks within the assigned repositories. Classify every direct-input receipt with repo_task_input: question (local answer, preserve approval), refinement (accept an in-scope adjustment), or escalation (ask Orchestrator to resolve changed acceptance/scope). Unclassified/escalated inputs block advancement. Use repo_task_note for compact decisions. Escalate changes to requirements, acceptance criteria or cross-task contracts to the Orchestrator before proceeding. When implementation reports support completion, call repo_request_review; it checks candidacy and starts/reuses the independent reviewer in a separate pane. Route findings back to implementers; batch fixes before requesting another review. Report completed only after Reviewer PASS; repo_agent_report validates and commits task completion as one operation. Progress/blockers may be reported without approval. Do not narrate every internal step to the Orchestrator. When waiting for children, end the turn without submitting a final report; automatic child reports resume you. Research is optional.",
    oracle:
      "Independently assess the whole project against its original/current requirements and the accepted task results. Inspect actual artifacts with repo_review_changes and repo_source, especially integration boundaries and missing acceptance evidence. Reuse valid task review evidence rather than repeat every local review. You are read-only: request concrete execution evidence through findings if needed. Submit PASS only when overall completion is supported; otherwise report actionable findings and affected tasks.",
    scout:
      "Investigate local code and architecture without editing. Return facts, dependency/contract boundaries, constraints, alternatives, uncertainty and precise source references. Do not implement or reproduce large source excerpts.",
    researcher:
      "Research external documentation and dependency behavior without editing. Use HTTPS source retrieval or existing local references. State applicable versions, source URLs, limitations and uncertainty. If a source cannot be found or fetched, report the gap; never invent research. No general web search engine is bundled.",
    implementer:
      "Implement the assigned acceptance criteria, using the supplied research and plan. Read actual code before modifying it. Preserve others' changes. Validate only the assigned scope and report evidence, skipped checks and remaining risks.",
    reviewer:
      "Independently review the complete change against the original requirements. Use repo_review_changes to inspect the baseline, current changes and required files. Review real bugs, missing requirements and concrete risks. Do not implement. Re-reviews focus on unresolved findings and the impact of remediation; do not reopen unchanged accepted decisions. Changed files and repo_source reads become approval dependencies. Declare unobserved config/dynamic dependencies via repo_review_scope; choose wholeRepositories when the scope cannot be safely narrowed. Submit a verdict with repo_agent_report.",
  };
  return `You are the ${role} in a process-owned repository workflow. ${responsibility[role]} Follow applicable AGENTS.md, including response language. For a final outcome call repo_agent_report with a compact structured brief, then end the turn. A task_lead awaiting children must instead end its turn without a final report. Raw code, diffs and logs stay in this conversation. Include source paths/URLs so another child can inspect the evidence. A completed job is not a reviewed work bundle. Only task_lead may delegate scoped children. After approved task completion, implementers exit to release checkout reservations; forget their exited records before starting replacement implementers if work is reopened. Other roles cannot spawn agents. Never change your own assigned role.`;
}
export function publicReport(report) {
  if (!report) return null;
  let brief;
  try {
    brief = validateBrief(report.brief);
  } catch {
    /* Legacy/freeform results stay on disk. */
  }
  return {
    status: report.status,
    brief: brief ?? null,
    reportRequired: !brief,
    message: brief
      ? undefined
      : ["error", "aborted", "cancelled-parent-exited"].includes(report.status)
        ? "Child ended unsuccessfully. Inspect its pane or resolve the blocker before deciding whether to retry; raw failure output is not copied."
        : "No valid structured report. Ask the child to submit repo_agent_report; inspect its pane for raw details.",
    usage: report.usage,
    finishedAt: report.finishedAt,
    review: report.review
      ? {
          jobId: report.review.jobId,
          attempt: report.review.attempt,
          limit: report.review.limit,
          requirementsRevision: report.review.requirementsRevision,
          invalidated: report.review.invalidated ?? false,
        }
      : undefined,
  };
}
