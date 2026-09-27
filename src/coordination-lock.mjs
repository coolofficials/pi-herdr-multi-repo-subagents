import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { processIdentity, liveness } from "./lifecycle.mjs";

export class CoordinationBusy extends Error {
  constructor() {
    super(
      "Coordination remained busy; no operation was submitted. Retry after the active operation settles.",
    );
    this.name = "CoordinationBusy";
  }
}
// Only lock acquisition is retried. Never repeat a side-effecting operation after it starts.
export async function withOperationLock(
  scope,
  operation,
  { timeoutMs = 120000, identity = processIdentity(), inspect = liveness } = {},
) {
  await fs.mkdir(scope, { recursive: true, mode: 0o700 });
  const file = path.join(scope, "operation.sqlite");
  const db = new DatabaseSync(file);
  const lease = randomUUID(),
    deadline = Date.now() + timeoutMs;
  let acquired = false;
  try {
    await fs.chmod(file, 0o600);
    db.exec("PRAGMA busy_timeout = 25");
    for (;;) {
      let transaction = false;
      try {
        db.exec(
          "CREATE TABLE IF NOT EXISTS operation (id INTEGER PRIMARY KEY CHECK(id=1), lease TEXT NOT NULL, identity TEXT NOT NULL)",
        );
        db.exec("BEGIN IMMEDIATE");
        transaction = true;
        let claimed = false;
        const prior = db
          .prepare("SELECT identity FROM operation WHERE id=1")
          .get();
        if (!prior || inspect(JSON.parse(prior.identity)) === "dead") {
          db.prepare("INSERT OR REPLACE INTO operation VALUES (1, ?, ?)").run(
            lease,
            JSON.stringify(identity),
          );
          claimed = true;
        }
        db.exec("COMMIT");
        transaction = false;
        acquired = claimed;
      } catch (error) {
        if (transaction) db.exec("ROLLBACK");
        if (error.errcode !== 5 && error.errcode !== 6) throw error;
      }
      if (acquired) break;
      if (Date.now() >= deadline) throw new CoordinationBusy();
      await new Promise((resolve) =>
        setTimeout(resolve, 75 + Math.floor(Math.random() * 50)),
      );
    }
    return await operation();
  } finally {
    try {
      if (acquired) db.exec("PRAGMA busy_timeout = 5000");
      if (acquired)
        db.prepare("DELETE FROM operation WHERE id=1 AND lease=?").run(lease);
    } finally {
      db.close();
    }
  }
}
