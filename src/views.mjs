import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readJSON, writeJSON } from "./storage.mjs";
import { withOperationLock } from "./coordination-lock.mjs";
import { liveness } from "./lifecycle.mjs";
import { executionState } from "./execution.mjs";
const exec = promisify(execFile);
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const viewPath = (client, bundle) =>
  path.join(client.workScope, "views", bundle + ".json");
export async function familyRecords(scope) {
  const parent = await readJSON(path.join(scope, "parent.json"));
  const workScope = parent?.workScope ?? scope;
  const own = await readJSON(path.join(scope, "agents.json"), []);
  const siblings = (
    await fs
      .readdir(path.dirname(scope), { withFileTypes: true })
      .catch(() => [])
  )
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => e.name);
  const children = [];
  for (const name of siblings) {
    const nested = path.join(path.dirname(scope), name);
    if (nested === scope) continue;
    const records = await readJSON(path.join(nested, "agents.json"), []);
    for (const record of records) {
      const launch = await readJSON(path.join(record.dir, "launch.json"));
      if (
        launch?.workScope === workScope &&
        launch.ancestors?.some(
          (a) => a.identity.token === parent?.instance?.token,
        )
      )
        children.push(record);
    }
  }
  return [...own, ...children];
}
export async function createTaskPane(client, record, signal, environment) {
  const key = record.bundle ?? record.id;
  const file = viewPath(client, key);
  const view = await readJSON(file);
  let result;
  if (view && !view.closed) {
    const panes = (
      await client.call(
        ["pane", "list", "--workspace", client.env.HERDR_WORKSPACE_ID],
        signal,
      )
    ).result?.panes;
    if (!Array.isArray(panes)) throw Error("Cannot confirm task tab topology.");
    let own = panes.filter((p) => p.tab_id === view.tab);
    if (own.length >= 4) {
      const familyScope =
        client.delegation?.ancestors?.[0]?.scope ??
        client.scope ??
        client.workScope;
      const current = await familyRecords(familyScope);
      // A restored task can retain an old full tab. Read its retired records for
      // safe shell cleanup only; never register or prompt those old processes.
      const historical =
        client.workScope && client.workScope !== familyScope
          ? await familyRecords(client.workScope)
          : [];
      for (const old of [
        ...new Map([...current, ...historical].map((r) => [r.id, r])).values(),
      ]) {
        if (
          old.bundle !== record.bundle ||
          !own.some((p) => p.pane_id === old.pane) ||
          (await readJSON(path.join(old.dir, "keep.json")))?.keep
        )
          continue;
        const state = await executionState(old);
        if (
          !state.pending &&
          state.ready?.cleanExit &&
          liveness(state.ready.instance) === "dead" &&
          (await shellAvailable(client, old))
        ) {
          await client.call(["pane", "close", old.pane], signal);
          await writeJSON(path.join(old.dir, "view-closed.json"), {
            pane: old.pane,
            at: new Date().toISOString(),
          });
          own = own.filter((p) => p.pane_id !== old.pane);
          break;
        }
      }
    }
    if (own.length >= 4)
      throw Error(
        "TASK_VIEW_CAPACITY: task tab has 4 panes. Call repo_agent_release for a settled idle worker, then retry after its confirmed exit. Pinned/user panes are protected.",
      );
    const anchor = own.find((p) => p.pane_id === view.anchor) ?? own[0];
    if (!anchor)
      throw Error(
        "Task tab was changed externally; inspect it before creating another.",
      );
    result = await client.call(
      [
        "pane",
        "split",
        "--pane",
        anchor.pane_id,
        "--direction",
        own.length % 2 ? "right" : "down",
        "--cwd",
        record.path,
        ...environment,
        "--no-focus",
      ],
      signal,
    );
    record.tab = view.tab;
  } else {
    result = await client.call(
      [
        "tab",
        "create",
        "--workspace",
        client.env.HERDR_WORKSPACE_ID,
        "--label",
        record.label,
        "--cwd",
        record.path,
        ...environment,
        "--no-focus",
      ],
      signal,
    );
    record.tab = result.result?.tab?.tab_id;
    const pane = result.result?.root_pane?.pane_id;
    if (!pane || !record.tab)
      throw Error("Task tab creation returned incomplete identity.");
    await writeJSON(file, {
      bundle: key,
      tab: record.tab,
      anchor: pane,
      closed: false,
    });
  }
  return result;
}
export async function shellAvailable(client, record) {
  const pane = (await client.call(["pane", "get", record.pane])).result?.pane;
  if (
    !pane ||
    !record.terminal ||
    pane.terminal_id !== record.terminal ||
    pane.tab_id !== record.tab
  )
    return false;
  const info = (
    await client.call(["pane", "process-info", "--pane", record.pane])
  ).result?.process_info;
  if (
    !info?.shell_pid ||
    info.foreground_process_group_id !== info.shell_pid ||
    !info.foreground_processes?.every((p) => p.pid === info.shell_pid)
  )
    return false;
  // A shell prompt alone does not exclude a user-started background process.
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid="]);
  if (
    stdout
      .trim()
      .split("\n")
      .some((line) => Number(line.trim().split(/\s+/)[1]) === info.shell_pid)
  )
    return false;
  return true;
}
export async function maintainViews(
  client,
  delivered = new Set(),
  researchOnly = false,
) {
  const records = client.delegation
    ? await client.records()
    : await familyRecords(client.scope);
  for (const record of records) {
    const research = ["scout", "researcher"].includes(record.role);
    if (researchOnly && !research) continue;
    if (
      !record.tab ||
      !record.terminal ||
      record.viewClosed ||
      (await readJSON(path.join(record.dir, "view-closed.json")))
    )
      continue;
    try {
      const state = await executionState(record);
      if (research) {
        if (
          state.pending ||
          state.phase !== "settled" ||
          state.report?.status !== "settled" ||
          !["completed", "incomplete", "blocked"].includes(
            state.report.brief?.outcome,
          ) ||
          state.report.jobId !== state.request?.jobId
        )
          continue;
        const launch = await readJSON(path.join(record.dir, "launch.json"));
        const receiptFile = path.join(
          record.dir,
          `${state.request.jobId}.delivered.json`,
        );
        let receipt = await readJSON(receiptFile);
        if (
          record.owner === client.owner &&
          launch?.scope === client.scope &&
          launch.parent?.token === client.identity?.token &&
          delivered.has(`${state.request.jobId}:report`) &&
          (receipt?.jobId !== state.request.jobId ||
            receipt.parentToken !== client.identity.token ||
            receipt.scope !== client.scope)
        ) {
          receipt = {
            jobId: state.request.jobId,
            parentToken: client.identity.token,
            scope: client.scope,
          };
          await writeJSON(receiptFile, receipt);
        }
        if (
          !launch?.parent?.token ||
          receipt?.jobId !== state.request.jobId ||
          receipt.parentToken !== launch.parent.token ||
          receipt.scope !== launch.scope
        )
          continue;
      } else {
        const work =
          record.bundle &&
          (await readJSON(
            path.join(
              client.workScope ?? client.scope,
              record.role === "oracle" ? "projects" : "work",
              record.bundle + ".json",
            ),
          ));
        if (work?.status !== "completed") continue;
        const lead =
          record.role === "oracle" ? record : (work.lead ?? work.executor);
        if (!lead) continue;
        const leadState = await executionState(lead);
        if (
          leadState.pending ||
          leadState.report?.brief?.outcome !== "completed"
        )
          continue;
      }
      if (
        (await readJSON(path.join(record.dir, "keep.json")))?.keep ||
        (await readJSON(path.join(record.dir, "detached.json")))
      )
        continue;
      if (state.pending || !state.ready || state.phase === "interrupted")
        continue;
      if (liveness(state.ready.instance) === "alive") {
        const live = (await client.call(["agent", "get", record.id])).result
          ?.agent;
        if (
          live?.pane_id !== record.pane ||
          !["idle", "done"].includes(live.status ?? live.agent_status)
        )
          continue;
        await writeJSON(path.join(record.dir, "retired.json"), {
          reason: research ? "research-delivered" : "task-approved",
          at: new Date().toISOString(),
        });
        continue;
      }
      if (
        liveness(state.ready.instance) !== "dead" ||
        !state.ready.cleanExit ||
        !(await shellAvailable(client, record))
      )
        continue;
      await client.call(["pane", "close", record.pane]);
      await writeJSON(path.join(record.dir, "view-closed.json"), {
        pane: record.pane,
        at: new Date().toISOString(),
      });
    } catch {
      /* Unknown topology/process state is retained; never force close. */
    }
  }
  if (client.delegation) return;
  const views = await fs
    .readdir(path.join(client.workScope ?? client.scope, "views"))
    .catch(() => []);
  const panes = (
    await client.call([
      "pane",
      "list",
      "--workspace",
      client.env.HERDR_WORKSPACE_ID,
    ])
  ).result?.panes;
  if (!Array.isArray(panes)) return;
  for (const name of views) {
    const file = path.join(client.workScope ?? client.scope, "views", name),
      view = await readJSON(file);
    if (view && !panes.some((p) => p.tab_id === view.tab))
      await writeJSON(file, { ...view, closed: true });
  }
}
async function previousBoard(client) {
  const scopes = await fs.readdir(path.dirname(client.scope), {
    withFileTypes: true,
  });
  const candidates = [];
  for (const entry of scopes) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const scope = path.join(path.dirname(client.scope), entry.name);
    if (scope === client.scope) continue;
    const parent = await readJSON(path.join(scope, "parent.json"));
    const board = await readJSON(path.join(scope, "board.json"));
    if (
      !board?.pane ||
      parent?.root !== client.root ||
      parent.pane !== client.env.HERDR_PANE_ID ||
      parent.socket !== client.env.HERDR_SOCKET_PATH
    )
      continue;
    candidates.push({ scope, parent, board });
  }
  candidates.sort((a, b) =>
    (b.parent.updatedAt ?? "").localeCompare(a.parent.updatedAt ?? ""),
  );
  for (const candidate of candidates) {
    const panes = (
      await client.call([
        "pane",
        "list",
        "--workspace",
        client.env.HERDR_WORKSPACE_ID,
      ])
    ).result?.panes;
    if (!Array.isArray(panes))
      throw Error(
        "Cannot confirm previous board topology; no new pane created.",
      );
    const pane = panes.find((p) => p.pane_id === candidate.board.pane);
    if (!pane) continue;
    if (liveness(candidate.parent.instance) !== "dead")
      throw Error(
        `Previous board ${pane.pane_id} belongs to a live or unknown owner. No duplicate board created.`,
      );
    if (!(await shellAvailable(client, candidate.board)))
      throw Error(
        `Previous board pane ${pane.pane_id} is still occupied. Press q in an old board, or inspect that pane before reopening the board. No duplicate pane created.`,
      );
    return candidate;
  }
}
export async function ensureBoard(client, reopen = false) {
  if (client.delegation) return;
  // A board slot belongs to a root and main pane, not to each conversation/process.
  return withOperationLock(
    path.join(path.dirname(client.scope), ".board-lock"),
    () => openBoard(client, reopen),
    { identity: client.identity },
  );
}
async function openBoard(client, reopen) {
  if (client.delegation) return;
  const file = path.join(client.scope, "board.json"),
    old = await readJSON(file);
  if (old && !reopen) return;
  let pane, identity;
  if (!old) {
    const prior = await previousBoard(client);
    if (prior) {
      pane = prior.board.pane;
      identity = { tab: prior.board.tab, terminal: prior.board.terminal };
      await writeJSON(path.join(prior.scope, "board.json"), {
        ...prior.board,
        status: "reassigned",
        reassignedTo: client.scope,
      });
    }
  }
  if (old && reopen) {
    const panes = (
      await client.call([
        "pane",
        "list",
        "--workspace",
        client.env.HERDR_WORKSPACE_ID,
      ])
    ).result?.panes;
    if (!Array.isArray(panes)) throw Error("Cannot confirm board topology.");
    const existing = panes.find((p) => p.pane_id === old.pane);
    if (existing) {
      if (existing.tab_id !== old.tab || existing.terminal_id !== old.terminal)
        throw Error(
          "Board pane identity changed; no replacement pane created.",
        );
      if (!(await shellAvailable(client, old)))
        return {
          status: "retained",
          message: "Board or another process is still running in its pane.",
        };
      pane = old.pane;
      identity = { tab: old.tab, terminal: old.terminal };
    } else if (!old.pane)
      throw Error(
        "Board creation was uncertain. Inspect the layout before replacing it.",
      );
  }
  if (!pane) {
    await writeJSON(file, { status: "creating", owner: client.identity.token });
    const result = await client.call([
      "pane",
      "split",
      "--pane",
      client.env.HERDR_PANE_ID,
      "--direction",
      "right",
      "--ratio",
      "0.7",
      "--cwd",
      client.root,
      "--no-focus",
    ]);
    pane = result.result?.pane?.pane_id;
    if (!pane)
      throw Error("Board creation uncertain; inspect the retained layout.");
    const current = (await client.call(["pane", "get", pane])).result?.pane;
    identity = { tab: current?.tab_id, terminal: current?.terminal_id };
  }
  await writeJSON(file, {
    status: "starting",
    pane,
    ...identity,
    owner: client.identity.token,
  });
  const script = fileURLToPath(new URL("./board.mjs", import.meta.url));
  await fs.rm(path.join(client.scope, "board-error.json"), { force: true });
  await fs.rm(path.join(client.scope, "board-runtime.json"), { force: true });
  await client.call(
    [
      "pane",
      "run",
      pane,
      `${quote(process.execPath)} ${quote(script)} ${quote(client.scope)}`,
    ],
    undefined,
    true,
  );
  const deadline = Date.now() + 5000;
  for (;;) {
    const failure = await readJSON(path.join(client.scope, "board-error.json"));
    if (failure)
      throw Error(
        `Board failed to initialize: ${failure.message}. See ${path.join(client.scope, "board-error.json")}; pane retained, no duplicate created.`,
      );
    const ready = await readJSON(path.join(client.scope, "board-runtime.json"));
    if (
      ready?.pane === pane &&
      ready.terminal === identity.terminal &&
      liveness(ready.instance) === "alive"
    )
      break;
    if (Date.now() >= deadline)
      throw Error(
        `Board startup was not confirmed in pane ${pane}. Inspect it and use /repo-agents board after resolving the error; no automatic retry.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeJSON(file, {
    status: "open",
    pane,
    ...identity,
    owner: client.identity.token,
  });
  return { status: "open", pane };
}
