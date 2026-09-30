// Routing is a model judgment; these contracts enforce its selected execution path.
export function executionMode(work) {
  return work.executionMode ?? "reviewed";
}
export function executionSelection(mode = "reviewed", reason) {
  if (!["single", "reviewed"].includes(mode))
    throw Error("executionMode must be single or reviewed.");
  if (
    mode === "single" &&
    (typeof reason !== "string" || !reason.trim() || reason.length > 400)
  )
    throw Error(
      "Single execution needs a concise routing reason (1–400 characters).",
    );
  if (
    reason !== undefined &&
    (typeof reason !== "string" || reason.length > 400)
  )
    throw Error("Routing reason is limited to 400 characters.");
  return { executionMode: mode, executionReason: reason?.trim() };
}
export const ROUTING_GUIDANCE =
  "Select an execution path from the current request and known facts, without a separate classifier agent or a codebase-wide survey. Use repo_work executionMode='single' with a one-line reason for bounded, clear, reversible work with a direct way to confirm the requested result; then start ONE implementer directly, complete that task with repo_work complete after its settled report, a standalone auto-created project completes with that task; explicitly grouped all-single projects complete without Oracle. Use executionMode='reviewed' for consequential/uncertain behavior, shared/public contracts, security/permissions/data changes, coupled cross-repository behavior, or requested independent review; retain the Task Lead/Reviewer/Oracle workflow. File count, step count and repository count alone do not imply risk: independent mechanical operations can use a single worker. When facts are insufficient, let one single worker inspect only the relevant scope and escalate before risky edits rather than launch a full pipeline just to classify. Research and review are optional for single execution; never invent extra goals or inspect cloned source just to finish a clone request. Respect explicit user/scoped review requirements. A single worker's repo_execution escalation blocks single completion; promote the same repository task to reviewed, attach Reviewer without repeating completed execution, and use Oracle for a project containing any reviewed tasks. Never downgrade reviewed work to single to bypass a gate.";
export const CAPABILITY_ROUTING_GUIDANCE =
  "Scout and Researcher can read assigned local images with repo_image when their selected model supports image input. If a child reports a capability/access limit, assess its exact cause and automatically route to an authorized capable child or model when available. Use repo_agent_list/read capability metadata rather than declaring all agents incapable or switching roles blindly. Image-format/file-access/model limits need their corresponding remedy. Request user input only for missing information or a consequential unresolved choice. Keep raw images in child context; receive compact findings. Researcher and Scout cannot spawn children themselves.";
export function singleGuidance(contract) {
  if (!contract?.directManager) return "";
  return `\nThis task reports directly to Orchestrator. Execution mode: ${contract.executionMode}. Routing reason: ${contract.executionReason ?? "independent review requested"}. ${contract.executionMode === "single" ? "One execution agent owns this task. Perform only the requested outcome and proportionate, directly relevant checks; do not explore all code, build, test or research by default. For administrative operations, verify operation results and metadata. Read source only if the requested work needs it. If scope, impact or uncertainty exceeds this route, call repo_execution with a concise reason BEFORE risky edits, then report incomplete with that reason. Do not spawn agents or claim independent approval. Completion requires a compact report with actual checks and evidence references, not Reviewer/Oracle." : "Independent review is now required. Complete only the assigned remediation; Orchestrator will request Reviewer. Preserve existing execution evidence and original baselines."}`;
}
