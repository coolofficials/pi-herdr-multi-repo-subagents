import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";

// This preflight only observes. Herdr agent start remains the final prompt check.
export async function waitForLaunchShell(client, record, signal) {
  const budget = 10000,
    started = performance.now(),
    timeout = AbortSignal.timeout(budget),
    combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let stableSince = null,
    shellPid = null,
    observations = 0,
    lastState = "shell state unavailable";
  const inspect = (args) => {
    combined.throwIfAborted();
    return client.call(
      args,
      combined,
      false,
      Math.max(1, Math.ceil(budget - (performance.now() - started))),
    );
  };
  if (!record.pane || !record.terminal || !record.tab)
    throw Error(
      "Shell readiness requires the created pane's terminal and tab identity.",
    );
  try {
    while (true) {
      combined.throwIfAborted();
      const pane = (await inspect(["pane", "get", record.pane])).result?.pane;
      if (
        !pane ||
        pane.pane_id !== record.pane ||
        pane.terminal_id !== record.terminal ||
        pane.tab_id !== record.tab
      )
        throw Error(
          "Created pane identity changed or disappeared; no agent was started.",
        );
      if (pane.agent || pane.agent_session || pane.restore_error)
        throw Error(
          "Created pane is occupied by an agent or has a restore error; no agent was started.",
        );
      const info = (
        await inspect(["pane", "process-info", "--pane", record.pane])
      ).result?.process_info;
      observations++;
      const ready =
        info?.pane_id === record.pane &&
        Number.isInteger(info.shell_pid) &&
        info.shell_pid > 0 &&
        info.foreground_process_group_id === info.shell_pid &&
        Array.isArray(info.foreground_processes) &&
        info.foreground_processes.length > 0 &&
        info.foreground_processes.every((p) => p.pid === info.shell_pid);
      if (ready) {
        if (shellPid !== info.shell_pid || stableSince === null) {
          shellPid = info.shell_pid;
          stableSince = performance.now();
        }
        lastState = "foreground shell stability pending";
        if (performance.now() - stableSince >= 500) {
          combined.throwIfAborted();
          return {
            pane: record.pane,
            terminal: record.terminal,
            shellPid,
            observations,
            elapsedMs: Math.round(performance.now() - started),
          };
        }
      } else {
        stableSince = null;
        shellPid = null;
        lastState = "foreground is busy or shell identity is unknown";
      }
      await delay(250, undefined, { signal: combined });
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted)
      throw Error(
        `Shell readiness timed out after ${budget} ms (${lastState}); no agent was started. Inspect the retained pane before recovery.`,
      );
    throw error;
  }
}
