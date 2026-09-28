import path from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./core.mjs";
import {
  MODEL_ROLES,
  loadGlobalModelSettings,
  modelSettingsPath,
  resolveModelSettings,
  saveModelSettings,
  validateModelSelection,
  validateModelSettings,
} from "./model-settings.mjs";

const names: Record<string, string> = {
  task_lead: "Task Lead",
  implementer: "Implementer",
  reviewer: "Reviewer",
  oracle: "Oracle",
  scout: "Scout",
  researcher: "Researcher",
};

export async function editModelSettings(ctx: ExtensionContext) {
  if (!ctx.hasUI)
    throw Error(
      "Model settings require interactive UI. Edit pi-herdr.json or the profile's pi-herdr-models.json instead.",
    );
  const scope = await ctx.ui.select("Role models · save scope", [
    "User profile",
    "This task",
  ]);
  if (!scope) return;
  const global = await loadGlobalModelSettings();
  const task = await loadConfig(ctx.cwd);
  const profile = scope === "User profile";
  const file = profile
    ? modelSettingsPath()
    : path.join(ctx.cwd, "pi-herdr.json");
  const original = profile ? global : task;
  const draft: any = structuredClone(original);
  const parent = {
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    thinking: ctx.thinkingLevel,
  };
  const effective = (role: string) =>
    resolveModelSettings(
      role,
      profile ? {} : draft,
      profile ? draft : global,
      parent,
    );
  // Editing a profile previews that profile, even if this task currently overrides it.
  const describe = (role: string) => {
    const selected = effective(role);
    return `${selected.model ?? "No model"} [${selected.sources.model ?? "unset"}] · ${selected.thinking ?? "Pi default"} [${selected.sources.thinking ?? "unset"}]`;
  };
  for (;;) {
    const rows = [
      `Defaults · ${draft.model ?? "inherit"} · ${draft.thinking ?? "inherit"}`,
      ...MODEL_ROLES.map((role) => `${names[role]} · ${describe(role)}`),
      "Save",
      "Cancel",
    ];
    const picked = await ctx.ui.select(
      `${scope} · new child sessions only${profile ? " · task overrides may apply" : ""}`,
      rows,
    );
    if (!picked || picked === "Cancel") return;
    if (picked === "Save") {
      try {
        validateModelSettings(draft, profile);
        const currentGlobal = profile ? draft : await loadGlobalModelSettings();
        for (const role of MODEL_ROLES) {
          const selection = resolveModelSettings(
            role,
            profile ? {} : draft,
            currentGlobal,
            parent,
          );
          validateModelSelection(selection, ctx.modelRegistry);
        }
        await saveModelSettings(file, draft, original);
        ctx.ui.notify(
          `Saved ${file}. Running conversations and context checkpoints retain their models. New children and idle /new sessions use these settings.`,
          "info",
        );
        return;
      } catch (error) {
        ctx.ui.notify(String(error), "error");
        continue;
      }
    }
    const index = rows.indexOf(picked);
    const role = index === 0 ? undefined : MODEL_ROLES[index - 1];
    const existing = role ? (draft.roles?.[role] ?? {}) : draft;
    const field = await ctx.ui.select(role ? names[role] : "Defaults", [
      `Model · ${existing.model ?? "inherit"}`,
      `Thinking · ${existing.thinking ?? "inherit"}`,
      "Inherit both",
      "Back",
    ]);
    if (!field || field === "Back") continue;
    const pair: any = { ...existing };
    if (field === "Inherit both") {
      delete pair.model;
      delete pair.thinking;
    } else if (field.startsWith("Model")) {
      const choices = ctx.modelRegistry
        .getAvailable()
        .map((model) => `${model.provider}/${model.id}`)
        .sort();
      const model = await ctx.ui.select(
        "Model · registered and authenticated",
        ["Inherit", ...choices],
      );
      if (!model) continue;
      if (model === "Inherit") delete pair.model;
      else pair.model = model;
    } else {
      const selected = role
        ? effective(role)
        : resolveModelSettings(
            "",
            profile ? {} : draft,
            profile ? draft : global,
            parent,
          );
      const model = ctx.modelRegistry
        .getAvailable()
        .find((m) => `${m.provider}/${m.id}` === selected.model);
      if (!model) {
        ctx.ui.notify("Select an available model first.", "error");
        continue;
      }
      const thinking = await ctx.ui.select(`Thinking · ${selected.model}`, [
        "Inherit",
        ...getSupportedThinkingLevels(model),
      ]);
      if (!thinking) continue;
      if (thinking === "Inherit") delete pair.thinking;
      else pair.thinking = thinking;
    }
    if (role) {
      draft.roles ??= {};
      if (Object.keys(pair).length) draft.roles[role] = pair;
      else delete draft.roles[role];
      if (!Object.keys(draft.roles).length) delete draft.roles;
    } else {
      for (const key of ["model", "thinking"]) {
        if (pair[key] === undefined) delete draft[key];
        else draft[key] = pair[key];
      }
    }
  }
}
