import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readJSON, writeJSON } from "./storage.mjs";
import { scopedPath } from "./access.mjs";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const key = (file) =>
  typeof file === "string"
    ? file
        .split(/[\\/]/)
        .filter((p) => p && p !== ".")
        .join("/")
    : file;
const statePath = (scope) => path.join(scope, "documents.json");
async function content(root, file) {
  const target = await scopedPath(root, file, true);
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 131072)
      throw Error("Progress document must be a regular file up to 128 KiB.");
    return await fs.readFile(target, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return "";
    throw e;
  }
}
export async function registerProgress(root, scope, project, files = []) {
  root = await fs.realpath(root);
  if (
    !Array.isArray(files) ||
    files.some((f) => typeof f !== "string") ||
    files.length > 30
  )
    throw Error("At most 30 progress documents.");
  const state = await readJSON(statePath(scope), {});
  for (const input of files) {
    const file = key(input);
    if (
      !/\.(md|txt)$/.test(file) ||
      /^(agents|claude|gemini)\.md$/i.test(path.basename(file))
    )
      throw Error("Instruction files cannot be progress documents.");
    const target = await scopedPath(root, file, true);
    let parent = path.dirname(target);
    while (parent !== root) {
      if (
        (await fs.lstat(path.join(parent, ".git")).catch(() => null)) ||
        (await fs.lstat(path.join(parent, ".jj")).catch(() => null))
      )
        throw Error("Repository documents cannot be progress-only.");
      parent = path.dirname(parent);
    }
    if (state[file]) {
      state[file].projects = [
        ...new Set([
          ...(state[file].projects ?? [state[file].project]),
          project,
        ]),
      ];
      continue; // Registering another project must not acknowledge external edits.
    }
    state[file] = {
      project,
      projects: [project],
      hash: hash(await content(root, file)),
      revision: 1,
      pending: false,
    };
  }
  await writeJSON(statePath(scope), state);
}
export async function progressState(root, scope) {
  const state = await readJSON(statePath(scope), {});
  const pending = [];
  for (const [file, record] of Object.entries(state))
    if (hash(await content(root, file)) !== record.hash) pending.push(file);
  return { state, pending };
}
export async function requireProgress(root, scope) {
  const { pending } = await progressState(root, scope);
  if (pending.length)
    throw Error(
      "PROGRESS_INPUT_PENDING: classify external edits before completion: " +
        pending.join(", "),
    );
}
export async function isProgress(scope, file) {
  if (!scope) return false;
  return Boolean((await readJSON(statePath(scope), {}))[key(file)]);
}
export async function recordProgressWrite(root, scope, file) {
  file = key(file);
  const state = await readJSON(statePath(scope), {});
  if (!state[file]) return;
  state[file].hash = hash(await content(root, file));
  state[file].revision++;
  await writeJSON(statePath(scope), state);
}
export async function acknowledgeProgress(root, scope, file, reason) {
  if (!reason?.trim() || reason.length > 1200)
    throw Error(
      "Explain why this edit changes progress only, or cite the explicitly revised requirements.",
    );
  if (!(await isProgress(scope, file)))
    throw Error("Not a declared progress document.");
  await recordProgressWrite(root, scope, file);
  await writeJSON(
    path.join(scope, "document-receipts", `${randomUUID()}.json`),
    { file, reason, at: new Date().toISOString() },
  );
  return { file, status: "reconciled", reason };
}
