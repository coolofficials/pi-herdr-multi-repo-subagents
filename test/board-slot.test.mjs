import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { resolveBoardSlot, socketIdentity } from "../src/board-slot.mjs";
import { ensureBoard, shellAvailable } from "../src/views.mjs";
import { processIdentity } from "../src/lifecycle.mjs";
import { writeJSON, readJSON } from "../src/storage.mjs";

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-board-")),
  );
  const scope = path.join(root, "runs", "new"),
    prior = path.join(root, "runs", "old");
  await fs.mkdir(scope, { recursive: true });
  await fs.mkdir(prior);
  const socket = path.join(root, "h.sock");
  const server = net.createServer();
  server.listen(socket);
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const dead = {
    pid: 2147483647,
    host: os.hostname(),
    started: "old",
    token: "old",
  };
  const parent = {
    root,
    pane: "main",
    socket,
    instance: dead,
    updatedAt: "now",
  };
  const board = {
    pane: "board",
    tab: "t",
    terminal: "old-terminal",
    owner: "old",
    status: "open",
  };
  const current = {
    pane_id: "board",
    tab_id: "t",
    terminal_id: "new-terminal",
    cwd: root,
    foreground_cwd: root,
  };
  const anchor = { pane_id: "main", tab_id: "t", terminal_id: "new-main" };
  const layout = {
    panes: [
      { pane_id: "main", rect: { x: 0, y: 0, width: 70, height: 40 } },
      { pane_id: "board", rect: { x: 70, y: 0, width: 30, height: 40 } },
    ],
  };
  const calls = [],
    identity = processIdentity();
  const client = {
    root,
    scope,
    identity,
    env: {
      HERDR_PANE_ID: "main",
      HERDR_WORKSPACE_ID: "w",
      HERDR_SOCKET_PATH: socket,
    },
    call: async (args) => {
      calls.push(args);
      if (args[1] === "list") return { result: { panes: [anchor, current] } };
      if (args[1] === "get")
        return { result: { pane: args[2] === "main" ? anchor : current } };
      if (args[1] === "layout") return { result: { layout } };
      if (args[1] === "process-info")
        return {
          result: {
            process_info: {
              pane_id: "board",
              shell_pid: 2147483640,
              foreground_process_group_id: 2147483640,
              foreground_processes: [{ pid: 2147483640 }],
            },
          },
        };
      if (args[1] === "run") {
        await writeJSON(path.join(scope, "board-runtime.json"), {
          instance: identity,
          pane: "board",
          terminal: current.terminal_id,
        });
        return {};
      }
      throw Error("Unexpected mutation: " + args.join(" "));
    },
  };
  await writeJSON(path.join(prior, "parent.json"), parent);
  await writeJSON(path.join(prior, "board.json"), board);
  return {
    root,
    scope,
    prior,
    parent,
    board,
    current,
    anchor,
    layout,
    calls,
    client,
    candidate: { scope: prior, parent, board },
  };
}

test("legacy changed terminal is diagnosed as identity change, not occupied", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    resolveBoardSlot(f.client, f.candidate),
    /new terminal identity.*board reclaim board/,
  );
  assert.ok(
    f.calls.every(
      (a) => !["run", "split", "send-keys", "close"].includes(a[1]),
    ),
  );
});

test("explicit legacy reclaim rebinds one known idle slot without splitting", async (t) => {
  const f = await fixture(t);
  const result = await ensureBoard(f.client, true, "board");
  assert.equal(result.pane, "board");
  assert.equal(f.calls.filter((a) => a[1] === "run").length, 1);
  assert.ok(
    f.calls.every((a) => !["split", "send-keys", "close"].includes(a[1])),
  );
  const stored = await readJSON(path.join(f.scope, "board.json"));
  assert.equal(stored.terminal, "new-terminal");
  assert.equal(stored.anchorTerminal, "new-main");
  assert.ok(stored.socketIdentity);
  assert.equal(
    (await readJSON(path.join(f.scope, "board-rebind.json"))).reason,
    "explicit-board-reclaim",
  );
  await ensureBoard(f.client, true);
  assert.equal(f.calls.filter((a) => a[1] === "run").length, 1);
});

