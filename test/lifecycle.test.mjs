import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Lifecycle, liveness } from "../src/lifecycle.mjs";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-"));
  const states = new Map([
    [11, { status: "alive", started: "one" }],
    [12, { status: "alive", started: "two" }],
  ]);
  const identity = (pid, token) => ({
    pid,
    token,
    host: os.hostname(),
    started: pid === 11 ? "one" : "two",
  });
  const instances = [];
  const create = (pid, token) => {
    const instance = new Lifecycle({
      root,
      storage: path.join(root, "state"),
      scope: path.join(root, token),
      identity: identity(pid, token),
      inspect: (pid) => states.get(pid) ?? { status: "dead" },
    });
    instances.push(instance);
    return instance;
  };
  t.after(() => {
    instances.forEach((x) => x.close());
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, states, create };
}
test("one owner per root; same process handoff fences stale session; new process never inherits family", (t) => {
  const { create, states } = fixture(t),
    first = create(11, "parent-a"),
    other = create(12, "parent-b");
  assert.equal(first.connect({ sessionId: "s1" }).acquired, true);
  assert.equal(other.connect({ sessionId: "s1" }).acquired, false);
  const rotated = create(11, "parent-a");
  assert.equal(rotated.connect({ sessionId: "s2" }).acquired, false);
  assert.equal(
    rotated.connect({ sessionId: "s2", handoff: true }).acquired,
    true,
  );
  assert.throws(() => first.assertOwned(), /does not own/);
  assert.equal(first.release(), false);
  states.set(11, { status: "dead" });
  const next = other.connect({ sessionId: "s1" });
  assert.equal(next.acquired, true);
  assert.equal(next.runId, "parent-b");
});
test("unknown owner cannot be taken over; PID reuse is a different process", (t) => {
  const { create, states } = fixture(t),
    a = create(11, "a"),
    b = create(12, "b");
  a.connect({ sessionId: "s" });
  states.set(11, { status: "unknown" });
  assert.equal(b.connect({ sessionId: "s" }).acquired, false);
  states.set(11, { status: "alive", started: "new incarnation" });
  assert.equal(b.connect({ sessionId: "s" }).acquired, true);
  assert.equal(liveness({ host: "another-host" }), "unknown");
});
test("checkout is retained through unclean death and only clean dead children reclaim automatically", (t) => {
  const { create, states, root } = fixture(t),
    a = create(11, "a");
  a.connect({ sessionId: "s" });
  const dir = path.join(root, "child");
  fs.mkdirSync(dir);
  const checkout = path.join(root, "repo");
  a.reserve(checkout, { agentId: "c1", dir });
  assert.throws(() => a.reserve(checkout, { agentId: "c2", dir }), /reserved/);
  const instance = { pid: 12, host: os.hostname(), started: "two" };
  fs.writeFileSync(
    path.join(dir, "ready.json"),
    JSON.stringify({ instance, cleanExit: true }),
  );
  assert.throws(() => a.reserve(checkout, { agentId: "c2", dir }), /reserved/);
  states.set(12, { status: "dead" });
  a.reserve(checkout, { agentId: "c2", dir });
  a.unreserve(checkout, "c1");
  assert.equal(a.reservation(checkout).agentId, "c2");
  a.unreserve(checkout, "c2");
  assert.equal(a.reservation(checkout), null);
});
