import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MARKER, readJSON, writeJSON, summarizeMessages } from "./core.mjs";

export default function childBridge(pi: ExtensionAPI) {
  const dir = process.env.PI_HERDR_CHILD_DIR;
  if (!dir) return;
  let jobId: string | undefined;
  let messages: AgentMessage[] = [];
  let outcome: string = "completed";
  pi.on("session_start", async (_event, ctx) => {
    await writeJSON(path.join(dir, "ready.json"), {
      pid: process.pid,
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
    });
  });
  pi.on("input", async (event, ctx) => {
    if (!event.text.startsWith(MARKER)) {
      if (ctx.isIdle()) jobId = undefined;
      return;
    }
    const newline = event.text.indexOf("\n");
    const id = event.text.slice(MARKER.length, newline);
    const request = await readJSON(path.join(dir, "request.json"));
    if (request?.jobId !== id)
      throw new Error("Delegation request does not match the pending job.");
    jobId = id;
    messages = [];
    outcome = "completed";
    await writeJSON(path.join(dir, "activity.json"), {
      jobId,
      status: "working",
      startedAt: new Date().toISOString(),
    });
    return { action: "transform", text: event.text.slice(newline + 1) };
  });
  pi.on("message_end", (event) => {
    if (jobId && event.message.role === "assistant")
      messages.push(event.message);
  });
  pi.on("agent_before_settle", (event) => {
    outcome = event.outcome;
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (!jobId) return;
    const report = summarizeMessages(messages);
    const status =
      outcome !== "completed"
        ? outcome
        : !report.summary
          ? "no-report"
          : "settled";
    await writeJSON(path.join(dir, `${jobId}.result.json`), {
      jobId,
      status,
      ...report,
      sessionFile: ctx.sessionManager.getSessionFile(),
      finishedAt: new Date().toISOString(),
    });
    await writeJSON(path.join(dir, "activity.json"), { jobId, status });
    jobId = undefined;
  });
  pi.on("session_shutdown", async () => {
    if (jobId)
      await writeJSON(path.join(dir, `${jobId}.result.json`), {
        jobId,
        status: "aborted",
        ...summarizeMessages(messages),
        finishedAt: new Date().toISOString(),
      });
    await writeJSON(path.join(dir, "activity.json"), { status: "exited" });
  });
}
