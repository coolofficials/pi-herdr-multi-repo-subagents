import fs from "node:fs/promises";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MARKER, readJSON, writeJSON, summarizeMessages } from "./core.mjs";
import { liveness, processIdentity } from "./lifecycle.mjs";

export const CHILD_FLAG = "repo-agent-child";

export default function childBridge(pi: ExtensionAPI) {
  pi.registerFlag(CHILD_FLAG, {
    description: "Internal process-scoped repository child launch",
    type: "string",
  });
  const isChild = () => typeof pi.getFlag(CHILD_FLAG) === "string";
  let dir: string | undefined;
  let launch: any;
  let jobId: string | undefined;
  let messages: AgentMessage[] = [];
  let outcome = "completed";
  let detached = false;
  let parentGone = false;
  let closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const stop = () => {
    generation++;
    if (timer) clearTimeout(timer);
  };
  const ready = async (ctx: ExtensionContext, extra = {}) => {
    if (!dir) return;
    await writeJSON(path.join(dir, "ready.json"), {
      instance: processIdentity(),
      pid: process.pid,
      pane: process.env.HERDR_PANE_ID,
      cwd: await fs.realpath(ctx.cwd),
      managed: !detached,
      cleanExit: false,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      ...extra,
    });
  };
  const checkpoint = async () => {
    if (dir)
      await writeJSON(path.join(dir, "job-state.json"), {
        jobId,
        messages,
        outcome,
      });
  };
  const finish = async (ctx: ExtensionContext, forced?: string) => {
    if (!dir || !jobId) return;
    const id = jobId;
    const report = summarizeMessages(messages);
    const status =
      forced ??
      (outcome !== "completed"
        ? outcome
        : !report.summary
          ? "no-report"
          : "settled");
    const file = path.join(dir, `${id}.result.json`);
    if (!(await readJSON(file))) {
      await writeJSON(file, {
        jobId: id,
        status,
        ...report,
        sessionFile: ctx.sessionManager.getSessionFile(),
        finishedAt: new Date().toISOString(),
      });
    }
    await writeJSON(path.join(dir, "activity.json"), { jobId: id, status });
    jobId = undefined;
    messages = [];
    await checkpoint();
  };
  const observeParent = async () => {
    if (!launch || !dir || detached) return "detached";
    const physical = liveness(launch.parent);
    const state = await readJSON(path.join(launch.scope, "parent.json"));
    const quit =
      state?.instance?.token === launch.parent.token &&
      state.status === "released" &&
      state.reason === "quit";
    if (physical === "dead" || quit) parentGone = true;
    const status = parentGone
      ? "exited"
      : physical === "alive"
        ? "connected"
        : "unknown";
    await writeJSON(path.join(dir, "parent-observation.json"), {
      status,
      observedAt: new Date().toISOString(),
    });
    return status;
  };
  const maybeExit = (ctx: ExtensionContext) => {
    if (
      parentGone &&
      !detached &&
      !closing &&
      !jobId &&
      ctx.isIdle() &&
      !ctx.hasPendingMessages()
    ) {
      closing = true;
      ctx.shutdown();
    }
  };
  const watch = async (ctx: ExtensionContext, version: number) => {
    try {
      if (version !== generation || detached) return;
      const status = await observeParent();
      if (version !== generation) return;
      ctx.ui.setStatus(
        "repo-parent",
        status === "exited"
          ? "Parent exited · finishing current work, then exiting"
          : status === "unknown"
            ? "Parent state unknown · retained"
            : undefined,
      );
      maybeExit(ctx);
    } catch (error) {
      if (version === generation)
        ctx.ui.setStatus(
          "repo-parent",
          `Parent observation unavailable: ${String(error)}`,
        );
    } finally {
      if (version === generation && !detached && !closing) {
        timer = setTimeout(() => void watch(ctx, version), 2000);
        timer.unref();
      }
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    if (!isChild()) return;
    stop();
    try {
      const flag = JSON.parse(pi.getFlag(CHILD_FLAG) as string);
      if (!path.isAbsolute(flag.dir) || typeof flag.token !== "string")
        throw new Error("Invalid child launch argument.");
      dir = flag.dir;
      launch = await readJSON(path.join(dir!, "launch.json"));
      if (
        !launch ||
        launch.token !== flag.token ||
        launch.pane !== process.env.HERDR_PANE_ID ||
        launch.cwd !== (await fs.realpath(ctx.cwd))
      ) {
        throw new Error(
          "Child launch identity does not match this process, pane or repository.",
        );
      }
      const identity = processIdentity();
      const claimPath = path.join(dir!, "claim.json");
      const claim = await readJSON(claimPath);
      if (claim) {
        if (claim.token !== identity.token || liveness(claim) !== "alive")
          throw new Error("Child launch already consumed by another process.");
      } else {
        if (Date.now() > launch.expiresAt)
          throw new Error("Child launch expired.");
        await fs.writeFile(claimPath, JSON.stringify(identity), {
          flag: "wx",
          mode: 0o600,
        });
      }
      if (await readJSON(path.join(dir!, "recovered.json")))
        throw new Error("This child launch has been retired by recovery.");
      detached = Boolean(await readJSON(path.join(dir!, "detached.json")));
      const pending = await readJSON(path.join(dir!, "job-state.json"));
      if (
        pending?.jobId &&
        !(await readJSON(path.join(dir!, `${pending.jobId}.result.json`)))
      ) {
        jobId = pending.jobId;
        messages = pending.messages ?? [];
        outcome = pending.outcome ?? "completed";
      }
      // A launch marker never belongs to the interactive shell or subsequent Pi processes.
      delete process.env.PI_HERDR_CHILD_DIR;
      pi.setActiveTools(
        pi.getActiveTools().filter((name) => !name.startsWith("repo_agent_")),
      );
      await ready(ctx);
      void watch(ctx, generation);
    } catch (error) {
      ctx.ui.notify(
        `Repository child initialization failed: ${String(error)}`,
        "error",
      );
      closing = true;
      ctx.shutdown();
    }
  });
  pi.on("input", async (event, ctx) => {
    if (!isChild() || !dir) return;
    try {
      if (await readJSON(path.join(dir, "recovered.json"))) {
        ctx.ui.notify(
          "This child launch was retired. Exit this Pi process.",
          "error",
        );
        return { action: "handled" };
      }
      if (detached) {
        if (event.text.startsWith(MARKER)) {
          ctx.ui.notify(
            "This agent is detached; delegated input rejected.",
            "error",
          );
          return { action: "handled" };
        }
        return;
      }
      await observeParent();
      if (parentGone) {
        const request = await readJSON(path.join(dir, "request.json"));
        if (
          request?.owner === launch.workflowId &&
          event.text.startsWith(`${MARKER}${request.jobId}\n`) &&
          !jobId
        ) {
          const file = path.join(dir, `${request.jobId}.result.json`);
          if (!(await readJSON(file)))
            await writeJSON(file, {
              jobId: request.jobId,
              status: "cancelled-parent-exited",
              summary:
                "Parent exited before this request began; no delegated work was started.",
              sessionFile: ctx.sessionManager.getSessionFile(),
              finishedAt: new Date().toISOString(),
            });
        }
        ctx.ui.notify(
          "Parent exited. New requests are not accepted; current work will finish before exit.",
          "warning",
        );
        maybeExit(ctx);
        return { action: "handled" };
      }
      if (!event.text.startsWith(MARKER)) return;
      const newline = event.text.indexOf("\n");
      const id = event.text.slice(MARKER.length, newline);
      const request = await readJSON(path.join(dir, "request.json"));
      if (
        newline < 0 ||
        request?.jobId !== id ||
        request.owner !== launch.workflowId
      )
        throw new Error("Delegation request does not match the pending job.");
      if (jobId === id || (await readJSON(path.join(dir, `${id}.result.json`))))
        return { action: "handled" };
      if (jobId)
        throw new Error(
          "An existing job is still active; refusing replacement.",
        );
      jobId = id;
      messages = [];
      outcome = "completed";
      await checkpoint();
      await writeJSON(path.join(dir, "activity.json"), {
        jobId,
        status: "working",
        startedAt: new Date().toISOString(),
      });
      return { action: "transform", text: event.text.slice(newline + 1) };
    } catch (error) {
      ctx.ui.notify(`Delegated input rejected: ${String(error)}`, "error");
      return { action: "handled" };
    }
  });
  pi.on("message_end", async (event) => {
    if (jobId && event.message.role === "assistant") {
      const message = event.message;
      messages.push({
        ...message,
        content: message.content.filter((part) => part.type === "text"),
      });
      await checkpoint();
    }
  });
  pi.on("agent_before_settle", (event) => {
    if (jobId) outcome = event.outcome;
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (!isChild()) return;
    await finish(ctx);
    await observeParent();
    maybeExit(ctx);
  });
  const guardSwitch = async (_event: unknown, ctx: ExtensionContext) => {
    if (isChild() && jobId) {
      ctx.ui.notify(
        "Finish the delegated job before switching child sessions.",
        "warning",
      );
      return { cancel: true };
    }
  };
  pi.on("session_before_switch", guardSwitch);
  pi.on("session_before_fork", guardSwitch);
  pi.on("session_shutdown", async (event, ctx) => {
    if (!isChild() || !dir) return;
    stop();
    if (event.reason !== "quit") {
      await checkpoint();
      return;
    }
    const cleanExit = !jobId && ctx.isIdle() && !ctx.hasPendingMessages();
    await finish(ctx, "aborted");
    await ready(ctx, {
      exited: true,
      managed: false,
      cleanExit,
      exitReason: parentGone ? "parent-exited" : "quit",
    });
    await writeJSON(path.join(dir, "activity.json"), {
      status: "exited",
      parentConnection: parentGone ? "exited" : "connected",
    });
  });
  pi.registerCommand("repo-agent-detach", {
    description:
      "Finish managed work, then keep this Pi independent of its parent",
    handler: async (_args, ctx) => {
      if (!isChild() || !dir) {
        ctx.ui.notify("This is not a managed child.", "info");
        return;
      }
      if (jobId || !ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Finish current work before detaching.", "warning");
        return;
      }
      detached = true;
      stop();
      await writeJSON(path.join(dir, "detached.json"), {
        detachedAt: new Date().toISOString(),
      });
      await ready(ctx);
      ctx.ui.setStatus(
        "repo-parent",
        "Independent Pi · checkout remains reserved until exit",
      );
    },
  });
  return { isChild };
}
