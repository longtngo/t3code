// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type {
  LocalLlmModelConfig,
  LocalLlmProviderConfig,
  LocalLlmSettings,
} from "@t3tools/contracts";
import { getModel, getProvider } from "@t3tools/shared/localLlm";

import { expandHomePath } from "../pathExpansion.ts";

export type ManagedEngineId = "mlx-serve";

/** Catalog provider merged with the user's per-provider overrides. */
export interface ResolvedProvider {
  readonly id: string;
  readonly managed: boolean;
  readonly format: string;
  readonly host: string;
  readonly port: number;
  readonly binaryPath?: string | undefined;
  readonly modelsDir?: string | undefined;
  /** Grouped tokens (e.g. "--reasoning-budget 0"). */
  readonly defaultArgs: readonly string[];
  readonly baseUrl: string;
}

/** A fully-resolved managed launch, ready to hand to the spawner. */
export interface ResolvedLaunch {
  readonly engineId: ManagedEngineId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly host: string;
  readonly port: number;
  readonly modelPath: string;
  readonly estBytes: number;
}

export interface ResolveError {
  readonly error: string;
}

/** Split grouped arg tokens ("--flag val") back into flat spawn tokens. */
export function splitGroupedArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const token of args) {
    const trimmed = token.trim();
    if (trimmed === "") continue;
    const sp = trimmed.indexOf(" ");
    if (trimmed.startsWith("-") && sp > 0) {
      out.push(trimmed.slice(0, sp), trimmed.slice(sp + 1).trim());
    } else {
      out.push(trimmed);
    }
  }
  return out;
}

/** Merge a catalog provider with the user's overrides; null for unknown ids. */
export function resolveProvider(
  catalogId: string,
  settings: LocalLlmSettings,
): ResolvedProvider | null {
  const cat = getProvider(catalogId);
  if (!cat) return null;
  const ov: Partial<LocalLlmProviderConfig> = settings.providers[catalogId] ?? {};
  const host = ov.host ?? cat.host;
  const port = ov.port ?? cat.defaultPort;
  return {
    id: cat.id,
    managed: cat.managed,
    format: cat.format,
    host,
    port,
    binaryPath: ov.binaryPath ?? cat.binaryPath,
    modelsDir: ov.modelsDir ?? cat.modelsDir,
    defaultArgs: ov.defaultArgs ?? cat.defaultArgs,
    baseUrl: ov.baseUrl ?? `http://${host}:${port}`,
  };
}

/** The flag mlx-serve takes for the context window; owned by the config's context slider. */
const CTX_FLAG = "--ctx-size";

/**
 * The launch args for a config, before the port and model flags are added.
 *
 * An explicit `argsOverride` replaces everything: someone who typed a command line means it.
 * Otherwise the provider's defaults are extended with the model's own, which is how a model
 * that needs a specific flag to perform (Qwen3.8 and `--mtp-depth 2`) gets it without every
 * config having to re-type the provider defaults alongside it. A model default is skipped when
 * its flag is already present, so the provider layer stays the one that wins on conflict.
 */
export function launchArgs(
  config: LocalLlmModelConfig,
  providerDefaults: readonly string[],
  modelDefaults: readonly string[] | undefined,
): string[] {
  if (config.argsOverride) return splitGroupedArgs(config.argsOverride);
  const flat = splitGroupedArgs(providerDefaults);
  for (const grouped of modelDefaults ?? []) {
    const tokens = splitGroupedArgs([grouped]);
    const flag = tokens[0];
    if (flag === undefined || flat.includes(flag)) continue;
    flat.push(...tokens);
  }
  return flat;
}

/**
 * Resolve a model config into a concrete managed launch, or an error describing
 * why it can't be launched (unknown provider/model, external provider, missing
 * models dir). The context slider owns the engine's ctx flag: when
 * `contextWindow` is set and the resolved args don't already carry it, it is
 * appended. Pure — performs no filesystem access.
 */
export function resolveLaunch(
  config: LocalLlmModelConfig,
  settings: LocalLlmSettings,
): ResolvedLaunch | ResolveError {
  const prov = resolveProvider(config.providerId, settings);
  if (!prov) return { error: `Unknown local LLM provider: ${config.providerId}` };
  if (!prov.managed) {
    return {
      error: `Provider ${config.providerId} is external / probe-only and cannot be launched by t3code.`,
    };
  }
  const model = getModel(config.modelId);
  if (!model) return { error: `Unknown local LLM model: ${config.modelId}` };
  if (!prov.binaryPath)
    return { error: `Provider ${config.providerId} has no binary path configured.` };
  if (!prov.modelsDir && !config.modelPathOverride) {
    return { error: `Provider ${config.providerId} has no models directory configured.` };
  }

  const engineId = prov.id as ManagedEngineId;
  const port = config.port ?? prov.port;
  const modelPath = config.modelPathOverride
    ? expandHomePath(config.modelPathOverride)
    : NodePath.join(expandHomePath(prov.modelsDir as string), model.resourceName);

  const flat = launchArgs(config, prov.defaultArgs, model.defaultArgs);
  if (config.contextWindow != null && !flat.includes(CTX_FLAG)) {
    flat.push(CTX_FLAG, String(config.contextWindow));
  }

  const executable = expandHomePath(prov.binaryPath);
  const portArgs = ["--host", prov.host, "--port", String(port)];
  const args = ["--serve", ...flat, ...portArgs, "--model", modelPath];

  return {
    engineId,
    executable,
    args,
    host: prov.host,
    port,
    modelPath,
    estBytes: model.approxBytes,
  };
}
