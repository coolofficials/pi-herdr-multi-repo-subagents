import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { writeJSON } from "./storage.mjs";
export async function runCheck(
  dir,
  jobId,
  cwd,
  { command, timeout = 120 },
  signal,
) {
  if (
    typeof command !== "string" ||
    !command.trim() ||
    command.length > 4000 ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 900
  )
    throw Error(
      "Provide an authorized check command (1–4000 chars), timeout 1–900 seconds.",
    );
  signal?.throwIfAborted();
  const id = randomUUID(),
    createdAt = new Date().toISOString();
  await writeJSON(path.join(dir, "checks", id + ".intent.json"), {
    id,
    jobId,
    cwd,
    command,
    createdAt,
    status: "accepted",
  });
  const limit = 8 * 1024 * 1024;
  let bytes = 0,
    chunks = [],
    truncated = false,
    reason;
  const child = spawn("/bin/sh", ["-c", command], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (data) => {
    const keep = data.subarray(0, Math.max(0, limit - bytes));
    if (keep.length) chunks.push(keep);
    bytes += keep.length;
    if (keep.length < data.length) truncated = true;
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const stop = (why) => {
    if (reason) return;
    reason = why;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    killTimer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 1000);
  };
  let killTimer;
  const timer = setTimeout(() => stop("timeout"), timeout * 1000),
    abort = () => stop("aborted");
  signal?.addEventListener("abort", abort, { once: true });
  const status = await new Promise((resolve) => {
    child.once("error", (error) =>
      resolve({ exitCode: null, error: String(error) }),
    );
    child.once("close", (code, signal) => resolve({ exitCode: code, signal }));
  });
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  signal?.removeEventListener("abort", abort);
  const text = Buffer.concat(chunks).toString("utf8");
  const record = {
    id,
    jobId,
    tool: "repo_check",
    command,
    cwd,
    createdAt,
    finishedAt: new Date().toISOString(),
    ...status,
    reason,
    text,
    hash: createHash("sha256").update(text).digest("hex"),
    chars: text.length,
    complete: !truncated,
    isError: status.exitCode !== 0 || Boolean(reason),
    reuse:
      "Never automatically reused; external/environment inputs are not fingerprinted.",
  };
  await writeJSON(path.join(dir, "artifacts", id + ".json"), record);
  await writeJSON(path.join(dir, "checks", id + ".result.json"), {
    ...record,
    text: undefined,
  });
  return {
    id,
    jobId,
    exitCode: record.exitCode,
    reason,
    complete: record.complete,
    isError: record.isError,
    preview:
      text.length <= 6000
        ? text
        : text.slice(0, 2500) +
          "\n[Use repo_artifact for full captured check output]\n" +
          text.slice(-2500),
    reuse: record.reuse,
  };
}
