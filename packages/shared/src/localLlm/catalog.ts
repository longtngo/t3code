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

export interface ArgSpec {
  readonly flag: string;
  readonly type: "flag" | "enum" | "number" | "string";
  readonly values?: readonly string[];
  readonly placeholder?: string;
  readonly desc?: string;
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

export const PROVIDER_ARG_SPECS: Readonly<Record<string, readonly ArgSpec[]>> = {
  "mlx-serve": [
    { flag: "--ctx-size", type: "number", placeholder: "tokens", desc: "Maximum context length (default: model max)." },
    { flag: "--reasoning-budget", type: "number", placeholder: "0 = no-think", desc: "Max thinking tokens per request." },
    { flag: "--kv-quant", type: "enum", values: ["off", "4", "8", "turbo2", "turbo4"], desc: "KV-cache quantization scheme." },
    { flag: "--kv-attn-mode", type: "enum", values: ["dense", "fused"], desc: "Attention path for quantized KV." },
    { flag: "--temp", type: "number", placeholder: "0.0-2.0", desc: "Default sampling temperature." },
    { flag: "--top-p", type: "number", placeholder: "0-1", desc: "Default nucleus top-p." },
    { flag: "--top-k", type: "number", placeholder: "0 = off", desc: "Default top-k." },
    { flag: "--no-pld", type: "flag", desc: "Force-disable Prompt-Lookup Decoding." },
    { flag: "--pld-draft-len", type: "number", placeholder: "default 5", desc: "Max draft tokens per PLD step." },
    { flag: "--no-vision", type: "flag", desc: "Disable vision encoder (saves memory)." },
    { flag: "--no-mtp", type: "flag", desc: "Disable Qwen native MTP head." },
    { flag: "--max-resident-models", type: "number", placeholder: "default 3", desc: "Max loaded models in memory." },
    { flag: "--prefix-cache-mem", type: "string", placeholder: "2GB / 0=off", desc: "Hot prefix-cache KV budget." },
    { flag: "--timeout", type: "number", placeholder: "secs, 0=none", desc: "Request timeout." },
    { flag: "--engine", type: "enum", values: ["auto", "ds4", "llama"], desc: "Engine selector for .gguf inputs only." },
    { flag: "--log-level", type: "enum", values: ["error", "warn", "info", "debug"], desc: "Log level." },
  ],
  ds4: [
    { flag: "--ctx", type: "number", placeholder: "default 32768", desc: "Context size allocated at startup (-c)." },
    { flag: "--tokens", type: "number", placeholder: "default 384K", desc: "Default max output tokens (-n)." },
    { flag: "--mtp-draft", type: "number", placeholder: "default 1", desc: "Max MTP draft tokens per step." },
    { flag: "--quality", type: "flag", desc: "Prefer exact kernels; strict MTP verification." },
    { flag: "--power", type: "number", placeholder: "1-100", desc: "Target GPU duty cycle %." },
    { flag: "--backend", type: "enum", values: ["metal", "cuda", "cpu"], desc: "Select compute backend explicitly." },
    { flag: "--warm-weights", type: "flag", desc: "Touch mapped pages before serving." },
    { flag: "--cors", type: "flag", desc: "Add CORS headers for browser clients." },
    { flag: "--kv-disk-dir", type: "string", placeholder: "path", desc: "Enable disk KV checkpoints in DIR." },
    { flag: "--kv-disk-space-mb", type: "number", placeholder: "default 4096", desc: "Disk budget for checkpoints." },
  ],
  llamacpp: [
    { flag: "--ctx-size", type: "number", placeholder: "tokens (-c)", desc: "Prompt context size." },
    { flag: "--n-gpu-layers", type: "number", placeholder: "-ngl", desc: "Layers offloaded to GPU." },
    { flag: "--threads", type: "number", placeholder: "-t", desc: "CPU threads." },
    { flag: "--parallel", type: "number", placeholder: "-np", desc: "Parallel request slots." },
    { flag: "--flash-attn", type: "flag", desc: "Enable Flash Attention." },
    { flag: "--cont-batching", type: "flag", desc: "Enable continuous batching." },
  ],
  vllm: [
    { flag: "--max-model-len", type: "number", placeholder: "tokens", desc: "Max sequence length." },
    { flag: "--gpu-memory-utilization", type: "number", placeholder: "0-1", desc: "Fraction of GPU mem to use." },
    { flag: "--dtype", type: "enum", values: ["auto", "half", "bfloat16", "float16", "float32"], desc: "Weight/activation dtype." },
    { flag: "--tensor-parallel-size", type: "number", placeholder: "GPUs", desc: "Tensor-parallel degree." },
    { flag: "--quantization", type: "enum", values: ["awq", "gptq", "fp8", "none"], desc: "Quantization method." },
  ],
  lmstudio: [
    { flag: "--context-length", type: "number", placeholder: "tokens", desc: "Context length (lms load)." },
    { flag: "--gpu", type: "enum", values: ["max", "off", "0.5"], desc: "GPU offload ratio." },
  ],
  ollama: [
    { flag: "OLLAMA_CONTEXT_LENGTH", type: "number", placeholder: "tokens", desc: "Context length (env var)." },
    { flag: "OLLAMA_NUM_PARALLEL", type: "number", placeholder: "requests", desc: "Parallel requests (env var)." },
    { flag: "OLLAMA_KEEP_ALIVE", type: "string", placeholder: "e.g. 30m", desc: "Model keep-alive (env var)." },
  ],
};

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
