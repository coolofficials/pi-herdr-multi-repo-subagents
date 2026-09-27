export const ROLES = [
  "explorer",
  "librarian",
  "implementer",
  "reviewer",
  "verifier",
];
export const READ_ONLY_ROLES = new Set(["explorer", "librarian", "reviewer"]);
export const MAIN_TOOLS = new Set([
  "repo_agent_list",
  "repo_agent_start",
  "repo_agent_prompt",
  "repo_agent_read",
  "repo_agent_reset",
  "repo_agent_forget",
  "repo_task_document",
  "repo_work",
]);
export const CHILD_TOOLS = new Set([
  "repo_source",
  "repo_research_fetch",
  "repo_agent_report",
  "repo_review_changes",
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
    explorer:
      "Investigate local code and architecture without editing. Return facts, dependency/contract boundaries, constraints, alternatives, uncertainty and precise source references. Do not implement or reproduce large source excerpts.",
    librarian:
      "Research external documentation and dependency behavior without editing. Use HTTPS source retrieval or existing local references. State applicable versions, source URLs, limitations and uncertainty. If a source cannot be found or fetched, report the gap; never invent research. No general web search engine is bundled.",
    implementer:
      "Implement the assigned acceptance criteria, using the supplied research and plan. Read actual code before modifying it. Preserve others' changes. Validate only the assigned scope and report evidence, skipped checks and remaining risks.",
    reviewer:
      "Independently review the complete change against the original requirements. Use repo_review_changes to inspect the baseline, current changes and required files. Review real bugs, missing requirements and concrete risks. Do not implement. Re-reviews focus on unresolved findings and the impact of remediation; do not reopen unchanged accepted decisions. Submit a verdict with repo_agent_report.",
    verifier:
      "Verify the assigned observable behavior and cross-repository contracts. Reuse valid evidence instead of repeating all checks. Run only assigned checks. Report actual results and limitations; coordinate any necessary code fixes through the parent.",
  };
  return `You are the ${role} in a process-owned repository workflow. ${responsibility[role]} Follow applicable AGENTS.md, including response language. Finish by calling repo_agent_report with a compact structured brief, then end the turn. Raw code, diffs and logs stay in this conversation. Include source paths/URLs so another child can inspect the evidence. A completed job is not a reviewed work bundle. Do not spawn other agents or change your assigned role.`;
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
    review: report.review,
  };
}
