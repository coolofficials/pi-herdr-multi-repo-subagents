import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export async function readJSON(file, fallback = /** @type {any} */ (null)) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
export async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temp, file);
}

// Serialize a session's read-modify-write evidence updates even when Pi executes tools in parallel.
export function serialExecutor() {
  let tail = Promise.resolve();
  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  return function run(operation) {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
