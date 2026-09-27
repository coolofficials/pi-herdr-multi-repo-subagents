import path from "node:path";
import { createHash } from "node:crypto";
import { readJSON, writeJSON } from "./storage.mjs";
export async function reviewProgress(
  scope,
  kind,
  value,
  targets,
  project,
  evidence = {},
) {
  // Version counters and job IDs alone are not semantic progress.
  const signature = createHash("sha256")
    .update(
      JSON.stringify({
        requirements: value.requirements,
        notes: value.notes ?? "",
        project: project.requirements,
        evidence,
        targets: Object.fromEntries(
          Object.entries(targets).map(([r, t]) => [r, t.target]),
        ),
      }),
    )
    .digest("hex");
  const file = path.join(scope, "progress", kind + "-" + value.id + ".json");
  const previous = await readJSON(file, { signature: null, repeats: 0 });
  const repeats = previous.signature === signature ? previous.repeats + 1 : 0;
  if (repeats >= 2)
    throw Error(
      "NO_PROGRESS: unchanged requirements and artifact candidate submitted repeatedly. Inspect findings/evidence or ask the user; new sessions do not reset this guard.",
    );
  await writeJSON(file, { signature, repeats, at: new Date().toISOString() });
}
