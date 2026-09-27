import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readJSON, writeJSON, resolveRepo } from "./core.mjs";
import { sourceFiles, scopedPath } from "./access.mjs";

const exec = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const safeId = (id) => {
  if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id))
    throw new Error("Invalid workflow ID.");
  return id;
};
const directory = (scope) => path.join(scope, "work");
const workFile = (scope, id) =>
  path.join(directory(scope), `${safeId(id)}.json`);
export async function getWork(scope, id) {
  const value = await readJSON(workFile(scope, id));
  if (!value) throw new Error("Unknown work bundle.");
  return value;
}
export async function snapshot(repo) {
  let files;
  let git = true;
  try {
    await fs.lstat(path.join(repo, ".git"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    git = false;
  }
  if (git) {
    try {
      const { stdout } = await exec(
        "git",
        [
          "--no-optional-locks",
          "-C",
          repo,
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
        ],
        { maxBuffer: 2 * 1024 * 1024, timeout: 15000 },
      );
      files = [...new Set(stdout.split("\0").filter(Boolean))].sort();
    } catch {
      throw new Error("Cannot enumerate Git review scope safely.");
    }
  } else {
    files = await sourceFiles(repo, true);
  }
  if (files.length > 5000)
    throw new Error(
      "Review snapshot exceeds 5000 files. Use a narrower independently reviewable repository.",
    );
  const entries = Object.create(null);
  let bytes = 0;
  for (const file of files) {
    let target, stat;
    try {
      target = await scopedPath(repo, file);
      stat = await fs.lstat(target);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024)
      throw new Error(
        `Unsupported review entry: ${file}. Snapshots require regular files up to 2 MiB without hard links/submodules/symlinks.`,
      );
    bytes += stat.size;
    if (bytes > 32 * 1024 * 1024)
      throw new Error(
        "Review snapshot exceeds 32 MiB. No partial approval is possible.",
      );
    const content = await fs.readFile(target);
    const after = await fs.lstat(target);
    if (
      after.mtimeMs !== stat.mtimeMs ||
      after.size !== stat.size ||
      after.ino !== stat.ino
    )
      throw new Error("Checkout changed during snapshot. Retry when idle.");
    entries[file] = {
      hash: digest(content),
      mode: stat.mode & 0o777,
      data: content.toString("base64"),
      binary: content.includes(0),
    };
  }
  return {
    fingerprint: digest(
      JSON.stringify(
        Object.entries(entries).map(([file, item]) => [
          file,
          item.hash,
          item.mode,
        ]),
      ),
    ),
    entries,
  };
}
export async function ensureIdle(client, repos) {
  for (const record of await client.records()) {
    if (!repos.includes(record.repo)) continue;
    const state = await client.read({ id: record.id });
    if (
      (record.jobId && !state.report) ||
      (!["idle", "done"].includes(state.liveState) &&
        state.processStatus !== "dead")
    )
      throw new Error(
        `Repository ${record.repo} is not confirmed idle; finish its accepted work first.`,
      );
  }
}
export async function createWork(
  client,
  { title = "", requirements = "", repos = /** @type {string[]} */ ([]) },
) {
  if (
    !title?.trim() ||
    title.length > 160 ||
    !requirements?.trim() ||
    requirements.length > 8000 ||
    !Array.isArray(repos) ||
    !repos.length ||
    repos.length > 12
  )
    throw new Error(
      "Provide a title, acceptance requirements (max 8000 characters) and 1–12 repositories.",
    );
  await client.requireOwnership();
  return client.locked(async () => {
    const paths = await Promise.all(
      [...new Set(repos)].map((repo) => resolveRepo(client.root, repo)),
    );
    await ensureIdle(
      client,
      paths.map((item) => item.repo),
    );
    const existing = await listWork(client.scope);
    if (
      existing.some(
        (work) =>
          work.status !== "completed" &&
          work.repos.some((repo) => paths.some((p) => p.repo === repo)),
      )
    )
      throw new Error(
        "An unfinished bundle already covers a requested repository. Continue it rather than resetting its review budget.",
      );
    const id = randomUUID();
    const work = {
      id,
      title,
      requirements,
      revision: 1,
      status: "implementing",
      repos: Object.create(null),
      createdAt: new Date().toISOString(),
    };
    for (const selected of paths) {
      const base = await snapshot(selected.path);
      const baseline = path.join(
        directory(client.scope),
        `${id}-${digest(selected.repo).slice(0, 12)}.baseline.json`,
      );
      await writeJSON(baseline, base);
      work.repos[selected.repo] = {
        path: selected.path,
        baseline,
        base: base.fingerprint,
        reviews: [],
      };
    }
    await writeJSON(workFile(client.scope, id), work);
    return {
      id,
      title,
      requirements,
      repos: Object.keys(work.repos),
      status: work.status,
    };
  });
}
export async function listWork(scope) {
  const files = await fs.readdir(directory(scope)).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const records = [];
  for (const file of files.filter((name) =>
    /^[a-f0-9-]{36}\.json$/.test(name),
  )) {
    const work = await readJSON(path.join(directory(scope), file));
    records.push({
      id: work.id,
      title: work.title,
      status: work.status,
      repos: Object.keys(work.repos),
    });
  }
  return records;
}
export async function assignWork(client, record, jobId, role, bundle) {
  if (!bundle) {
    if (["implementer", "reviewer", "verifier"].includes(role))
      throw new Error(
        "Create a work bundle before implementation, review or verification.",
      );
    return null;
  }
  const work = await getWork(client.scope, bundle);
  const repo = work.repos[record.repo];
  if (!repo || work.status === "completed")
    throw new Error(
      "Work bundle does not include this repository or is already completed.",
    );
  const contract = {
    bundle,
    requirements: work.requirements,
    requirementsRevision: work.revision ?? 1,
    baseline: repo.baseline,
  };
  if (role === "reviewer") {
    if (repo.reviews.length >= (repo.reviewLimit ?? 3))
      throw new Error(
        "Review budget exhausted (initial + 2 re-reviews). Keep the bundle blocked and ask the user to reconsider scope or explicitly extend the budget.",
      );
    const current = await snapshot(record.path);
    const previous = repo.reviews.at(-1);
    const previousResult = previous
      ? await readJSON(path.join(previous.dir, `${previous.jobId}.result.json`))
      : null;
    const savedTarget = path.join(
      directory(client.scope),
      `${bundle}-${jobId}.target.json`,
    );
    await writeJSON(savedTarget, current);
    const review = {
      jobId,
      agentId: record.id,
      dir: record.dir,
      attempt: repo.reviews.length + 1,
      limit: repo.reviewLimit ?? 3,
      target: current.fingerprint,
      requirementsRevision: work.revision ?? 1,
      snapshot: savedTarget,
    };
    repo.reviews.push(review);
    work.status = "reviewing";
    contract.review = review;
    contract.previousReview = previous
      ? {
          target: previous.target,
          snapshot: previous.snapshot,
          brief: previousResult?.brief ?? null,
        }
      : null;
  } else if (role === "implementer") {
    work.status = "implementing";
  }
  await writeJSON(workFile(client.scope, bundle), work);
  return contract;
}
export async function reviewChanges(
  request,
  repoPath,
  {
    file = /** @type {string | undefined} */ (undefined),
    offset = 0,
    since = "baseline",
  },
) {
  if (!request?.contract?.review)
    throw new Error("This is not an assigned review.");
  if (!["baseline", "previous_review"].includes(since))
    throw new Error("Invalid comparison baseline.");
  const baselineFile =
    since === "previous_review"
      ? request.contract.previousReview?.snapshot
      : request.contract.baseline;
  if (!baselineFile)
    throw new Error(
      "There is no prior review snapshot for incremental review.",
    );
  const base = await readJSON(baselineFile);
  const current = await snapshot(repoPath);
  if (current.fingerprint !== request.contract.review.target)
    throw new Error(
      "Code changed since review began. Stop and ask the parent for a new review attempt.",
    );
  const changed = [
    ...new Set([...Object.keys(base.entries), ...Object.keys(current.entries)]),
  ]
    .filter(
      (name) =>
        base.entries[name]?.hash !== current.entries[name]?.hash ||
        base.entries[name]?.mode !== current.entries[name]?.mode,
    )
    .sort();
  if (!file)
    return {
      fingerprint: current.fingerprint,
      changed: changed.slice(offset, offset + 100),
      nextOffset: offset + 100 < changed.length ? offset + 100 : null,
      total: changed.length,
    };
  if (!changed.includes(file))
    throw new Error(
      "File is not part of this change; use repo_source for surrounding code.",
    );
  const before = base.entries[file],
    after = current.entries[file];
  const fragment = (entry) =>
    entry
      ? entry.binary
        ? "[binary: inspect with appropriate verification; do not approve without evidence]"
        : Buffer.from(entry.data, "base64")
            .toString("utf8")
            .slice(offset, offset + 7000)
      : "[absent]";
  return {
    file,
    fingerprint: current.fingerprint,
    before: fragment(before),
    after: fragment(after),
    beforeMode: before?.mode,
    afterMode: after?.mode,
    nextOffset:
      Math.max(
        before?.binary
          ? 0
          : Buffer.from(before?.data ?? "", "base64").toString("utf8").length,
        after?.binary
          ? 0
          : Buffer.from(after?.data ?? "", "base64").toString("utf8").length,
      ) >
      offset + 7000
        ? offset + 7000
        : null,
  };
}
export async function workStatus(client, id, complete = false) {
  const work = await getWork(client.scope, id);
  if (complete) await ensureIdle(client, Object.keys(work.repos));
  const results = [];
  for (const [repo, state] of Object.entries(work.repos)) {
    const latest = state.reviews.at(-1);
    const report = latest
      ? await readJSON(path.join(latest.dir, `${latest.jobId}.result.json`))
      : null;
    const current = await snapshot(state.path);
    const valid =
      report?.status === "settled" &&
      report?.brief?.verdict === "pass" &&
      report?.brief?.outcome === "completed" &&
      report?.review?.target === current.fingerprint &&
      report?.review?.requirementsRevision === (work.revision ?? 1) &&
      latest.target === current.fingerprint;
    results.push({
      repo,
      attempts: state.reviews.length,
      reviewValid: Boolean(valid),
      verdict: report?.brief?.verdict ?? "unknown",
      unchangedSinceReview: latest?.target === current.fingerprint,
      requirementsCurrent:
        latest?.requirementsRevision === (work.revision ?? 1),
    });
  }
  if (complete) {
    if (results.some((result) => !result.reviewValid))
      throw new Error(
        "Completion blocked: each repository needs a settled independent PASS for its current state, including acceptance/verification evidence.",
      );
    work.status = "completed";
    work.completedAt = new Date().toISOString();
    await writeJSON(workFile(client.scope, id), work);
  }
  return {
    id,
    title: work.title,
    requirements: work.requirements,
    revision: work.revision ?? 1,
    status: work.status,
    repositories: results,
  };
}

export async function reviseWork(client, id, requirements) {
  if (
    typeof requirements !== "string" ||
    !requirements.trim() ||
    requirements.length > 8000
  )
    throw new Error("Revised requirements must contain 1–8000 characters.");
  const work = await getWork(client.scope, id);
  if (work.status === "completed")
    throw new Error("Create a new bundle for work after completion.");
  await ensureIdle(client, Object.keys(work.repos));
  if (requirements === work.requirements)
    return { id, revision: work.revision ?? 1, status: work.status };
  await writeJSON(
    path.join(
      directory(client.scope),
      `${id}.requirements-${work.revision ?? 1}.json`,
    ),
    {
      requirements: work.requirements,
      revision: work.revision ?? 1,
      supersededAt: new Date().toISOString(),
    },
  );
  work.requirements = requirements;
  work.revision = (work.revision ?? 1) + 1;
  work.status = "implementing";
  await writeJSON(workFile(client.scope, id), work);
  return {
    id,
    revision: work.revision,
    status: work.status,
    message:
      "Requirements updated; prior review verdicts are stale. Baseline and review budget preserved.",
  };
}
