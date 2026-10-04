import { isProgress, requireProgress } from "./documents.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readJSON, writeJSON } from "./storage.mjs";
import { scopedPath } from "./access.mjs";
import { snapshot, reviewTargetMatches } from "./workflow.mjs";

const digest = (data) => createHash("sha256").update(data).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const signature = (entry) =>
  entry ? { hash: entry.hash, mode: entry.mode } : null;
export async function fileState(root, file) {
  try {
    const target = await scopedPath(root, file),
      stat = await fs.lstat(target);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024)
      throw new Error(
        "Approval dependency must be a regular file up to 2 MiB.",
      );
    const data = await fs.readFile(target),
      after = await fs.lstat(target);
    if (
      stat.ino !== after.ino ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.size !== after.size
    )
      throw new Error("Dependency changed while reading.");
    return { hash: digest(data), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
const scopeFile = (dir, job) => path.join(dir, `${job}.scope.json`);
async function getScope(request, dir, job) {
  if (request?.role !== "reviewer" || !request.contract?.review)
    throw new Error("Task approval scope belongs to an assigned Reviewer.");
  const review = request.contract.review;
  const existing = await readJSON(scopeFile(dir, job));
  if (existing) return existing;
  const scope = {
    root: request.contract.root,
    project: review.projectBinding,
    files: Object.create(null),
    repositories: Object.create(null),
    pending: [],
  };
  for (const instruction of request.contract.instructions ?? [])
    scope.files[instruction.file] = instruction.signature;
  const previous = request.contract.previousReview?.scope;
  if (previous) {
    for (const [file, value] of Object.entries(previous.files)) {
      scope.files[file] = value;
      if (!same(await fileState(scope.root, file), value))
        scope.pending.push(file);
    }
    for (const repo of Object.keys(previous.repositories)) {
      const target = review.targets[repo];
      if (target)
        scope.repositories[repo] = {
          path: target.path,
          fingerprint: target.target,
        };
    }
  }
  return scope;
}
export async function addReviewDependencies(
  request,
  dir,
  job,
  {
    files = /** @type {string[]} */ ([]),
    wholeRepositories = /** @type {string[]} */ ([]),
  },
) {
  const scope = await getScope(request, dir, job);
  if (files.length > 1000 || wholeRepositories.length > 12)
    throw new Error(
      "Narrow dependency registration to <=1000 files and <=12 repositories per call.",
    );
  for (const file of files) {
    const target = await scopedPath(scope.root, file, true),
      relative = path.relative(scope.root, target).split(path.sep).join("/");
    if (await isProgress(request.contract.review.workScope, relative)) continue;
    const value = await fileState(scope.root, relative);
    if (
      Object.hasOwn(scope.files, relative) &&
      !scope.pending?.includes(relative) &&
      !same(scope.files[relative], value)
    )
      throw new Error(
        "A previously inspected dependency changed. Request a new review.",
      );
    scope.pending = (scope.pending ?? []).filter((file) => file !== relative);
    Object.defineProperty(scope.files, relative, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const repo of wholeRepositories) {
    const target = request.contract.review.targets[repo];
    if (!target)
      throw new Error(
        "Whole-repository approval scope must be an assigned repository.",
      );
    scope.repositories[repo] = {
      path: target.path,
      fingerprint: target.target,
    };
  }
  await writeJSON(scopeFile(dir, job), scope);
  return {
    files: Object.keys(scope.files).length,
    wholeRepositories: Object.keys(scope.repositories),
    message:
      "Changed files are always included. Declare configuration, dynamic discovery and other unobserved dependencies explicitly; use whole-repository scope when uncertain.",
  };
}
export async function noteSourceAccess(
  request,
  dir,
  job,
  base,
  params,
  result,
) {
  if (request?.role !== "reviewer") return;
  const files =
    params.action === "read"
      ? [params.file]
      : params.action === "search"
        ? (result.matches ?? []).map((m) => m.file)
        : [];
  const relative = files
    .filter(Boolean)
    .map((file) =>
      path
        .relative(request.contract.root, path.resolve(base, file))
        .split(path.sep)
        .join("/"),
    );
  if (relative.length)
    await addReviewDependencies(request, dir, job, {
      files: [...new Set(relative)],
    });
}
export async function taskApprovalScope(request, dir, job) {
  const scope = await getScope(request, dir, job);
  if (scope.pending?.length)
    throw new Error(
      "Previously reviewed dependencies changed. Inspect or explicitly re-evaluate them with repo_review_scope: " +
        scope.pending.slice(0, 10).join(", "),
    );
  for (const target of Object.values(request.contract.review.targets)) {
    const base = await readJSON(target.baseline),
      current = await readJSON(target.snapshot);
    for (const file of new Set([
      ...Object.keys(base.entries),
      ...Object.keys(current.entries),
    ])) {
      if (same(signature(base.entries[file]), signature(current.entries[file])))
        continue;
      const relative = path
        .relative(scope.root, path.join(target.path, file))
        .split(path.sep)
        .join("/");
      Object.defineProperty(scope.files, relative, {
        value: signature(current.entries[file]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  // Normalize a legacy whole-repository digest only after byte-for-byte proof
  // against that review's retained target, preserving its original provenance.
  for (const [repo, dependency] of Object.entries(scope.repositories)) {
    const target = request.contract.review.targets[repo];
    if (
      target &&
      dependency.path === target.path &&
      dependency.fingerprint === target.target &&
      (await reviewTargetMatches(target))
    ) {
      const current = await snapshot(target.path);
      if (current.fingerprint !== dependency.fingerprint) {
        dependency.legacyFingerprint = dependency.fingerprint;
        dependency.fingerprint = current.fingerprint;
      }
    }
  }
  if (!(await approvalScopeValid(scope)))
    throw new Error(
      "Approval dependencies or project contracts changed during review.",
    );
  await writeJSON(scopeFile(dir, job), scope);
  return scope;
}
export async function approvalScopeValid(scope) {
  if (!scope?.root || !scope.project) return false;
  try {
    await requireProgress(scope.root, scope.project.scope);
  } catch {
    return false;
  }
  const project = await readJSON(
    path.join(scope.project.scope, "projects", `${scope.project.id}.json`),
  );
  if (project?.revision !== scope.project.revision) return false;
  for (const [file, expected] of Object.entries(scope.files))
    if (!same(await fileState(scope.root, file), expected)) return false;
  for (const repo of Object.values(scope.repositories))
    if ((await snapshot(repo.path)).fingerprint !== repo.fingerprint)
      return false;
  return true;
}

export async function approvalScopeStatus(scope) {
  if (!scope)
    return {
      valid: false,
      reason: "missing_scope",
      nextAction: "request_review",
    };
  const project = await readJSON(
    path.join(scope.project.scope, "projects", scope.project.id + ".json"),
  );
  if (project?.revision !== scope.project.revision)
    return {
      valid: false,
      reason: "project_contract_changed",
      nextAction: "review_changed_scope",
    };
  try {
    await requireProgress(scope.root, scope.project.scope);
  } catch {
    return {
      valid: false,
      reason: "progress_input_pending",
      nextAction: "reconcile_progress",
    };
  }
  const changed = [];
  for (const [file, expected] of Object.entries(scope.files))
    if (!same(await fileState(scope.root, file), expected)) changed.push(file);
  for (const [repo, expected] of Object.entries(scope.repositories))
    if ((await snapshot(expected.path)).fingerprint !== expected.fingerprint)
      changed.push(repo);
  return changed.length
    ? {
        valid: false,
        reason: "dependency_changed",
        changed,
        nextAction: "review_changed_scope",
        preserved: ["execution-records", "unaffected-review-coverage"],
      }
    : { valid: true };
}
