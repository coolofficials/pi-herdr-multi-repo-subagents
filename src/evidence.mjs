import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { scopedPath } from "./access.mjs";
import { assignedRepos } from "./scopes.mjs";
import { evidenceProvenance, readScopedArtifact } from "./artifacts.mjs";
import { writeJSON } from "./storage.mjs";

export async function registerEvidence(launch, request, dir, file) {
  if (!["implementer", "scout", "researcher"].includes(request.role))
    throw Error(
      "Only assigned execution/research roles register evidence. Reviewers read registered IDs.",
    );
  const target = await scopedPath(launch.root, file);
  const relative = path.relative(launch.root, target);
  const inAssigned = assignedRepos(request, launch).some((r) =>
    relative.startsWith(r + path.sep),
  );
  if (!inAssigned) {
    if (!relative.startsWith("references" + path.sep))
      throw Error(
        "Evidence must be in assigned repositories or task references/.",
      );
    let parent = path.dirname(target);
    while (parent !== launch.root) {
      if (
        (await fs.lstat(path.join(parent, ".git")).catch(() => null)) ||
        (await fs.lstat(path.join(parent, ".jj")).catch(() => null))
      )
        throw Error("Evidence is in an unassigned repository.");
      parent = path.dirname(parent);
    }
  }
  if (!/\.(json|log|sha256|md|txt|csv)$/i.test(file))
    throw Error(
      "Register a text verification file: json/log/sha256/md/txt/csv.",
    );
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024)
    throw Error("Evidence requires a regular singly linked file up to 2 MiB.");
  const data = await fs.readFile(target);
  if (data.includes(0)) throw Error("Binary evidence is not supported.");
  const after = await fs.lstat(target);
  if (
    after.ino !== stat.ino ||
    after.size !== stat.size ||
    after.mtimeMs !== stat.mtimeMs
  )
    throw Error("Evidence changed during registration.");
  const id = randomUUID(),
    hash = createHash("sha256").update(data).digest("hex"),
    text = data.toString("utf8");
  const provenance = evidenceProvenance(launch, request);
  // Store exact captured bytes; completeness applies to the file, not its upstream command.
  await writeJSON(path.join(dir, "artifacts", id + ".json"), {
    id,
    jobId: request.jobId,
    tool: "repo_evidence",
    provenance,
    file,
    hash,
    text,
    chars: text.length,
    complete: true,
    createdAt: new Date().toISOString(),
  });
  return {
    id,
    agent: launch.agentId,
    file,
    hash,
    chars: text.length,
    sourceVersion: null,
    instruction:
      "Report this ID to the manager/reviewer. This is a captured file, not proof its producer verified the current code.",
  };
}

export async function verificationEvidence(launch, request, dir, params) {
  if (params.action === "register")
    return registerEvidence(launch, request, dir, params.file);
  if (params.action !== "read" || !params.id)
    throw Error("Use register with file, or read with id.");
  return readScopedArtifact(launch, request, dir, params);
}
