import type {
  ModelCapabilities,
  ModelSelection,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly continuationGroupKey: string | null;
  readonly isDefault: boolean;
  readonly isLegacy: boolean;
  readonly isUnavailable?: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly selection: ModelSelection;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly continuationGroupKey: string | null;
  readonly models: ReadonlyArray<ModelOption>;
};

function providerDisplayLabel(provider: {
  readonly displayName?: string | undefined;
  readonly driver: string;
  readonly instanceId: string;
}): string {
  if (provider.displayName) return provider.displayName;
  if (provider.driver === "codex") return "Codex";
  if (provider.driver === "claudeAgent") return "Claude";
  return provider.instanceId;
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!capabilities) {
    return selection;
  }
  const options = buildExplicitProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
    selection.options,
  );
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

/** Whether a known Antigravity selection needs setup or a different model. */
export function isModelSelectionUnavailable(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
): boolean {
  if (!config || !selection) {
    return false;
  }
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  const driver =
    provider?.driver ?? config.settings?.providerInstances[selection.instanceId]?.driver;
  return (
    driver === "antigravity" &&
    (!provider ||
      !provider.enabled ||
      !provider.installed ||
      provider.auth.status === "unauthenticated" ||
      provider.availability === "unavailable" ||
      !provider.models.some((model) => model.slug === selection.model))
  );
}

/**
 * Keep Antigravity selections when setup or catalog changes make them
 * unavailable. Other providers fall through to the server default when they
 * are disabled, missing, or signed out. Without config, keep stored selections.
 */
export function resolveSelectableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  if (!selection || !config) {
    return selection;
  }
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  const driver =
    provider?.driver ?? config.settings?.providerInstances[selection.instanceId]?.driver;
  if (driver === "antigravity") {
    return selection;
  }
  return provider &&
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated"
    ? selection
    : null;
}

/**
 * Reject legacy models for implicit defaults, except Antigravity selections,
 * which must not silently change after a catalog update. Explicit picks in
 * the settings sheet are unaffected.
 */
export function resolveDefaultableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  const usable = resolveSelectableModelSelection(config, selection);
  if (!usable || !config) {
    return usable;
  }
  const provider = config.providers.find((candidate) => candidate.instanceId === usable.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === usable.model);
  return provider?.driver !== "antigravity" && model?.isLegacy === true ? null : usable;
}

export function resolveNewTaskModelSelection(input: {
  readonly draftSelection: ModelSelection | null;
  readonly projectDefaultSelection: ModelSelection | null;
  readonly stickySelection: ModelSelection | null;
  readonly modelOptions: ReadonlyArray<ModelOption>;
}): ModelSelection | null {
  return (
    input.draftSelection ??
    input.projectDefaultSelection ??
    input.stickySelection ??
    input.modelOptions.find((option) => option.isDefault && !option.isUnavailable)?.selection ??
    input.modelOptions.find((option) => !option.isUnavailable)?.selection ??
    null
  );
}

export function buildModelOptions(
  config: T3ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();

  for (const provider of config?.providers ?? []) {
    if (
      !provider.enabled ||
      !provider.installed ||
      provider.auth.status === "unauthenticated" ||
      (provider.driver === "antigravity" && provider.availability === "unavailable")
    ) {
      continue;
    }

    const providerLabel = providerDisplayLabel(provider);
    for (const model of provider.models) {
      const key = `${provider.instanceId}:${model.slug}`;
      options.set(key, {
        key,
        label: model.name,
        subtitle: model.subProvider ?? "",
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        continuationGroupKey: provider.continuation?.groupKey ?? null,
        isDefault: model.isDefault === true,
        isLegacy: model.isLegacy === true,
        capabilities: model.capabilities,
        selection: normalizeSelectionOptions(
          {
            instanceId: provider.instanceId,
            model: model.slug,
          },
          model.capabilities,
        ),
      });
    }
  }

  if (fallbackModelSelection) {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
    const existing = options.get(key);
    if (existing) {
      options.set(key, {
        ...existing,
        selection:
          existing.providerDriver === "antigravity"
            ? fallbackModelSelection
            : normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      });
    } else {
      const provider = config?.providers.find(
        (candidate) => candidate.instanceId === fallbackModelSelection.instanceId,
      );
      const instanceConfig = config?.settings?.providerInstances[fallbackModelSelection.instanceId];
      const model = provider?.models.find(
        (candidate) => candidate.slug === fallbackModelSelection.model,
      );
      const providerDriver =
        provider?.driver ?? instanceConfig?.driver ?? fallbackModelSelection.instanceId;
      const providerLabel = providerDisplayLabel({
        driver: providerDriver,
        displayName: provider?.displayName ?? instanceConfig?.displayName,
        instanceId: fallbackModelSelection.instanceId,
      });
      options.set(key, {
        key,
        label: model?.name ?? fallbackModelSelection.model,
        subtitle: model?.subProvider ?? "",
        providerKey: fallbackModelSelection.instanceId,
        providerLabel,
        providerDriver,
        continuationGroupKey: provider?.continuation?.groupKey ?? null,
        isDefault: false,
        isLegacy: model?.isLegacy === true,
        ...(isModelSelectionUnavailable(config, fallbackModelSelection)
          ? { isUnavailable: true }
          : {}),
        capabilities: model?.capabilities ?? null,
        selection: fallbackModelSelection,
      });
    }
  }

  return [...options.values()];
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<
    string,
    {
      providerLabel: string;
      providerDriver: string;
      continuationGroupKey: string | null;
      models: ModelOption[];
    }
  >();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        providerDriver: option.providerDriver,
        continuationGroupKey: option.continuationGroupKey,
        models: [option],
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    providerDriver: group.providerDriver,
    continuationGroupKey: group.continuationGroupKey,
    models: group.models,
  }));
}

/**
 * Filter a thread's provider picker to its continuation group: the thread's
 * own group, plus any other group of the same driver that resumes from the
 * same store (equal, non-null `continuationGroupKey`). A missing key never
 * pairs, which also covers web's Antigravity exact-instance rule.
 *
 * The anchor is the live session's instance when it still has a group, else
 * the stored selection's — `buildModelOptions` guarantees a group for the
 * stored selection, so the picker can never come back empty.
 */
export function filterThreadProviderGroups(
  groups: ReadonlyArray<ProviderGroup>,
  current: {
    readonly instanceId: string;
    readonly fallbackInstanceId?: string | undefined;
    readonly driver: string | null | undefined;
  },
): ReadonlyArray<ProviderGroup> {
  const anchor =
    groups.find((group) => group.providerKey === current.instanceId) ??
    groups.find((group) => group.providerKey === current.fallbackInstanceId);
  if (anchor === undefined)
    return groups.filter((group) => group.providerKey === current.instanceId);
  const driver = current.driver ?? anchor.providerDriver;
  return groups.filter(
    (group) =>
      group.providerKey === anchor.providerKey ||
      (group.providerDriver === driver &&
        anchor.continuationGroupKey !== null &&
        group.continuationGroupKey === anchor.continuationGroupKey),
  );
}
