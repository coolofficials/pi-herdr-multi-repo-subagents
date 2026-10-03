import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJSON, writeJSON } from "./storage.mjs";
export async function retainOutput(
  dir,
  jobId,
  tool,
  content,
  {
    isError = false,
    limit = 8192,
    always = false,
    provenance = /** @type {any} */ (undefined),
  } = {},
) {
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (text.length <= limit && !always) return null;
  const id = randomUUID();
  const file = path.join(dir, "artifacts", id + ".json");
  await writeJSON(file, {
    id,
    jobId,
    tool,
    provenance,
    isError,
    text,
    chars: text.length,
    complete: false,
    completenessNote:
      "Captured tool result; original tool may already have truncated output. Use repo_check for explicit log completeness.",
    createdAt: new Date().toISOString(),
  });
  const half = Math.floor((limit - 600) / 2);
  const preview =
    text.length <= limit
      ? `${text}\n[Retained web output: use artifact=${id} to register a durable reference; upstream completeness is unknown.]`
      : `${text.slice(0, half)}\n\n[Output excerpt: ${text.length} characters. Use repo_artifact with id=${id}, offset/limit or query to inspect retained output. Omitted text is not proof of success.]\n\n${text.slice(-half)}`;
  return {
    content: [
      { type: "text", text: preview },
      ...content.filter((c) => c.type !== "text"),
    ],
    details: {
      artifact: id,
      jobId,
      tool,
      provenance,
      isError,
      chars: text.length,
      excerpt: true,
    },
  };
}
export async function readArtifact(
  dir,
  id,
  { offset = 0, limit = 8000, query } = {},
) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid artifact ID.");
  const value = await readJSON(path.join(dir, "artifacts", id + ".json"));
  if (!value) throw Error("Artifact is outside this agent ownership scope.");
  return artifactPage(value, id, { offset, limit, query });
}

function artifactPage(value, id, { offset = 0, limit = 8000, query } = {}) {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 16000
  )
    throw Error("Use offset>=0 and limit 1–16000.");
  if (query) {
    if (query.length > 200) throw Error("Narrow the search.");
    const found = value.text.indexOf(query, offset);
    if (found < 0)
      return {
        id,
        jobId: value.jobId,
        provenance: value.provenance,
        found: false,
      };
    offset = Math.max(0, found - 500);
  }
  return {
    id,
    tool: value.tool,
    jobId: value.jobId,
    provenance: value.provenance,
    command: value.command,
    cwd: value.cwd,
    exitCode: value.exitCode,
    createdAt: value.createdAt,
    hash: value.hash,
    file: value.file,
    isError: value.isError,
    complete: value.complete,
    chars: value.chars,
    offset,
    text: value.text.slice(offset, offset + limit),
    nextOffset: offset + limit < value.text.length ? offset + limit : null,
  };
}
export async function recordUsage(dir, message, contextWindow = 272000) {
  if (message.role !== "assistant" || !message.usage) return;
  const u = message.usage,
    input = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  const value = {
    input,
    cacheRead: u.cacheRead ?? 0,
    warning: input >= Math.min(48000, contextWindow * 0.25),
    rotateSuggested: input >= Math.min(64000, contextWindow * 0.35),
    at: new Date().toISOString(),
  };
  await writeJSON(path.join(dir, "context-pressure.json"), value);
  return value;
}

export function evidenceProvenance(launch, request) {
  return {
    agent: launch.agentId,
    task: request?.bundle ?? null,
    workScope: request?.contract?.workScope ?? null,
    cwd: launch.cwd,
    // A log hash identifies output, not the source version that produced it.
    sourceVersion: null,
  };
}

async function reviewEvidenceOwners(request) {
  if (
    !["reviewer", "oracle"].includes(request?.role) ||
    !request.contract?.review
  )
    throw Error(
      "Cross-agent raw evidence is restricted to assigned independent reviews.",
    );
  const review = request.contract.review,
    scope = review.workScope;
  const ids =
    review.kind === "projects"
      ? (review.taskApprovals ?? []).map((t) => t.id)
      : [review.id];
  const owners = [];
  for (const id of new Set(ids)) {
    const work = await readJSON(path.join(scope, "work", id + ".json"));
    for (const member of work?.members ?? [])
      owners.push({
        agent: member.id,
        dir: member.dir,
        task: id,
        workScope: scope,
        repo: member.repo,
      });
  }
  return owners;
}

export async function evidenceDirectory(launch, request, ownDir, agent) {
  if (!agent || agent === launch.agentId) return ownDir;
  const member = (await reviewEvidenceOwners(request)).find(
    (owner) => owner.agent === agent,
  );
  if (member) return member.dir;
  throw Error("Evidence owner is outside assigned review tasks.");
}

export async function readScopedArtifact(launch, request, ownDir, params) {
  const { id, agent } = params;
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid artifact ID.");
  const own = { agent: launch.agentId, dir: ownDir };
  const review =
    ["reviewer", "oracle"].includes(request?.role) && request.contract?.review;
  // Resolve only registered members of the assigned review, never other runs.
  let owners = [own];
  if (review && agent !== launch.agentId)
    owners.push(...(await reviewEvidenceOwners(request)));
  if (agent) {
    owners = owners.filter((owner) => owner.agent === agent);
    if (!owners.length)
      throw Error("Evidence owner is outside assigned review tasks.");
  }
  const matches = new Map();
  for (const owner of owners) {
    const value = await readJSON(
      path.join(owner.dir, "artifacts", id + ".json"),
    );
    if (!value) continue;
    const provenance = value.provenance;
    if (
      provenance &&
      (provenance.agent !== owner.agent ||
        (owner.task &&
          (provenance.task !== owner.task ||
            provenance.workScope !== owner.workScope)))
    )
      throw Error(
        "Artifact provenance does not match its assigned owner/task.",
      );
    const key = path.resolve(owner.dir);
    const prior = matches.get(key);
    if (!prior || owner.task) matches.set(key, { ...owner, value });
  }
  if (!matches.size)
    throw Error(
      "Artifact was not found within this agent or its assigned review tasks.",
    );
  if (matches.size > 1)
    return {
      id,
      status: "ambiguous",
      candidateCount: matches.size,
      candidates: [...matches.values()]
        .slice(0, 20)
        .map(({ agent, task, repo }) => ({ agent, task, repo })),
      instruction:
        "Retry with the source agent ID from the evidence report. No log was selected.",
    };
  const owner = [...matches.values()][0];
  return {
    ...artifactPage(owner.value, id, params),
    agent: owner.agent,
    task: owner.task ?? request?.bundle ?? null,
    repo: owner.repo,
    sourceVersion: null,
    evidenceNote:
      "Source version was not recorded. The job ID and timestamps identify this execution; the log hash is not a code fingerprint. Do not infer that this check verifies the current review target or reuse it automatically.",
  };
}