test("proved server restart rebinds automatically while same server cannot", async (t) => {
  const f = await fixture(t);
  const socket = await socketIdentity(f.client.env.HERDR_SOCKET_PATH);
  f.board.socketIdentity = socket;
  f.board.anchorTerminal = "old-main";
  await assert.rejects(
    resolveBoardSlot(f.client, f.candidate),
    /new terminal identity/,
  );
  f.board.socketIdentity = { ...socket, ino: socket.ino + 1 };
  const slot = await resolveBoardSlot(f.client, f.candidate);
  assert.equal(slot.receipt.reason, "herdr-server-restart");
  f.board.anchorTerminal = f.anchor.terminal_id;
  await assert.rejects(
    resolveBoardSlot(f.client, f.candidate),
    /new terminal identity/,
  );
});

test("live and unknown previous owners or board processes block reclaim", async (t) => {
  const f = await fixture(t);
  const original = f.parent.instance;
  for (const identity of [
    processIdentity(),
    { ...original, host: "unknown-host" },
  ]) {
    f.parent.instance = identity;
    await assert.rejects(
      resolveBoardSlot(f.client, f.candidate, "board"),
      /live or unknown owner/,
    );
  }
  f.parent.instance = original;
  for (const identity of [
    processIdentity(),
    { ...original, host: "unknown-host" },
  ]) {
    await writeJSON(path.join(f.prior, "board-runtime.json"), {
      instance: identity,
    });
    await assert.rejects(
      resolveBoardSlot(f.client, f.candidate, "board"),
      /process.*live or unknown/,
    );
  }
});

test("wrong pane, changed tab, unrelated cwd and changed layout cannot be reclaimed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    ensureBoard(f.client, true, "unrelated"),
    /recorded board/,
  );
  f.current.tab_id = "other";
  await assert.rejects(
    resolveBoardSlot(f.client, f.candidate, "board"),
    /identity changed/,
  );
  f.current.tab_id = "t";
  f.current.cwd = "/other";
  await assert.rejects(
    resolveBoardSlot(f.client, f.candidate, "board"),
    /right-hand slot/,
  );
  f.current.cwd = f.root;
  f.layout.panes[1].rect.x = 0;
  await assert.rejects(
    resolveBoardSlot(f.client, f.candidate, "board"),
    /right-hand slot/,
  );
  assert.ok(f.calls.every((a) => a[1] !== "run"));
});

test("reclaim cannot submit to foreground busy or incomplete process state", async (t) => {
  const f = await fixture(t);
  const call = f.client.call;
  f.client.call = async (args) =>
    args[1] === "process-info"
      ? {
          result: {
            process_info: {
              shell_pid: 123,
              foreground_process_group_id: 456,
              foreground_processes: [{ pid: 456 }],
            },
          },
        }
      : call(args);
  await assert.rejects(
    ensureBoard(f.client, true, "board"),
    /foreground or background/,
  );
  assert.ok(f.calls.every((a) => a[1] !== "run"));
  f.client.call = async (args) =>
    args[1] === "process-info"
      ? {
          result: {
            process_info: {
              shell_pid: 123,
              foreground_process_group_id: 123,
              foreground_processes: [],
            },
          },
        }
      : call(args);
  assert.equal(
    await shellAvailable(f.client, {
      pane: "board",
      tab: "t",
      terminal: "new-terminal",
    }),
    false,
  );
});

test("reassigned historical records do not block their actual successor", async (t) => {
  const f = await fixture(t);
  const obsolete = path.join(f.root, "runs", "obsolete");
  await writeJSON(path.join(obsolete, "parent.json"), {
    ...f.parent,
    instance: processIdentity(),
    updatedAt: "zzz",
  });
  await writeJSON(path.join(obsolete, "board.json"), {
    ...f.board,
    status: "reassigned",
    reassignedTo: f.prior,
  });
  const result = await ensureBoard(f.client, true, "board");
  assert.equal(result.status, "open");
  assert.equal(f.calls.filter((a) => a[1] === "run").length, 1);
});
