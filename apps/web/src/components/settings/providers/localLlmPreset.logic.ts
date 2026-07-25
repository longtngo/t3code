import type {
  LocalLlmModelConfig,
  LocalLlmSettings,
  ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";
import { getProvider } from "@t3tools/shared/localLlm";

export interface DriverEnvNames {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

const DEFAULT_NAMES: DriverEnvNames = {
  baseUrl: "OPENAI_BASE_URL",
  apiKey: "OPENAI_API_KEY",
  model: "CODEX_MODEL",
};

const ANTHROPIC_NAMES: DriverEnvNames = {
  baseUrl: "ANTHROPIC_BASE_URL",
  apiKey: "ANTHROPIC_API_KEY",
  model: "ANTHROPIC_MODEL",
};

/** Env-var names a driver expects to point it at an OpenAI-compatible local endpoint. */
export const DRIVER_ENV_NAMES: Readonly<Record<string, DriverEnvNames>> = {
  codex: DEFAULT_NAMES,
  claudeAgent: ANTHROPIC_NAMES,
  claude: ANTHROPIC_NAMES,
};

/** The base URL a model config's provider serves on (`http://host:port/v1`). */
export function presetBaseUrl(config: LocalLlmModelConfig, settings?: LocalLlmSettings): string {
  const cat = getProvider(config.providerId);
  const ov = settings?.providers[config.providerId];
  const host = ov?.host ?? cat?.host ?? "127.0.0.1";
  const port = config.port ?? ov?.port ?? cat?.defaultPort ?? 8000;
  return `http://${host}:${port}/v1`;
}

/** Build the driver-aware env vars that point an agent instance at this local model. */
export function presetEnv(
  config: LocalLlmModelConfig,
  driverKind: string,
  settings?: LocalLlmSettings,
): ProviderInstanceEnvironmentVariable[] {
  const names = DRIVER_ENV_NAMES[driverKind] ?? DEFAULT_NAMES;
  return [
    { name: names.baseUrl, value: presetBaseUrl(config, settings), sensitive: false },
    { name: names.apiKey, value: "local", sensitive: true },
    { name: names.model, value: config.modelId, sensitive: false },
  ];
}

export interface MergeEnvResult {
  readonly merged: ProviderInstanceEnvironmentVariable[];
  /** Names introduced by the preset that didn't exist before. */
  readonly added: string[];
  /** Names the preset overwrote (preset wins on conflict). */
  readonly overridden: string[];
}

/** Merge preset vars into existing ones; on a name conflict the preset value wins. */
export function mergeEnv(
  existing: readonly ProviderInstanceEnvironmentVariable[],
  preset: readonly ProviderInstanceEnvironmentVariable[],
): MergeEnvResult {
  const presetNames = new Set(preset.map((e) => e.name));
  const existingNames = new Set(existing.map((e) => e.name));
  const merged = [...existing.filter((e) => !presetNames.has(e.name)), ...preset];
  return {
    merged,
    added: preset.filter((e) => !existingNames.has(e.name)).map((e) => e.name),
    overridden: preset.filter((e) => existingNames.has(e.name)).map((e) => e.name),
  };
}
