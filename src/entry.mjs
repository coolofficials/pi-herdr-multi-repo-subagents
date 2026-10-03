import fs from "node:fs/promises";
import path from "node:path";

// Explicit launches pin their bridge. Global package discovery must
// not register a second bridge after the profile is upgraded mid-family.
export async function usesExplicitBridge(argv) {
  for (let i = 0; i < argv.length - 1; i++) {
    if (!["--extension", "-e"].includes(argv[i])) continue;
    const file = argv[i + 1];
    if (!path.isAbsolute(file) || path.basename(file) !== "index.ts") continue;
    try {
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(path.dirname(file), "..", "package.json"),
          "utf8",
        ),
      );
      if (manifest.name === "pi-herdr-multi-repo-subagents") return true;
    } catch {
      /* Unrelated explicit extensions do not suppress this package. */
    }
  }
  return false;
}
