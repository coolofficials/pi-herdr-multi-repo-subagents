import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  withOperationLock,
  CoordinationBusy,
} from "../src/coordination-lock.mjs";
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-operation-lock-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test("cross-process contenders wait without repeating the operation", async (t) => {
  const dir = await fixture(t);
  let enter;
  const entered = new Promise((r) => (enter = r));
  let leave;
  const gate = new Promise((r) => (leave = r));
  const first = withOperationLock(dir, async () => {
    enter();
    await gate;
  });
  await entered;
  const script = `import {withOperationLock} from ${JSON.stringify(new URL("../src/coordination-lock.mjs", import.meta.url).href)}; await withOperationLock(process.argv[1],async()=>{console.log('executed');});`;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    script,
    dir,
  ]);
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  const exited = once(child, "exit");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(output, "");
  leave();
  await first;
  assert.equal((await exited)[0], 0);
  assert.equal(output.trim(), "executed");
});
test("busy timeout and unknown owners never enter; confirmed dead owner is recovered", async (t) => {
  const dir = await fixture(t);
  await withOperationLock(dir, async () => {});
  const db = new DatabaseSync(path.join(dir, "operation.sqlite"));
  db.prepare("INSERT INTO operation VALUES (1,?,?)").run(
    "stale",
    JSON.stringify({ pid: 999999 }),
  );
  db.close();
  let calls = 0;
  await assert.rejects(
    withOperationLock(
      dir,
      async () => {
        calls++;
      },
      { timeoutMs: 0, inspect: () => "unknown" },
    ),
    CoordinationBusy,
  );
  assert.equal(calls, 0);
  await withOperationLock(
    dir,
    async () => {
      calls++;
    },
    { timeoutMs: 0, inspect: () => "dead" },
  );
  assert.equal(calls, 1);
});
test("throwing operation releases lock and is never retried", async (t) => {
  const dir = await fixture(t);
  let calls = 0;
  await assert.rejects(
    withOperationLock(dir, async () => {
      calls++;
      throw Error("submitted then failed");
    }),
    /submitted then failed/,
  );
  await withOperationLock(dir, async () => {
    calls++;
  });
  assert.equal(calls, 2);
});

test("a failed lock commit never enters the protected operation", async (t) => {
  const dir = await fixture(t);
  await withOperationLock(dir, async () => {});
  const reader = new DatabaseSync(path.join(dir, "operation.sqlite"));
  reader.exec("BEGIN");
  reader.prepare("SELECT * FROM operation").all();
  let calls = 0;
  try {
    await assert.rejects(
      withOperationLock(
        dir,
        async () => {
          calls++;
        },
        { timeoutMs: 0 },
      ),
      CoordinationBusy,
    );
    assert.equal(calls, 0);
  } finally {
    reader.exec("ROLLBACK");
    reader.close();
  }
  await withOperationLock(dir, async () => {
    calls++;
  });
  assert.equal(calls, 1);
});
