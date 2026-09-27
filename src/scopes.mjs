import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { scopedPath } from "./access.mjs";

export function assignedRepos(request, launch) {
  if (request?.contract?.review)
    return Object.keys(request.contract.review.targets);
  if (request?.contract?.repos) return request.contract.repos;
  return launch.cwd !== launch.root
    ? [path.relative(launch.root, launch.cwd)]
    : [];
}
export async function scopedSourceBase(request, launch, params) {
  const base = params.scope === "task" ? launch.root : launch.cwd;
  if (base !== launch.root) return { base };
  const repos = assignedRepos(request, launch);
  // Unbundled research is explicitly assigned discovery across the root.
  if (!request?.bundle) return { base };
  const relative = path.relative(
    launch.root,
    await scopedPath(launch.root, params.file ?? ".", true),
  );
  if (
    repos.some(
      (repo) => relative === repo || relative.startsWith(repo + path.sep),
    )
  )
    return { base };
  // Metadata reads are allowed only outside repository trees and cannot walk other repos.
  if (params.action === "read" && /\.(md|txt)$/.test(relative)) {
    let current = path.dirname(path.join(base, relative));
    while (current !== base) {
      if (
        (await fs.lstat(path.join(current, ".git")).catch(() => null)) ||
        (await fs.lstat(path.join(current, ".jj")).catch(() => null))
      )
        throw Error("Source is outside assigned repositories.");
      current = path.dirname(current);
    }
    return { base };
  }
  if (relative === "" && params.action === "list") return { roster: repos };
  throw Error("Narrow file to one assigned repository: " + repos.join(", "));
}
export async function scopedInstructions(root, repos = []) {
  const paths = new Set(["AGENTS.md"]);
  for (const repo of repos) {
    const parts = repo.split(/[\\/]/);
    for (let i = 1; i <= parts.length; i++)
      paths.add(path.join(...parts.slice(0, i), "AGENTS.md"));
  }
  let chars = 0;
  const instructions = [];
  for (const file of paths) {
    const target = await scopedPath(root, file, true);
    const stat = await fs.lstat(target).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!stat) {
      instructions.push({ file, text: "(file absent)", signature: null });
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 24000)
      throw Error(
        "Scoped instruction file must be a regular file within 24000 bytes: " +
          file,
      );
    const text = await fs.readFile(target, "utf8");
    chars += text.length;
    if (chars > 24000)
      throw Error(
        "Scoped instructions exceed 24000 characters. Narrow task repositories.",
      );
    instructions.push({
      file,
      text,
      signature: {
        hash: createHash("sha256").update(text).digest("hex"),
        mode: stat.mode & 0o777,
      },
    });
  }
  return instructions;
}
