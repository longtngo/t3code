// @effect-diagnostics nodeBuiltinImport:off
import * as path from "node:path";

import type { LocalLlmModelConfig, LocalLlmProviderConfig, LocalLlmSettings } from "@t3tools/contracts";
import { getModel, getProvider } from "@t3tools/shared/localLlm";

import { expandHomePath } from "../pathExpansion.ts";

export type ManagedEngineId = "mlx-serve" | "ds4";

/** Catalog provider merged with the user's per-provider overrides. */
export interface ResolvedProvider {
  readonly id: string;
  readonly managed: boolean;
  readonly format: string;
  readonly host: string;
  readonly port: number;
  readonly binaryPath?: string | undefined;
  readonly modelsDir?: string | undefined;
  readonly cwdFromBinary?: boolean | undefined;
  /** Grouped tokens (e.g. "--reasoning-budget 0"). */
  readonly defaultArgs: readonly string[];
  readonly baseUrl: string;
}

/** A fully-resolved managed launch, ready to hand to the spawner. */
export interface ResolvedLaunch {
  readonly engineId: ManagedEngineId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
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
    cwdFromBinary: cat.cwdFromBinary,
    defaultArgs: ov.defaultArgs ?? cat.defaultArgs,
    baseUrl: ov.baseUrl ?? `http://${host}:${port}`,
  };
}

const CTX_FLAG: Record<ManagedEngineId, string> = {
  "mlx-serve": "--ctx-size",
  ds4: "--ctx",
};

/**
 * Resolve a model config into a concrete managed launch, or an error describing
 * why it can't be launched (unknown provider/model, external provider, missing
 * models dir). The context slider owns the engine's ctx flag: when
 * `contextWindow` is set and the override args don't already carry it, it is
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
  if (!prov.binaryPath) return { error: `Provider ${config.providerId} has no binary path configured.` };
  if (!prov.modelsDir && !config.modelPathOverride) {
    return { error: `Provider ${config.providerId} has no models directory configured.` };
  }

  const engineId = prov.id as ManagedEngineId;
  const port = config.port ?? prov.port;
  const modelPath = config.modelPathOverride
    ? expandHomePath(config.modelPathOverride)
    : path.join(expandHomePath(prov.modelsDir as string), model.resourceName);

  const flat = splitGroupedArgs(config.argsOverride ?? prov.defaultArgs);
  const ctxFlag = CTX_FLAG[engineId];
  if (config.contextWindow != null && !flat.includes(ctxFlag)) {
    flat.push(ctxFlag, String(config.contextWindow));
  }

  const executable = expandHomePath(prov.binaryPath);
  const portArgs = ["--host", prov.host, "--port", String(port)];
  const args =
    engineId === "mlx-serve"
      ? ["--serve", ...flat, ...portArgs, "--model", modelPath]
      : [...flat, ...portArgs, "-m", modelPath];

  const cwd =
    prov.cwdFromBinary && executable.includes("/") ? path.dirname(executable) : undefined;

  return {
    engineId,
    executable,
    args,
    cwd,
    host: prov.host,
    port,
    modelPath,
    estBytes: model.approxBytes,
  };
}
