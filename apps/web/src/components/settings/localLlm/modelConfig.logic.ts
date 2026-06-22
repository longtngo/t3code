import type { LocalLlmModelConfig, LocalLlmSettings } from "@t3tools/contracts";
import {
  LOCAL_LLM_PROVIDERS,
  type ProviderCatalogEntry,
  compatibleModels,
  firstFreePort,
  getModel,
  getProvider,
} from "@t3tools/shared/localLlm";

const DEFAULT_CONTEXT = 65536;

/** Whether a provider should appear in the model-config picker (visible OR referenced). */
function providerVisible(settings: LocalLlmSettings, providerId: string): boolean {
  const override = settings.providers[providerId];
  if (override) return override.visible;
  return true;
}

/** Providers selectable for a config: visible ones, plus the config's current one. */
export function visibleProviders(
  settings: LocalLlmSettings,
  currentProviderId?: string,
): ProviderCatalogEntry[] {
  return LOCAL_LLM_PROVIDERS.filter(
    (p) => providerVisible(settings, p.id) || p.id === currentProviderId,
  );
}

/** Clamp a requested context window to the model's maximum (and a sane floor). */
export function clampContext(value: number, modelId: string): number {
  const max = getModel(modelId)?.maxContext ?? value;
  if (!Number.isFinite(value) || value <= 0) return max;
  return Math.min(value, max);
}

function takenPorts(settings: LocalLlmSettings): Set<number> {
  const ports = new Set<number>();
  for (const m of settings.models) if (m.port != null) ports.add(m.port);
  return ports;
}

function uniqueConfigId(base: string, existing: ReadonlySet<string>): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "config";
  if (!existing.has(slug)) return slug;
  let i = 2;
  while (existing.has(`${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}

/** A fresh model config: first visible provider, first compatible model, free port. */
export function newModelConfig(settings: LocalLlmSettings): LocalLlmModelConfig {
  const provider = visibleProviders(settings)[0] ?? LOCAL_LLM_PROVIDERS[0];
  if (!provider) {
    // The catalog is never empty, but satisfy the type checker with a minimal config.
    return { id: uniqueConfigId("config", new Set(settings.models.map((m) => m.id))), name: "New model", providerId: "", modelId: "", visible: true };
  }
  const model = compatibleModels(provider.id)[0];
  const existing = new Set(settings.models.map((m) => m.id));
  const port = provider.managed ? (firstFreePort(provider.id, takenPorts(settings)) ?? undefined) : undefined;
  return {
    id: uniqueConfigId(model?.id ?? "config", existing),
    name: model?.name ?? "New model",
    providerId: provider.id,
    modelId: model?.id ?? "",
    contextWindow: model ? Math.min(DEFAULT_CONTEXT, model.maxContext) : undefined,
    visible: true,
    ...(port != null ? { port } : {}),
  };
}

/** Switching provider resets the model to the first compatible one and clamps ctx. */
export function onProviderChange(
  config: LocalLlmModelConfig,
  providerId: string,
): LocalLlmModelConfig {
  const model = compatibleModels(providerId)[0];
  const modelId = model?.id ?? "";
  const contextWindow = model
    ? clampContext(config.contextWindow ?? model.maxContext, modelId)
    : undefined;
  return { ...config, providerId, modelId, contextWindow };
}

/** Switching model clamps the context window to the new model's max. */
export function onModelChange(config: LocalLlmModelConfig, modelId: string): LocalLlmModelConfig {
  const contextWindow = clampContext(config.contextWindow ?? getModel(modelId)?.maxContext ?? 0, modelId);
  return { ...config, modelId, contextWindow };
}

/** The provider's default args label (catalog defaults, overridable per provider). */
export function providerDefaultArgs(settings: LocalLlmSettings, providerId: string): readonly string[] {
  return settings.providers[providerId]?.defaultArgs ?? getProvider(providerId)?.defaultArgs ?? [];
}
