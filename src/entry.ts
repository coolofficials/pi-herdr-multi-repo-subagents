import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { usesExplicitChildBridge } from "./entry.mjs";
import extension from "./index.ts";

export default async function packageEntry(pi: ExtensionAPI) {
  if (await usesExplicitChildBridge(process.argv.slice(2))) return;
  extension(pi);
}
