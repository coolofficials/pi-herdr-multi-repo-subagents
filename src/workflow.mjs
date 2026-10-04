import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readJSON } from "./storage.mjs";
import { sourceFiles, scopedPath } from "./access.mjs";

const exec = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
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
// A legacy snapshot may encode a different fingerprint scheme. The unchanged
// candidate can still be proven by the complete file set, byte hashes and modes.
export async function reviewTargetMatches(target) {
  const current = await snapshot(target.path);
  if (current.fingerprint === target.target) return true;
  const retained = await readJSON(target.snapshot);
  if (retained?.fingerprint !== target.target || !retained.entries)
    return false;
  if (
    retained.schema !== 2 ||
    digest(
      JSON.stringify(
        Object.keys(retained.entries)
          .sort()
          .map((file) => {
            const e = retained.entries[file];
            return [file, e.hash, e.mode, e.size, e.kind, e.content];
          }),
      ),
    ) !== retained.fingerprint
  )
    return false;
  const actual = Object.keys(current.entries).sort(),
    expected = Object.keys(retained.entries).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  return expected.every((file) => {
    const entry = retained.entries[file],
      observed = current.entries[file];
    return (
      (!entry.kind || entry.kind === "file") &&
      (!entry.content || entry.content === "inline") &&
      typeof entry.data === "string" &&
      digest(Buffer.from(entry.data, "base64")) === entry.hash &&
      entry.hash === observed.hash &&
      entry.mode === observed.mode
    );
  });
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
  if (
    current.fingerprint !== request.contract.review.target &&
    !(await reviewTargetMatches({
      path: repoPath,
      target: request.contract.review.target,
      snapshot: request.contract.review.snapshot,
    }))
  )
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
      fingerprint: request.contract.review.target,
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
    fingerprint: request.contract.review.target,
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
