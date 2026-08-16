import type { LlmModel, LlmProvider, LocalLlmSettings } from "@t3tools/contracts";
import { getModel } from "@t3tools/shared/localLlm";

import { assignPort, budgetBytes, fits } from "./portBudget.ts";
import { type ResolvedLaunch, resolveLaunch, resolveProvider } from "./resolveLaunch.ts";

export type ModelStatus = "online" | "offline" | "loading" | "stopping" | "error";
export type LoadErrorKind =
  | "budget_exceeded"
  | "already_online"
  | "no_free_port"
  | "not_found"
  | "spawn_failed"
  | "not_managed_process"
  | "external_not_managed";

/** A managed launch this server owns, keyed in the registry by config id. */
export interface RegistryEntry {
  readonly configId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly pid: number;
  readonly port: number;
  readonly estBytes: number;
  readonly state: "loading" | "stopping";
}

export type LoadPlan =
  | { readonly ok: true; readonly launch: ResolvedLaunch }
  | { readonly ok: false; readonly kind: LoadErrorKind; readonly reason: string };

/**
 * Decide whether and how to launch a model config. Pure: no spawn, no fs. The
 * caller does the existence check + spawn when `ok`. Resolves a stable port,
 * reassigning within the provider's range only if the config's port is taken.
 */
export function planLoad(
  configId: string,
  settings: LocalLlmSettings,
  registry: ReadonlyMap<string, RegistryEntry>,
  totalMem: number,
): LoadPlan {
  const config = settings.models.find((m) => m.id === configId);
  if (!config) return { ok: false, kind: "not_found", reason: `Unknown model config: ${configId}` };
  if (registry.has(configId)) {
    return { ok: false, kind: "already_online", reason: `${config.name} is already loaded` };
  }

  const prov = resolveProvider(config.providerId, settings);
  if (!prov) {
    return { ok: false, kind: "not_found", reason: `Unknown provider: ${config.providerId}` };
  }
  if (!prov.managed) {
    return {
      ok: false,
      kind: "external_not_managed",
      reason: `Provider ${config.providerId} is external / probe-only and cannot be launched by t3code.`,
    };
  }

  const taken = new Set(Array.from(registry.values()).map((e) => e.port));
  let port = config.port ?? prov.port;
  if (taken.has(port)) {
    const free = assignPort(config.providerId, taken);
    if (free == null) {
      return { ok: false, kind: "no_free_port", reason: "No free port in the provider's range" };
    }
    port = free;
  }

  const launch = resolveLaunch({ ...config, port }, settings);
  if ("error" in launch) return { ok: false, kind: "not_found", reason: launch.error };

  const budget = budgetBytes(settings.ramBudgetBytes, totalMem);
  const used = Array.from(registry.values()).reduce((sum, e) => sum + e.estBytes, 0);
  if (!fits(launch.estBytes, used, 0, budget)) {
    return {
      ok: false,
      kind: "budget_exceeded",
      reason: `Loading ${config.name} (~${Math.round(launch.estBytes / 1e9)} GB) would exceed the RAM budget`,
    };
  }

  return { ok: true, launch };
}

/** Probe outcome for one config's endpoint (reachable + the first served model, if any). */
export interface ProbeResult {
  readonly reachable: boolean;
  readonly model: LlmModel | null;
}

export interface SampleResult {
  readonly providers: readonly LlmProvider[];
  readonly ramBudgetBytes: number;
  readonly ramUsedBytes: number;
}

function statusOf(entry: RegistryEntry | undefined, probe: ProbeResult | undefined): ModelStatus {
  if (entry?.state === "stopping") return "stopping";
  if (probe?.reachable) return "online";
  if (entry) return "loading";
  return "offline";
}

/**
 * Build the sample from the user's model configs joined with the registry and the
 * per-config probe results. Pure: probes are supplied by the caller. Models are
 * grouped under one provider entry per referenced catalog provider.
 */
export function buildSample(
  settings: LocalLlmSettings,
  registry: ReadonlyMap<string, RegistryEntry>,
  probes: ReadonlyMap<string, ProbeResult>,
  totalMem: number,
): SampleResult {
  const byProvider = new Map<string, LlmModel[]>();
  let ramUsedBytes = 0;

  for (const config of settings.models) {
    const prov = resolveProvider(config.providerId, settings);
    const cat = getModel(config.modelId);
    const entry = registry.get(config.id);
    const probe = probes.get(config.id);
    const status = statusOf(entry, probe);
    if (status === "online" || status === "stopping") {
      ramUsedBytes += cat?.approxBytes ?? entry?.estBytes ?? 0;
    }

    const row: LlmModel = {
      id: config.modelId,
      loaded: status === "online",
      status,
      configId: config.id,
      configName: config.name,
      modelId: config.modelId,
      managed: prov?.managed ?? false,
      ...(prov?.managed ? { engine: config.providerId as "mlx-serve" | "ds4" } : {}),
      ...(cat?.approxBytes != null ? { sizeBytes: cat.approxBytes } : {}),
      ...(cat?.quant != null ? { quantization: cat.quant } : {}),
      ...(cat?.moe != null ? { isMoe: cat.moe } : {}),
      contextLength: config.contextWindow ?? cat?.maxContext,
      ...(entry ? { pid: entry.pid, port: entry.port } : {}),
      ...(probe?.model?.state != null ? { state: probe.model.state } : {}),
    };

    const list = byProvider.get(config.providerId);
    if (list) list.push(row);
    else byProvider.set(config.providerId, [row]);
  }

  const providers: LlmProvider[] = [];
  for (const [providerId, models] of byProvider) {
    const prov = resolveProvider(providerId, settings);
    providers.push({
      name: prov?.id ?? providerId,
      baseUrl: prov?.baseUrl ?? "",
      reachable: true,
      models,
    });
  }

  return {
    providers,
    ramBudgetBytes: budgetBytes(settings.ramBudgetBytes, totalMem),
    ramUsedBytes,
  };
}

/** The endpoint (host, port) to probe for a config's online status. */
export function probeTarget(
  configId: string,
  settings: LocalLlmSettings,
  registry: ReadonlyMap<string, RegistryEntry>,
): { host: string; port: number } | null {
  const config = settings.models.find((m) => m.id === configId);
  if (!config) return null;
  const prov = resolveProvider(config.providerId, settings);
  if (!prov) return null;
  const entry = registry.get(configId);
  return { host: prov.host, port: entry?.port ?? config.port ?? prov.port };
}
