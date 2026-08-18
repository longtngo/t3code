// Build-time catalog of local LLM providers, models, and per-provider CLI flags.
//
// Curated by hand from the local-LLM providers runbook and the live
// `mlx-serve --help` / `ds4-server --help`. This is the single source of truth:
// t3code no longer auto-detects providers or scans the filesystem for models.
export type LocalLlmFormat = "mlx" | "gguf" | "safetensors";

export interface ProviderCatalogEntry {
  readonly id: string;
  readonly name: string;
  /** Can t3code spawn/kill this server? Only mlx-serve and ds4. */
  readonly managed: boolean;
  readonly format: LocalLlmFormat;
  readonly host: string;
  readonly defaultPort: number;
  /** managed: default executable (PATH name or path-shaped). */
  readonly binaryPath?: string;
  /** managed: default directory holding model resources. */
  readonly modelsDir?: string;
  /** managed: spawn cwd = dirname(binary) (ds4 resolves Metal shaders there). */
  readonly cwdFromBinary?: boolean;
  /** Runbook-recommended launch args, as grouped tokens (e.g. "--reasoning-budget 0"). */
  readonly defaultArgs: readonly string[];
  readonly note: string;
}

export interface ModelCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly format: LocalLlmFormat;
  /** dir (mlx) or file (gguf) name under the provider's modelsDir. */
  readonly resourceName: string;
  readonly quant?: string;
  readonly moe?: boolean;
  readonly maxContext: number;
  readonly approxBytes: number;
  /** A GGUF that only ds4-server should serve (excluded from generic gguf servers). */
  readonly ds4Only?: boolean;
  readonly note?: string;
}

export const GiB = (n: number): number => n * 1024 ** 3;

export const LOCAL_LLM_PROVIDERS: readonly ProviderCatalogEntry[] = [
  {
    id: "mlx-serve",
    name: "mlx-serve",
    managed: true,
    format: "mlx",
    host: "127.0.0.1",
    defaultPort: 8765,
    binaryPath: "mlx-serve",
    modelsDir: "~/llm/models",
    defaultArgs: ["--reasoning-budget 0"],
    note: "Apple Silicon, primary. One model per process/port. PLD default ON (26.6.8+).",
  },
  {
    id: "ds4",
    name: "DeepSeek V4 engine (ds4)",
    managed: true,
    format: "gguf",
    host: "127.0.0.1",
    defaultPort: 8000,
    binaryPath: "ds4-server",
    modelsDir: "~/ds4/gguf",
    cwdFromBinary: true,
    defaultArgs: [],
    note: "Offline frontier. Loads one GGUF via -m; cwd pinned to binary dir (Metal shaders).",
  },
  {
    id: "vllm",
    name: "vLLM",
    managed: false,
    format: "safetensors",
    host: "127.0.0.1",
    defaultPort: 8000,
    defaultArgs: [],
    note: "External / probe-only. OpenAI-compatible /v1/models.",
  },
  {
    id: "llamacpp",
    name: "llama.cpp (llama-server)",
    managed: false,
    format: "gguf",
    host: "127.0.0.1",
    defaultPort: 8080,
    defaultArgs: [],
    note: "External / probe-only. Served ~= loaded.",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    managed: false,
    format: "gguf",
    host: "127.0.0.1",
    defaultPort: 1234,
    defaultArgs: [],
    note: "External / probe-only.",
  },
  {
    id: "ollama",
    name: "Ollama",
    managed: false,
    format: "gguf",
    host: "127.0.0.1",
    defaultPort: 11434,
    defaultArgs: [],
    note: "External / probe-only. True resident via /api/ps (planned).",
  },
];

export const LOCAL_LLM_MODELS: readonly ModelCatalogEntry[] = [
  {
    id: "Qwen3.6-35B-A3B-4bit",
    name: "Qwen3.6 35B A3B",
    format: "mlx",
    resourceName: "Qwen3.6-35B-A3B-4bit",
    quant: "4-bit",
    moe: true,
    maxContext: 163840,
    approxBytes: GiB(19),
    note: "Fastest at top quality (133 d_tps, PLD-on).",
  },
  {
    id: "Qwen3.8-27B-MLX-Serve-4bit",
    name: "Qwen3.8 27B",
    format: "mlx",
    resourceName: "Qwen3.8-27B-MLX-Serve-4bit",
    quant: "4-bit",
    moe: false,
    maxContext: 262144,
    approxBytes: GiB(17),
    note: "Local coding model. Best grounding, but prefill is 901 t/s against the 35B's 5629.",
  },
  {
    id: "gemma-4-26b-a4b-it-4bit",
    name: "Gemma 4 26B A4B",
    format: "mlx",
    resourceName: "gemma-4-26b-a4b-it-4bit",
    quant: "4-bit",
    moe: true,
    maxContext: 131072,
    approxBytes: GiB(15),
    note: "Terser / lower wall (99 d_tps).",
  },
  {
    id: "gemma-4-12B-it-4bit",
    name: "Gemma 4 12B",
    format: "mlx",
    resourceName: "gemma-4-12B-it-4bit",
    quant: "4-bit",
    moe: false,
    maxContext: 131072,
    approxBytes: GiB(10),
    note: "Lightweight, low RAM (~34 d_tps).",
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    format: "gguf",
    resourceName: "ds4flash.gguf",
    quant: "GGUF",
    moe: true,
    maxContext: 163840,
    approxBytes: GiB(91),
    ds4Only: true,
    note: "Offline frontier capability.",
  },
];

const PROV_BY_ID: ReadonlyMap<string, ProviderCatalogEntry> = new Map(
  LOCAL_LLM_PROVIDERS.map((p) => [p.id, p]),
);
const MODEL_BY_ID: ReadonlyMap<string, ModelCatalogEntry> = new Map(
  LOCAL_LLM_MODELS.map((m) => [m.id, m]),
);

export const getProvider = (id: string): ProviderCatalogEntry | undefined => PROV_BY_ID.get(id);
export const getModel = (id: string): ModelCatalogEntry | undefined => MODEL_BY_ID.get(id);

/** Ports reserved per managed provider (caps concurrent processes per engine). */
export const PROVIDER_PORT_WINDOW = 35;

/** Inclusive port range a managed provider's configs draw stable ports from. */
export function providerPortRange(providerId: string): { min: number; max: number } {
  const p = getProvider(providerId);
  const start = p?.defaultPort ?? 8765;
  return { min: start, max: start + PROVIDER_PORT_WINDOW - 1 };
}

/** First free port in the provider's range not already taken, or null if full. */
export function firstFreePort(providerId: string, taken: ReadonlySet<number>): number | null {
  const { min, max } = providerPortRange(providerId);
  for (let port = min; port <= max; port++) {
    if (!taken.has(port)) return port;
  }
  return null;
}

/** Catalog models a provider can serve: same format; ds4 takes only its dedicated GGUF. */
export function compatibleModels(providerId: string): readonly ModelCatalogEntry[] {
  const p = getProvider(providerId);
  if (!p) return [];
  return LOCAL_LLM_MODELS.filter(
    (m) => m.format === p.format && (p.id === "ds4" ? !!m.ds4Only : !m.ds4Only),
  );
}
