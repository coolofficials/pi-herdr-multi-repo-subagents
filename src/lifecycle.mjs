import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const runtimeKey = Symbol.for("pi-herdr-multi-repo-subagents.process");
const runtime = (globalThis[runtimeKey] ??= { token: randomUUID() });
runtime.handoffs ??= new Map();
export const handoffs = runtime.handoffs;

export function inspectProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { status: "unknown" };
  try {
    process.kill(pid, 0);
  } catch (error) {
    return { status: error.code === "ESRCH" ? "dead" : "unknown" };
  }
  try {
    const description = execFileSync(
      "ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "stat="],
      {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LC_ALL: "C" },
      },
    ).trim();
    const match = description.match(/^(.*\d{4})\s+(\S+)$/);
    if (!match) return { status: "unknown" };
    if (match[2].startsWith("Z")) return { status: "dead" };
    return { status: "alive", started: match[1] };
  } catch {
    return { status: "unknown" };
  }
}

export function processIdentity() {
  if (!runtime.identity) {
    const observed = inspectProcess(process.pid);
    if (observed.status !== "alive")
      throw new Error("Cannot identify this Pi process safely.");
    runtime.identity = {
      pid: process.pid,
      started: observed.started,
      host: os.hostname(),
      token: runtime.token,
    };
  }
  return runtime.identity;
}

export function liveness(identity, inspect = inspectProcess) {
  if (!identity || identity.host !== os.hostname()) return "unknown";
  const result = inspect(identity.pid);
  if (result.status === "dead") return "dead";
  if (result.status !== "alive" || !identity.started) return "unknown";
  return result.started === identity.started ? "alive" : "dead";
}

export class Lifecycle {
  constructor({
    storage,
    root,
    scope,
    env = process.env,
    identity,
    inspect = inspectProcess,
    coordinationKey = /** @type {string | undefined} */ (undefined),
  }) {
    this.root = fs.realpathSync(root);
    this.scope = scope;
    this.key = coordinationKey ?? this.root;
    this.env = env;
    this.identity = identity ?? processIdentity();
    /** @type {any} */
    this.lease = undefined;
    this.inspect = inspect;
    fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
    const file = path.join(storage, "lifecycle.sqlite");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS roots (root TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkouts (checkout TEXT PRIMARY KEY, state TEXT NOT NULL);
    `);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  read() {
    const row = this.db
      .prepare("SELECT state FROM roots WHERE root = ?")
      .get(this.key);
    return row ? JSON.parse(row.state) : null;
  }
  save(state) {
    this.db
      .prepare(
        "INSERT INTO roots VALUES (?, ?) ON CONFLICT(root) DO UPDATE SET state=excluded.state",
      )
      .run(this.key, JSON.stringify(state));
  }
  status() {
    const state = this.read();
    if (!state) return { status: "unclaimed" };
    return { ...state, processStatus: liveness(state.instance, this.inspect) };
  }
  connect({ sessionId, sessionFile, handoff = false, workScope = this.scope }) {
    return this.transaction(() => {
      const old = this.read();
      const ours = old?.instance?.token === this.identity.token;
      const live = old ? liveness(old.instance, this.inspect) : "dead";
      if (old?.status === "active" && !ours && live !== "dead") {
        return {
          ...old,
          acquired: false,
          reason:
            "Another main Pi process owns this root. Continue in its pane; do not launch competing work.",
        };
      }
      if (ours && old.sessionId !== sessionId && !handoff) {
        return {
          ...old,
          acquired: false,
          reason:
            "Conversation changed without handoff. Use /repo-agents continue with a handoff summary to keep this run's children.",
        };
      }
      const state = {
        schema: 1,
        root: this.root,
        scope: this.scope,
        runId: this.identity.token,
        workflowId: ours
          ? (old.workflowId ?? this.identity.token)
          : this.identity.token,
        workScope: ours ? (old.workScope ?? workScope) : workScope,
        role: this.key === this.root ? "orchestrator" : "task_lead",
        workflowRecovery: ours ? old.workflowRecovery : undefined,
        epoch:
          ours && old.sessionId === sessionId && old.status === "active"
            ? old.epoch
            : (old?.epoch ?? 0) + 1,
        sessionId,
        sessionFile,
        instance: this.identity,
        pane: this.env.HERDR_PANE_ID,
        socket: this.env.HERDR_SOCKET_PATH,
        status: "active",
        updatedAt: new Date().toISOString(),
      };
      this.save(state);
      this.lease = state;
      return {
        ...state,
        acquired: true,
        recovered: Boolean(
          ours && (old.sessionId !== sessionId || old.status !== "active"),
        ),
      };
    });
  }
  bindWorkflow(workScope, recovery) {
    return this.transaction(() => {
      const state = this.assertOwned();
      const updated = {
        ...state,
        workScope,
        workflowId: path.basename(workScope),
        workflowRecovery: recovery,
      };
      this.save(updated);
      this.lease = updated;
      return updated;
    });
  }
  assertOwned() {
    const state = this.read();
    if (
      !this.lease ||
      !state ||
      state.status !== "active" ||
      state.instance.token !== this.identity.token ||
      state.epoch !== this.lease.epoch ||
      state.sessionId !== this.lease.sessionId
    ) {
      throw new Error(
        "This Pi session does not own repository coordination. Inspect /repo-agents; do not launch competing work.",
      );
    }
    return state;
  }
  release(reason = "quit") {
    return this.transaction(() => {
      if (!this.lease) return false;
      const state = this.read();
      if (
        state?.instance?.token !== this.identity.token ||
        state?.epoch !== this.lease.epoch ||
        state?.sessionId !== this.lease.sessionId
      )
        return false;
      this.save({
        ...state,
        status: "released",
        reason,
        updatedAt: new Date().toISOString(),
      });
      this.lease = undefined;
      return true;
    });
  }
  reserve(checkout, record) {
    return this.transaction(() => {
      this.assertOwned();
      const row = this.db
        .prepare("SELECT state FROM checkouts WHERE checkout=?")
        .get(checkout);
      if (row) {
        const held = JSON.parse(row.state);
        let ready;
        try {
          ready = JSON.parse(
            fs.readFileSync(path.join(held.dir, "ready.json"), "utf8"),
          );
        } catch {}
        if (
          !ready?.cleanExit ||
          liveness(ready.instance, this.inspect) !== "dead"
        ) {
          throw new Error(
            `Checkout already reserved by ${held.agentId} in ${held.root}. It may be finishing or require inspection after an unclean exit. Report directory: ${held.dir}`,
          );
        }
        this.db.prepare("DELETE FROM checkouts WHERE checkout=?").run(checkout);
      }
      this.db
        .prepare("INSERT INTO checkouts VALUES (?, ?)")
        .run(checkout, JSON.stringify({ ...record, root: this.root }));
    });
  }
  reservation(checkout) {
    const row = this.db
      .prepare("SELECT state FROM checkouts WHERE checkout=?")
      .get(checkout);
    return row ? JSON.parse(row.state) : null;
  }
  unreserve(checkout, agentId) {
    return this.transaction(() => {
      this.assertOwned();
      const row = this.db
        .prepare("SELECT state FROM checkouts WHERE checkout=?")
        .get(checkout);
      if (row && JSON.parse(row.state).agentId === agentId)
        this.db.prepare("DELETE FROM checkouts WHERE checkout=?").run(checkout);
    });
  }
  close() {
    this.db.close();
  }
}
