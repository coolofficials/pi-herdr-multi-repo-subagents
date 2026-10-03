import path from "node:path";
import { readJSON } from "./storage.mjs";

export async function inspectionProgress(
  request,
  dir,
  jobId,
  repo,
  offset = 0,
) {
  const review = request.contract?.review;
  if (!review?.targets) throw Error("No assigned review.");
  if (repo && !review.targets[repo])
    throw Error("Repository not in this review.");
  const evidence = await readJSON(
    path.join(dir, `${jobId}.inspection.json`),
    {},
  );
  const repositories = [];
  for (const [name, target] of Object.entries(review.targets)) {
    if (repo && repo !== name) continue;
    const base = await readJSON(target.baseline),
      current = await readJSON(target.snapshot);
    const changed = [
      ...new Set([
        ...Object.keys(base.entries),
        ...Object.keys(current.entries),
      ]),
    ]
      .filter(
        (f) =>
          base.entries[f]?.hash !== current.entries[f]?.hash ||
          base.entries[f]?.mode !== current.entries[f]?.mode,
      )
      .sort();
    const seen =
      evidence[name]?.target === target.target
        ? (evidence[name].files ?? {})
        : {};
    const remaining = changed
      .filter((f) => !seen[f]?.complete)
      .map((file) => ({
        file,
        nextOffset: seen[file]?.next ?? 0,
        unit: "characters",
        since: "baseline",
      }));
    const complete = changed.length - remaining.length;
    repositories.push({
      repo: name,
      target: target.target,
      changed: changed.length,
      complete,
      requirement:
        review.kind === "projects"
          ? "At least one complete integration-related changed file per changed repository, plus project acceptance evidence."
          : "Every changed file's contiguous baseline pages, plus acceptance evidence.",
      gateCoverageSatisfied:
        review.kind === "projects"
          ? !changed.length || complete > 0
          : !remaining.length,
      remaining: remaining.slice(offset, offset + 30),
      nextRemainingOffset: offset + 30 < remaining.length ? offset + 30 : null,
    });
  }
  return {
    repositories,
    note: "Coverage is a read receipt, not a verdict or proof of integration. previous_review pages do not cover the original baseline. Use returned nextOffset exactly; retained complete coverage survives unchanged file candidates.",
  };
}
