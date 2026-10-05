import fs from "node:fs/promises";
import path from "node:path";
import { readJSON } from "./storage.mjs";
import { liveness } from "./lifecycle.mjs";

export async function socketIdentity(socket) {
  if (!socket) return null;
  const stat = await fs.stat(socket).catch(() => null);
  return stat?.isSocket()
    ? { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }
    : null;
}

// Terminal IDs can change when Herdr recreates saved panes on server restart.
// A pane ID alone is insufficient authority to submit a command to that shell.
export async function resolveBoardSlot(client, candidate, reclaimPane) {
  const { scope, parent, board } = candidate;
  const current = scope === client.scope;
  if (
    current
      ? board.owner !== client.identity.token
      : liveness(parent.instance) !== "dead"
  )
    throw Error(
      `Previous board ${board.pane} belongs to a live or unknown owner. No duplicate board created.`,
    );
  const pane = (await client.call(["pane", "get", board.pane])).result?.pane;
  if (!pane) throw Error("Cannot confirm the recorded board pane.");
  if (pane.tab_id !== board.tab || !pane.terminal_id || !board.terminal)
    throw Error(
      "Board pane identity changed; inspect its tab before reopening. No duplicate pane created.",
    );
  const runtime = await readJSON(path.join(scope, "board-runtime.json"));
  if (runtime && liveness(runtime.instance) !== "dead") {
    if (
      current &&
      pane.terminal_id === board.terminal &&
      runtime.pane === board.pane &&
      runtime.terminal === board.terminal &&
      liveness(runtime.instance) === "alive"
    )
      return { retained: true, pane: board.pane };
    throw Error(
      `Previous board process in ${board.pane} is live or unknown. No duplicate board created.`,
    );
  }
  if (pane.terminal_id === board.terminal) return { board, rebound: false };

  const anchor = (await client.call(["pane", "get", client.env.HERDR_PANE_ID]))
    .result?.pane;
  const layout = (
    await client.call(["pane", "layout", "--pane", client.env.HERDR_PANE_ID])
  ).result?.layout;
  const slots = layout?.panes;
  const a = slots?.find((p) => p.pane_id === client.env.HERDR_PANE_ID)?.rect;
  const b = slots?.find((p) => p.pane_id === board.pane)?.rect;
  const topology =
    anchor?.tab_id === pane.tab_id &&
    anchor.terminal_id &&
    pane.pane_id !== anchor.pane_id &&
    slots?.length === 2 &&
    a &&
    b &&
    b.x === a.x + a.width &&
    b.y === a.y &&
    b.height === a.height &&
    pane.cwd === client.root &&
    (pane.foreground_cwd ?? pane.cwd) === client.root;
  if (!topology)
    throw Error(
      "Cannot confirm the old board's right-hand slot and task root. No duplicate pane created.",
    );
  const socket = await socketIdentity(client.env.HERDR_SOCKET_PATH);
  const restarted =
    board.socketIdentity &&
    socket &&
    JSON.stringify(board.socketIdentity) !== JSON.stringify(socket) &&
    board.anchorTerminal &&
    board.anchorTerminal !== anchor.terminal_id;
  if (!restarted && reclaimPane !== board.pane)
    throw Error(
      `Board pane ${board.pane} has a new terminal identity; it is not proven occupied. After inspecting the idle shell, use /repo-agents board reclaim ${board.pane}. No duplicate pane created.`,
    );
  return {
    board: { ...board, terminal: pane.terminal_id },
    rebound: true,
    receipt: {
      reason: restarted ? "herdr-server-restart" : "explicit-board-reclaim",
      fromScope: scope,
      previousTerminal: board.terminal,
      terminal: pane.terminal_id,
      pane: board.pane,
      anchorTerminal: anchor.terminal_id,
      socketIdentity: socket,
      at: new Date().toISOString(),
    },
  };
}
