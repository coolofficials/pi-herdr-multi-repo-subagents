import path from "node:path";
import os from "node:os";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { readJSON, writeJSON } from "./storage.mjs";
import { withOperationLock } from "./coordination-lock.mjs";

export const MODEL_ROLES = [
  "task_lead",
  "implementer",
  "reviewer",
  "oracle",
  "scout",
  "researcher",
];
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function modelSettingsPath(env = process.env) {
  let base = env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  if (base === "~" || base.startsWith("~/"))
    base = path.join(os.homedir(), base.slice(2));
  return path.resolve(base, "pi-herdr-models.json");
}

function validatePair(value, label) {
  if (!object(value)) throw Error(`${label} must be an object.`);
  if (
    value.model !== undefined &&
    (typeof value.model !== "string" || !/^[^/\s]+\/\S+$/.test(value.model))
  )
    throw Error(`${label}.model must use the exact provider/model ID.`);
  if (value.thinking !== undefined && !THINKING_LEVELS.includes(value.thinking))
    throw Error(`${label}.thinking is not a supported thinking level.`);
}

export function validateModelSettings(config, global = false) {
  if (!object(config)) throw Error("Model settings must be an object.");
  if (global)
    for (const key of Object.keys(config))
      if (!["model", "thinking", "roles"].includes(key))
        throw Error(`Unknown global model setting: ${key}`);
  // Preserve legacy task-level model syntax; new role settings use exact IDs.
  if (global) validatePair(config, "Global settings");
  if (config.roles !== undefined) {
    if (!object(config.roles)) throw Error("roles must be an object.");
    for (const [role, settings] of Object.entries(config.roles)) {
      if (!MODEL_ROLES.includes(role))
        throw Error(`Unknown model role: ${role}`);
      validatePair(settings, `roles.${role}`);
      for (const key of Object.keys(settings))
        if (!["model", "thinking"].includes(key))
          throw Error(`Unknown roles.${role} setting: ${key}`);
    }
  }
  return config;
}

export async function loadGlobalModelSettings(file = modelSettingsPath()) {
  return validateModelSettings(await readJSON(file, {}), true);
}

// Resolve each field independently. A task default intentionally overrides global roles.
export function resolveModelSettings(
  role,
  task = {},
  global = {},
  parent = {},
) {
  const layers = [
    [task.roles?.[role], "task role"],
    [task, "task default"],
    [global.roles?.[role], "global role"],
    [global, "global default"],
    [parent, "parent"],
  ];
  /** @type {{model?: string, thinking?: string, sources: Record<string, string>}} */
  const result = { model: undefined, thinking: undefined, sources: {} };
  for (const key of ["model", "thinking"])
    for (const [settings, source] of layers)
      if (settings?.[key] !== undefined) {
        result[key] = settings[key];
        result.sources[key] = source;
        break;
      }
  return result;
}

export function validateModelSelection(selection, registry) {
  if (!selection.model)
    throw Error(
      "No model selected. Select a main Pi model or configure a role model.",
    );
  const model = registry
    .getAvailable()
    .find((m) => `${m.provider}/${m.id}` === selection.model);
  if (!model)
    throw Error(
      `Model is unavailable or not authenticated: ${selection.model}. No substitute will be used.`,
    );
  if (
    selection.thinking !== undefined &&
    !getSupportedThinkingLevels(model).includes(selection.thinking)
  )
    throw Error(
      `${selection.model} does not support thinking=${selection.thinking}. Choose ${getSupportedThinkingLevels(model).join(", ")} explicitly for this role.`,
    );
  return model;
}

export async function saveModelSettings(file, draft, expected) {
  // Serialize editors and reject stale drafts rather than overwriting another user's save.
  await withOperationLock(
    `${file}.lock`,
    async () => {
      const current = await readJSON(file, {});
      if (JSON.stringify(current) !== JSON.stringify(expected))
        throw Error(
          "Settings changed while this menu was open. Reopen the menu before saving.",
        );
      await writeJSON(file, draft);
    },
    { timeoutMs: 1000 },
  );
}
