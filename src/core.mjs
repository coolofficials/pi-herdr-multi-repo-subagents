import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const hash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 20);
const ignored = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  ".git",
  ".jj",
]);
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
export const MARKER = "PI_HERDR_TASK:";
export const childExtension = fileURLToPath(
  new URL("./child.ts", import.meta.url),
);
export async function readJSON(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
export async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temp, file);
}
async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
export function isDescendant(root, candidate) {
  const rel = path.relative(root, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}
export async function resolveRepo(root, relative) {
  root = await fs.realpath(root);
  if (path.isAbsolute(relative))
    throw new Error("Use a repository path relative to the task root.");
  const repo = await fs.realpath(path.resolve(root, relative));
  if (!isDescendant(root, repo))
    throw new Error("Repository must be a descendant of the task root.");
  const git = await exists(path.join(repo, ".git"));
  const jj = await exists(path.join(repo, ".jj"));
  if (!git && !jj) throw new Error(`Not a repository root: ${relative}`);
  return {
    repo: path.relative(root, repo).split(path.sep).join("/"),
    path: repo,
    vcs: jj ? "jj" : "git",
  };
}
export async function loadConfig(root) {
  const config = await readJSON(path.join(root, "pi-herdr.json"), {});
  const allowed = new Set([
    "include",
    "exclude",
    "maxDepth",
    "model",
    "thinking",
    "direction",
    "layout",
  ]);
  if (!config || Array.isArray(config) || typeof config !== "object")
    throw new Error("pi-herdr.json must be an object.");
  for (const key of Object.keys(config))
    if (!allowed.has(key)) throw new Error(`Unknown pi-herdr.json key: ${key}`);
  for (const key of ["include", "exclude"])
    if (
      config[key] !== undefined &&
      (!Array.isArray(config[key]) ||
        config[key].some(
          (x) =>
            typeof x !== "string" ||
            path.isAbsolute(x) ||
            x.split(/[\\/]/).includes(".."),
        ))
    )
      throw new Error(`${key} must contain relative paths without '..'.`);
  if (
    config.maxDepth !== undefined &&
    (!Number.isInteger(config.maxDepth) ||
      config.maxDepth < 1 ||
      config.maxDepth > 32)
  )
    throw new Error("maxDepth must be between 1 and 32.");
  if (
    config.model !== undefined &&
    (typeof config.model !== "string" || !config.model.trim())
  )
    throw new Error("model must be a nonempty string.");
  if (
    config.thinking !== undefined &&
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      config.thinking,
    )
  )
    throw new Error("Invalid thinking level.");
  if (
    config.direction !== undefined &&
    !["right", "down"].includes(config.direction)
  )
    throw new Error("direction must be right or down.");
  if (config.layout !== undefined && !["tabs", "split"].includes(config.layout))
    throw new Error("layout must be tabs or split.");
  return config;
}
export async function discoverRepos(root, config) {
  root = await fs.realpath(root);
  config ??= await loadConfig(root);
  const excluded = (config.exclude ?? []).map((p) => path.resolve(root, p));
  const skip = (p) => excluded.some((x) => p === x || isDescendant(x, p));
  const repos = [];
  const warnings = [];
  let visited = 0;
  if (config.include) {
    for (const relative of config.include) {
      const repo = await resolveRepo(root, relative);
      if (!skip(repo.path) && !repos.some((r) => r.path === repo.path))
        repos.push(repo);
    }
  } else {
    async function walk(dir, depth) {
      if (++visited > 10000)
        throw new Error(
          "Repository discovery exceeded 10000 directories; use include/exclude in pi-herdr.json.",
        );
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (e) {
        if (["EACCES", "EPERM"].includes(e.code)) {
          warnings.push(`Cannot read ${path.relative(root, dir)}`);
          return;
        }
        throw e;
      }
      for (const ent of entries) {
        if (
          !ent.isDirectory() ||
          ent.name.startsWith(".") ||
          ignored.has(ent.name)
        )
          continue;
        const p = path.join(dir, ent.name);
        if (skip(p)) continue;
        if (
          (await exists(path.join(p, ".git"))) ||
          (await exists(path.join(p, ".jj")))
        )
          repos.push(await resolveRepo(root, path.relative(root, p)));
        else if (depth < (config.maxDepth ?? 8)) await walk(p, depth + 1);
        else warnings.push(`Depth limit reached: ${path.relative(root, p)}`);
      }
    }
    await walk(root, 1);
  }
  return {
    root,
    repositories: repos.sort((a, b) => a.repo.localeCompare(b.repo)),
    warnings,
  };
}
export async function herdr(args, options = {}) {
  const env = options.env ?? process.env;
  if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID || !env.HERDR_SOCKET_PATH)
    throw new Error(
      "Start Pi inside a Herdr pane before controlling repository agents.",
    );
  try {
    const { stdout } = await exec("herdr", args, {
      env,
      signal: options.signal,
      timeout: options.timeout ?? 40000,
      maxBuffer: 1024 * 1024,
    });
    return options.raw ? stdout : JSON.parse(stdout);
  } catch (e) {
    const error = new Error(
      `Herdr ${args.slice(0, 2).join(" ")} failed: ${e.stderr || e.message}`,
    );
    error.cause = e;
    throw error;
  }
}
export function summarizeMessages(messages) {
  const assistants = messages.filter((m) => m.role === "assistant");
  const last = assistants.at(-1);
  const text =
    last?.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n") ?? "";
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
  for (const msg of assistants) {
    for (const key of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "totalTokens",
    ])
      usage[key] += msg.usage?.[key] ?? 0;
    usage.cost += msg.usage?.cost?.total ?? 0;
  }
  return {
    summary: text,
    usage,
    error: last?.errorMessage,
    stopReason: last?.stopReason,
  };
}
export function validateWork(task, context = "") {
  if (typeof task !== "string" || !task.trim())
    throw new Error("Task must not be empty.");
  if (typeof context !== "string" || task.length + context.length > 48000)
    throw new Error(
      "Task and context must total at most 48000 characters. Pass relevant file paths for larger material.",
    );
}
export class Controller {
  constructor({
    root,
    storage = undefined,
    owner = "",
    env = process.env,
    transport = herdr,
  }) {
    this.root = realpathSync(root);
    this.env = env;
    this.transport = transport;
    this.owner = owner;
    this.queue = Promise.resolve();
    this.storage =
      storage ??
      path.join(
        env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
        "pi-herdr-multi-repo-subagents",
      );
    this.scope = path.join(
      this.storage,
      hash(`${this.root}\n${env.HERDR_SOCKET_PATH ?? ""}`),
    );
    this.indexFile = path.join(this.scope, "agents.json");
  }
  async call(args, signal, raw = false, timeout) {
    return this.transport(args, { env: this.env, signal, raw, timeout });
  }
  async records() {
    return readJSON(this.indexFile, []);
  }
  async locked(fn) {
    const pending = this.queue.then(() => this.acquire(fn));
    this.queue = pending.catch(() => {});
    return pending;
  }
  async acquire(fn) {
    await fs.mkdir(this.scope, { recursive: true, mode: 0o700 });
    const lock = path.join(this.scope, "operation.lock");
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        handle = await fs.open(lock, "wx", 0o600);
        await handle.writeFile(String(process.pid));
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        const pid = Number(await fs.readFile(lock, "utf8"));
        if (pid > 0) {
          try {
            process.kill(pid, 0);
            throw new Error(
              "Another repository-agent operation is in progress. Retry after it finishes.",
            );
          } catch (err) {
            if (err.code !== "ESRCH") throw err;
          }
        } else
          throw new Error(
            "Repository-agent lock is being initialized. Retry shortly.",
          );
        await fs.unlink(lock);
      }
    }
    if (!handle) throw new Error("Could not acquire repository-agent lock.");
    try {
      return await fn();
    } finally {
      await handle.close();
      await fs.unlink(lock);
    }
  }
  async list() {
    const found = await discoverRepos(this.root);
    const records = await this.records();
    const agents = await Promise.all(
      records.map(async ({ id, repo, pane, jobId, phase, dir }) => {
        const report = jobId
          ? await readJSON(path.join(dir, `${jobId}.result.json`))
          : null;
        const activity = await readJSON(path.join(dir, "activity.json"));
        return {
          id,
          repo,
          pane,
          jobId,
          status:
            report?.status ??
            (activity?.jobId === jobId ? activity.status : phase),
        };
      }),
    );
    return { ...found, agents };
  }
  async record(id) {
    const record = (await this.records()).find((x) => x.id === id);
    if (!record)
      throw new Error("Unknown agent ID for this root and Herdr session.");
    return record;
  }
  async start({ repo, task, context = "", model, thinking }, signal) {
    validateWork(task, context);
    return this.locked(async () => {
      const config = await loadConfig(this.root);
      const found = await discoverRepos(this.root, config);
      const selected = await resolveRepo(this.root, repo);
      if (!found.repositories.some((r) => r.path === selected.path))
        throw new Error(
          "Repository is excluded from discovery. Add it to pi-herdr.json include if intended.",
        );
      const records = await this.records();
      const existing = records.find((r) => r.path === selected.path);
      if (existing)
        throw new Error(
          `Repository already has agent ${existing.id}. Use repo_agent_prompt, or forget it after exiting its Pi session.`,
        );
      await this.call(["status"], signal, true);
      const layout = await this.call(["pane", "layout", "--current"], signal);
      const rect = layout.result?.layout?.panes?.find(
        (p) => p.pane_id === this.env.HERDR_PANE_ID,
      )?.rect;
      const cols = rect?.width ?? 0;
      const rows = rect?.height ?? 0;
      const direction =
        config.direction ??
        (cols >= 120 && cols >= rows * 2 ? "right" : "down");
      const id = `repo-${randomUUID().slice(0, 12)}`;
      const dir = path.join(this.scope, id);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const split = await this.call(
        config.layout === "split"
          ? [
              "pane",
              "split",
              "--current",
              "--direction",
              direction,
              "--cwd",
              selected.path,
              "--env",
              `PI_HERDR_CHILD_DIR=${dir}`,
              "--no-focus",
            ]
          : [
              "tab",
              "create",
              "--workspace",
              this.env.HERDR_WORKSPACE_ID,
              "--label",
              selected.repo,
              "--cwd",
              selected.path,
              "--env",
              `PI_HERDR_CHILD_DIR=${dir}`,
              "--no-focus",
            ],
        signal,
      );
      const pane =
        split.result?.pane?.pane_id ?? split.result?.root_pane?.pane_id;
      if (!pane)
        throw new Error(
          "Herdr layout creation returned no pane ID. Inspect the session before retrying.",
        );
      const record = {
        id,
        ...selected,
        pane,
        dir,
        phase: "starting",
        createdAt: new Date().toISOString(),
      };
      records.push(record);
      await writeJSON(this.indexFile, records);
      const args = [
        "agent",
        "start",
        id,
        "--kind",
        "pi",
        "--pane",
        pane,
        "--timeout",
        "30000",
        "--",
        "--extension",
        childExtension,
        "--name",
        `repo: ${selected.repo}`,
        "--session-dir",
        path.join(dir, "sessions"),
      ];
      if (config.model ?? model) args.push("--model", config.model ?? model);
      if (config.thinking ?? thinking)
        args.push("--thinking", config.thinking ?? thinking);
      try {
        await this.call(args, signal, false, 35000);
        const deadline = Date.now() + 5000;
        while (!(await readJSON(path.join(dir, "ready.json")))) {
          if (Date.now() > deadline)
            throw new Error(
              "Child bridge did not initialize. Inspect the pane.",
            );
          await sleep(100, signal);
        }
        record.phase = "ready";
        await writeJSON(this.indexFile, records);
        return await this.submit(record, records, task, context, signal);
      } catch (e) {
        record.phase = "needs-attention";
        record.lastError = e.message;
        await writeJSON(this.indexFile, records);
        throw new Error(
          `${e.message}\nPane retained: ${pane}; agent: ${id}. Inspect with repo_agent_read; do not blindly start again.`,
        );
      }
    });
  }
  async submit(record, records, task, context, signal) {
    validateWork(task, context);
    const live = await this.call(["agent", "get", record.id], signal);
    const state =
      live.result?.agent?.status ?? live.result?.agent?.agent_status;
    if (!["idle", "done"].includes(state))
      throw new Error(
        `Agent is ${state ?? "unknown"}; inspect it before sending work.`,
      );
    const jobId = randomUUID();
    await writeJSON(path.join(record.dir, "request.json"), {
      jobId,
      task,
      context,
    });
    record.jobId = jobId;
    record.owner = this.owner;
    record.phase = "submitted";
    delete record.lastError;
    await writeJSON(this.indexFile, records);
    const prompt = `${MARKER}${jobId}\nTask root: ${this.root}\nRepository: ${record.path}\n\n${task}\n\nRelevant context:\n${context || "(none supplied)"}\n\nFollow all applicable AGENTS.md instructions, including language and review policies. Work in your assigned repository; coordinate cross-repository work through the parent. You are not alone in this task: preserve others' changes. Conclude with a concise report of outcome, changed files, checks actually performed, unresolved issues, and cross-repository dependencies. Distinguish incomplete work from completion. Do not reproduce terminal logs. This report is captured automatically; no report file is required.`;
    try {
      await this.call(["agent", "prompt", record.id, prompt], signal);
    } catch (e) {
      record.phase = "submission-uncertain";
      record.lastError = e.message;
      await writeJSON(this.indexFile, records);
      throw new Error(
        `${e.message}\nSubmission may have happened. Inspect ${record.id}; do not resend automatically.`,
      );
    }
    return {
      id: record.id,
      repo: record.repo,
      pane: record.pane,
      jobId,
      status: "submitted",
    };
  }
  async prompt({ id, task, context = "" }, signal) {
    return this.locked(async () => {
      const records = await this.records();
      const record = records.find((r) => r.id === id);
      if (!record) throw new Error("Unknown agent ID.");
      if (
        record.jobId &&
        !(await readJSON(path.join(record.dir, `${record.jobId}.result.json`)))
      )
        throw new Error(
          "Previous delegated job has no settled report. Inspect it; do not overwrite its request.",
        );
      return this.submit(record, records, task, context, signal);
    });
  }
  async read({ id, logs = false }, signal) {
    const record = await this.record(id);
    const report = record.jobId
      ? await readJSON(path.join(record.dir, `${record.jobId}.result.json`))
      : null;
    const activity = await readJSON(path.join(record.dir, "activity.json"));
    let live, liveError;
    try {
      live = (await this.call(["agent", "get", id], signal)).result?.agent;
    } catch (e) {
      liveError = e.message;
    }
    const liveState = live?.status ?? live?.agent_status ?? "unavailable";
    const status =
      report?.status ??
      (liveState === "blocked"
        ? "blocked"
        : !live
          ? "unavailable"
          : activity?.jobId === record.jobId
            ? activity.status
            : record.phase);
    const result = {
      id,
      repo: record.repo,
      pane: live?.pane_id ?? record.pane,
      jobId: record.jobId,
      status,
      liveState,
      liveError,
      report: report
        ? {
            ...report,
            summary: report.summary.slice(0, 12000),
            truncated: report.summary.length > 12000,
            fullReport: path.join(record.dir, `${record.jobId}.result.json`),
          }
        : null,
    };
    if (logs)
      result.logs = await this.call(
        ["agent", "read", id, "--source", "visible", "--lines", "80"],
        signal,
        true,
      );
    return result;
  }
  async wait({ id, timeout = 30 }, signal) {
    const deadline = Date.now() + Math.max(1, Math.min(timeout, 60)) * 1000;
    for (;;) {
      const result = await this.read({ id }, signal);
      if (result.report || ["blocked", "unavailable"].includes(result.status))
        return result;
      if (Date.now() >= deadline) return { ...result, timedOut: true };
      await sleep(Math.min(1000, Math.max(1, deadline - Date.now())), signal);
    }
  }
  async reset({ id, reason, task, context = "" }, signal) {
    validateWork(task, context);
    if (!reason?.trim())
      throw new Error("Explain why a fresh session is useful.");
    return this.locked(async () => {
      const records = await this.records();
      const record = records.find((r) => r.id === id);
      if (!record) throw new Error("Unknown agent ID.");
      if (
        record.jobId &&
        !(await readJSON(path.join(record.dir, `${record.jobId}.result.json`)))
      )
        throw new Error("Wait for the current job to settle before resetting.");
      const live = (await this.call(["agent", "get", id], signal)).result
        ?.agent;
      if (!["idle", "done"].includes(live?.status ?? live?.agent_status))
        throw new Error("Child must be idle before resetting.");
      const previous = await readJSON(path.join(record.dir, "ready.json"));
      record.phase = "resetting";
      await writeJSON(this.indexFile, records);
      await this.call(["agent", "prompt", id, "/new"], signal);
      const deadline = Date.now() + 10000;
      for (;;) {
        const current = await readJSON(path.join(record.dir, "ready.json"));
        if (current?.sessionId && current.sessionId !== previous?.sessionId) {
          const refreshed = (await this.call(["agent", "get", id], signal))
            .result?.agent;
          if (
            ["idle", "done"].includes(
              refreshed?.status ?? refreshed?.agent_status,
            )
          )
            break;
        }
        if (Date.now() > deadline)
          throw new Error(
            `Session reset is unconfirmed for ${id}. Inspect the pane before retrying.`,
          );
        await sleep(200, signal);
      }
      record.previousSession = previous?.sessionFile;
      return this.submit(
        record,
        records,
        task,
        `Reason for fresh context: ${reason}\n\n${context}`,
        signal,
      );
    });
  }
  async forget({ id }, signal) {
    return this.locked(async () => {
      const record = await this.record(id);
      const response = await this.call(["agent", "list"], signal);
      const agents = response.result?.agents;
      if (!Array.isArray(agents))
        throw new Error("Unrecognized Herdr agent list; cannot safely forget.");
      if (agents.some((a) => a.name === id || a.pane_id === record.pane))
        throw new Error(
          "Exit the child Pi session first. Its pane and logs will remain.",
        );
      await writeJSON(
        this.indexFile,
        (await this.records()).filter((r) => r.id !== id),
      );
      return { id, status: "forgotten", retained: record.dir };
    });
  }
}
