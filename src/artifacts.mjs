import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJSON, writeJSON } from "./storage.mjs";
export async function retainOutput(
  dir,
  jobId,
  tool,
  content,
  { isError = false, limit = 8192 } = {},
) {
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (text.length <= limit) return null;
  const id = randomUUID();
  const file = path.join(dir, "artifacts", id + ".json");
  await writeJSON(file, {
    id,
    jobId,
    tool,
    isError,
    text,
    chars: text.length,
    complete: false,
    completenessNote:
      "Captured tool result; original tool may already have truncated output. Use repo_check for explicit log completeness.",
    createdAt: new Date().toISOString(),
  });
  const half = Math.floor((limit - 600) / 2);
  const preview = `${text.slice(0, half)}\n\n[Output excerpt: ${text.length} characters. Use repo_artifact with id=${id}, offset/limit or query to inspect retained output. Omitted text is not proof of success.]\n\n${text.slice(-half)}`;
  return {
    content: [
      { type: "text", text: preview },
      ...content.filter((c) => c.type !== "text"),
    ],
    details: {
      artifact: id,
      jobId,
      tool,
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
    if (found < 0) return { id, found: false };
    offset = Math.max(0, found - 500);
  }
  return {
    id,
    tool: value.tool,
    jobId: value.jobId,
    command: value.command,
    cwd: value.cwd,
    exitCode: value.exitCode,
    createdAt: value.createdAt,
    hash: value.hash,
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

export async function evidenceDirectory(launch, request, ownDir, agent) {
  if (!agent || agent === launch.agentId) return ownDir;
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
  for (const id of ids) {
    const work = await readJSON(path.join(scope, "work", id + ".json"));
    const member = work?.members?.find((m) => m.id === agent);
    if (member) return member.dir;
  }
  throw Error("Evidence owner is outside assigned review tasks.");
}
