# Local LLM Support Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace runtime auto-detection of local LLM providers/models with a build-time catalog + a user-curated list of model configs, surfaced through one merged "Local LLM" settings tab, a config-sourced sidebar, and provider env-var presets.

**Architecture:** A static catalog (data) in `packages/shared/src/localLlm`; new `LocalLlmSettings` schema + legacy migration in `packages/contracts`; an `LlmServeManager` driven by model configs (no `ps`/filesystem scanning, mlx-serve + ds4 spawnable only); React settings UI + sidebar + presets dialog in `apps/web`.

**Tech Stack:** TypeScript, effect/Schema (contracts), Effect (server), React/Vite + Vitest (web), `vp` test runner.

## Global Constraints

- **Branch / integration:** `personal` is the main-equivalent branch. Work happens in worktree `~/.t3/worktrees/t3code/local-llm-overhaul` on `feat/local-llm-overhaul`.
- **TESTING THIS PHASE — unit tests only.** Do **NOT** run any build command (`pnpm build` / `vp run build` / desktop dist). Do **NOT** spawn mlx-serve/ds4 or load any model into memory/GPU (the machine is running GPU experiments). The spawner/process layer is **mocked** in all tests. Stop and wait for the user's explicit signal before any build or any real model-load/integration test.
- **Managed engines = mlx-serve + ds4 only.** vLLM / llama.cpp / LM Studio / Ollama are configurable + probe-only; never spawned.
- **`packages/contracts` is schema-only** — no runtime logic; catalog data lives in `packages/shared`.
- **Per-package test command:** from the package dir, `vp test run <relative-test-path>`. Web node-unit: `vp test run --project unit <path>`. Never run `vp test run apps/web` (mixes projects).
- **Effect/Schema settings** use `Schema.withDecodingDefault`; whole-object replacement for patch fields that must allow key deletion (precedent: `localModels`, `providerInstances`).
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Shared local-LLM catalog (`@t3tools/shared/localLlm`)

**Files:**
- Create: `packages/shared/src/localLlm/catalog.ts`
- Create: `packages/shared/src/localLlm/index.ts`
- Test: `packages/shared/src/localLlm/catalog.test.ts`
- Modify: `packages/shared/package.json` (add `./localLlm` export)

**Interfaces:**
- Produces:
  - `LocalLlmFormat = "mlx" | "gguf" | "safetensors"`
  - `ProviderCatalogEntry`, `ModelCatalogEntry`, `ArgSpec` (shapes per spec §1)
  - `LOCAL_LLM_PROVIDERS: readonly ProviderCatalogEntry[]`
  - `LOCAL_LLM_MODELS: readonly ModelCatalogEntry[]`
  - `PROVIDER_ARG_SPECS: Readonly<Record<string, readonly ArgSpec[]>>`
  - `getProvider(id): ProviderCatalogEntry | undefined`
  - `getModel(id): ModelCatalogEntry | undefined`
  - `compatibleModels(providerId): readonly ModelCatalogEntry[]`
  - `GiB(n): number` (helper: `n * 1024**3`)

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/localLlm/catalog.test.ts
import { describe, expect, it } from "vitest";
import {
  LOCAL_LLM_MODELS, LOCAL_LLM_PROVIDERS, PROVIDER_ARG_SPECS,
  compatibleModels, getModel, getProvider,
} from "./index.ts";

describe("local llm catalog", () => {
  it("has unique provider and model ids", () => {
    const pids = LOCAL_LLM_PROVIDERS.map((p) => p.id);
    expect(new Set(pids).size).toBe(pids.length);
    const mids = LOCAL_LLM_MODELS.map((m) => m.id);
    expect(new Set(mids).size).toBe(mids.length);
  });

  it("marks only mlx-serve and ds4 as managed", () => {
    const managed = LOCAL_LLM_PROVIDERS.filter((p) => p.managed).map((p) => p.id).sort();
    expect(managed).toEqual(["ds4", "mlx-serve"]);
  });

  it("every model format has at least one provider", () => {
    for (const m of LOCAL_LLM_MODELS) {
      expect(LOCAL_LLM_PROVIDERS.some((p) => p.format === m.format)).toBe(true);
    }
  });

  it("compatibleModels matches by format and respects ds4Only", () => {
    const mlx = compatibleModels("mlx-serve").map((m) => m.id);
    expect(mlx).toContain("Qwen3.6-35B-A3B-4bit");
    expect(mlx).not.toContain("deepseek-v4-flash");

    const ds4 = compatibleModels("ds4").map((m) => m.id);
    expect(ds4).toEqual(["deepseek-v4-flash"]);

    const llama = compatibleModels("llamacpp").map((m) => m.id);
    expect(llama).not.toContain("deepseek-v4-flash"); // ds4Only excluded from generic gguf
  });

  it("arg specs reference known providers and have unique flags each", () => {
    for (const [pid, specs] of Object.entries(PROVIDER_ARG_SPECS)) {
      expect(getProvider(pid)).toBeDefined();
      const flags = specs.map((s) => s.flag);
      expect(new Set(flags).size).toBe(flags.length);
    }
  });

  it("managed model resources resolve to a non-empty resourceName", () => {
    for (const m of LOCAL_LLM_MODELS) expect(m.resourceName.length).toBeGreaterThan(0);
    expect(getModel("deepseek-v4-flash")?.resourceName).toBe("ds4flash.gguf");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && vp test run src/localLlm/catalog.test.ts`
Expected: FAIL (cannot resolve `./index.ts`).

- [ ] **Step 3: Write the catalog**

```ts
// packages/shared/src/localLlm/catalog.ts
export type LocalLlmFormat = "mlx" | "gguf" | "safetensors";

export interface ProviderCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly managed: boolean;
  readonly format: LocalLlmFormat;
  readonly host: string;
  readonly defaultPort: number;
  readonly binaryPath?: string;
  readonly modelsDir?: string;
  readonly cwdFromBinary?: boolean;
  readonly defaultArgs: readonly string[];
  readonly note: string;
}

export interface ModelCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly format: LocalLlmFormat;
  readonly resourceName: string;
  readonly quant?: string;
  readonly moe?: boolean;
  readonly maxContext: number;
  readonly approxBytes: number;
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
  { id: "mlx-serve", name: "mlx-serve", managed: true, format: "mlx",
    host: "127.0.0.1", defaultPort: 8765, binaryPath: "mlx-serve", modelsDir: "~/llm/models",
    defaultArgs: ["--reasoning-budget 0"],
    note: "Apple Silicon, primary. One model per process/port. PLD default ON (26.6.8+)." },
  { id: "ds4", name: "DeepSeek V4 engine (ds4)", managed: true, format: "gguf",
    host: "127.0.0.1", defaultPort: 8000, binaryPath: "ds4-server", modelsDir: "~/ds4/gguf",
    cwdFromBinary: true, defaultArgs: [],
    note: "Offline frontier. Loads one GGUF via -m; cwd pinned to binary dir (Metal shaders)." },
  { id: "vllm", name: "vLLM", managed: false, format: "safetensors",
    host: "127.0.0.1", defaultPort: 8000, defaultArgs: [],
    note: "External / probe-only. OpenAI-compatible /v1/models." },
  { id: "llamacpp", name: "llama.cpp (llama-server)", managed: false, format: "gguf",
    host: "127.0.0.1", defaultPort: 8080, defaultArgs: [],
    note: "External / probe-only. Served ~= loaded." },
  { id: "lmstudio", name: "LM Studio", managed: false, format: "gguf",
    host: "127.0.0.1", defaultPort: 1234, defaultArgs: [], note: "External / probe-only." },
  { id: "ollama", name: "Ollama", managed: false, format: "gguf",
    host: "127.0.0.1", defaultPort: 11434, defaultArgs: [],
    note: "External / probe-only. True resident via /api/ps (planned)." },
];

export const LOCAL_LLM_MODELS: readonly ModelCatalogEntry[] = [
  { id: "Qwen3.6-35B-A3B-4bit", name: "Qwen3.6 35B A3B", format: "mlx",
    resourceName: "Qwen3.6-35B-A3B-4bit", quant: "4-bit", moe: true, maxContext: 163840,
    approxBytes: GiB(19), note: "Fastest at top quality (133 d_tps, PLD-on)." },
  { id: "gemma-4-26b-a4b-it-4bit", name: "Gemma 4 26B A4B", format: "mlx",
    resourceName: "gemma-4-26b-a4b-it-4bit", quant: "4-bit", moe: true, maxContext: 131072,
    approxBytes: GiB(15), note: "Terser / lower wall (99 d_tps)." },
  { id: "gemma-4-12B-it-4bit", name: "Gemma 4 12B", format: "mlx",
    resourceName: "gemma-4-12B-it-4bit", quant: "4-bit", moe: false, maxContext: 131072,
    approxBytes: GiB(10), note: "Lightweight, low RAM (~34 d_tps)." },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", format: "gguf",
    resourceName: "ds4flash.gguf", quant: "GGUF", moe: true, maxContext: 163840,
    approxBytes: GiB(91), ds4Only: true, note: "Offline frontier capability." },
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

const PROV_BY_ID = new Map(LOCAL_LLM_PROVIDERS.map((p) => [p.id, p]));
const MODEL_BY_ID = new Map(LOCAL_LLM_MODELS.map((m) => [m.id, m]));

export const getProvider = (id: string): ProviderCatalogEntry | undefined => PROV_BY_ID.get(id);
export const getModel = (id: string): ModelCatalogEntry | undefined => MODEL_BY_ID.get(id);

export function compatibleModels(providerId: string): readonly ModelCatalogEntry[] {
  const p = getProvider(providerId);
  if (!p) return [];
  return LOCAL_LLM_MODELS.filter(
    (m) => m.format === p.format && (p.id === "ds4" ? !!m.ds4Only : !m.ds4Only),
  );
}
```

```ts
// packages/shared/src/localLlm/index.ts
export * from "./catalog.ts";
```

- [ ] **Step 4: Add the subpath export**

In `packages/shared/package.json` `exports`, add (alphabetically near others):

```json
    "./localLlm": {
      "types": "./src/localLlm/index.ts",
      "import": "./src/localLlm/index.ts"
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/shared && vp test run src/localLlm/catalog.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/localLlm packages/shared/package.json
git commit -m "feat(shared): build-time local-LLM provider/model/arg catalog"
```

---

### Task 2: `LocalLlmSettings` schema + defaults

**Files:**
- Modify: `packages/contracts/src/settings.ts` (add new schema near the existing `LocalModelsSettings` ~lines 395-440; keep `LocalModelsSettings` as deprecated/legacy for migration; add `localLlm` to `ServerSettings` and `ServerSettingsPatch`)
- Test: `packages/contracts/src/settings.localLlm.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (string ids validated at runtime by the catalog, not the schema).
- Produces:
  - `LocalLlmProviderConfig`, `LocalLlmModelConfig`, `LocalLlmSettings` schemas + `.Type`s
  - `ServerSettings.localLlm: LocalLlmSettings`
  - `ServerSettingsPatch.localLlm?: LocalLlmSettings` (optionalKey, whole-object)

- [ ] **Step 1: Write the failing test**

```ts
// packages/contracts/src/settings.localLlm.test.ts
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { LocalLlmSettings } from "./settings.ts";

const decode = Schema.decodeUnknownSync(LocalLlmSettings);

describe("LocalLlmSettings", () => {
  it("fills defaults for an empty object", () => {
    const s = decode({});
    expect(s.ramBudgetBytes).toBe(0);
    expect(s.providers).toEqual({});
    expect(s.models).toEqual([]);
  });

  it("decodes a provider override and a model config", () => {
    const s = decode({
      ramBudgetBytes: 1024,
      providers: { "mlx-serve": { visible: false, modelsDir: "~/m", defaultArgs: ["--no-pld"] } },
      models: [{ id: "c1", name: "Fast", providerId: "mlx-serve", modelId: "Qwen3.6-35B-A3B-4bit",
        contextWindow: 65536, visible: true, port: 8765, argsOverride: ["--reasoning-budget 0"] }],
    });
    expect(s.providers["mlx-serve"].visible).toBe(false);
    expect(s.models[0].contextWindow).toBe(65536);
    expect(s.models[0].visible).toBe(true);
  });

  it("defaults model.visible to true and provider.visible to true", () => {
    const s = decode({ providers: { ds4: {} }, models: [
      { id: "c2", name: "X", providerId: "ds4", modelId: "deepseek-v4-flash" }] });
    expect(s.providers.ds4.visible).toBe(true);
    expect(s.models[0].visible).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/contracts && vp test run src/settings.localLlm.test.ts`
Expected: FAIL (`LocalLlmSettings` not exported).

- [ ] **Step 3: Add the schema**

In `packages/contracts/src/settings.ts`, after the existing `LocalModelsSettings` block, add (`TrimmedString`, `TrimmedNonEmptyString`, `Effect` are already imported in this file):

```ts
export const LocalLlmProviderConfig = Schema.Struct({
  visible: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  host: Schema.optional(TrimmedString),
  port: Schema.optional(Schema.Number),
  binaryPath: Schema.optional(TrimmedString),
  modelsDir: Schema.optional(TrimmedString),
  baseUrl: Schema.optional(TrimmedString),
  defaultArgs: Schema.optional(Schema.Array(TrimmedString)),
});
export type LocalLlmProviderConfig = typeof LocalLlmProviderConfig.Type;

export const LocalLlmModelConfig = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  providerId: TrimmedNonEmptyString,
  modelId: TrimmedNonEmptyString,
  contextWindow: Schema.optional(Schema.Number),
  visible: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  port: Schema.optional(Schema.Number),
  argsOverride: Schema.optional(Schema.Array(TrimmedString)),
  modelPathOverride: Schema.optional(TrimmedString),
});
export type LocalLlmModelConfig = typeof LocalLlmModelConfig.Type;

export const LocalLlmSettings = Schema.Struct({
  ramBudgetBytes: Schema.Number.pipe(Schema.withDecodingDefault(() => 0)),
  providers: Schema.Record(TrimmedNonEmptyString, LocalLlmProviderConfig).pipe(
    Schema.withDecodingDefault(() => ({})),
  ),
  models: Schema.Array(LocalLlmModelConfig).pipe(Schema.withDecodingDefault(() => [])),
});
export type LocalLlmSettings = typeof LocalLlmSettings.Type;
```

> NOTE: match the existing file's `withDecodingDefault` call style — if it uses `Effect.succeed(x)`, write `Schema.withDecodingDefault(Effect.succeed(true))` etc. instead of the thunk form above. Mirror the surrounding `LocalModelsSettings` exactly.

Then in `ServerSettings` add (leave `localModels` in place for migration):

```ts
  localLlm: LocalLlmSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
```

And in `ServerSettingsPatch` add:

```ts
  localLlm: Schema.optionalKey(LocalLlmSettings),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/contracts && vp test run src/settings.localLlm.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/settings.localLlm.test.ts
git commit -m "feat(contracts): LocalLlmSettings schema (providers + model configs)"
```

---

### Task 3: Legacy `localModels` → `localLlm` migration

**Files:**
- Create: `packages/contracts/src/localLlmMigration.ts`
- Test: `packages/contracts/src/localLlmMigration.test.ts`
- Modify: `apps/server/src/serverSettings.ts` (call migration after decode when `localLlm` is empty and `localModels` is present — locate the settings decode/normalize path; the migration is invoked there, not inside the Schema)

**Interfaces:**
- Consumes: `LocalLlmSettings`, `LocalModelsSettings` types (Task 2); catalog `getModel`/`LOCAL_LLM_MODELS` (Task 1) to match `perModel` keys to `resourceName`.
- Produces: `migrateLocalModels(legacy: LocalModelsSettings): LocalLlmSettings`

- [ ] **Step 1: Write the failing test**

```ts
// packages/contracts/src/localLlmMigration.test.ts
import { describe, expect, it } from "vitest";
import { migrateLocalModels } from "./localLlmMigration.ts";

describe("migrateLocalModels", () => {
  it("maps modelsDir/defaultArgs/ramBudget and ds4 enabled->visible", () => {
    const out = migrateLocalModels({
      modelsDir: "~/llm/models", ramBudgetBytes: 42,
      defaultArgs: ["--reasoning-budget", "0"],
      perModel: {},
      ds4: { enabled: true, binaryPath: "~/x/ds4-server", modelsDir: "~/g", defaultArgs: [], perModel: {} },
    } as never);
    expect(out.ramBudgetBytes).toBe(42);
    expect(out.providers["mlx-serve"].modelsDir).toBe("~/llm/models");
    expect(out.providers["mlx-serve"].defaultArgs).toEqual(["--reasoning-budget 0"]);
    expect(out.providers.ds4.visible).toBe(true);
    expect(out.providers.ds4.binaryPath).toBe("~/x/ds4-server");
  });

  it("seeds a model config from a perModel key matching a catalog resourceName", () => {
    const out = migrateLocalModels({
      modelsDir: "~/llm/models", ramBudgetBytes: 0, defaultArgs: [],
      perModel: { "gemma-4-12B-it-4bit": { args: ["--kv-quant", "8"] }, "unknown-dir": { args: ["--x"] } },
      ds4: { enabled: false, binaryPath: "ds4-server", modelsDir: "~/ds4/gguf", defaultArgs: [], perModel: {} },
    } as never);
    const cfg = out.models.find((m) => m.modelId === "gemma-4-12B-it-4bit");
    expect(cfg).toBeDefined();
    expect(cfg!.providerId).toBe("mlx-serve");
    expect(cfg!.argsOverride).toEqual(["--kv-quant 8"]);
    expect(out.models.some((m) => m.modelId === "unknown-dir")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/contracts && vp test run src/localLlmMigration.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the migration**

```ts
// packages/contracts/src/localLlmMigration.ts
import { LOCAL_LLM_MODELS } from "@t3tools/shared/localLlm";
import type { LocalModelsSettings } from "./settings.ts";
import type { LocalLlmModelConfig, LocalLlmSettings } from "./settings.ts";

// Re-group a flat ["--flag","val"] token array into ["--flag val"] grouped tokens.
function groupArgs(flat: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < flat.length; i++) {
    const tok = flat[i];
    if (tok.startsWith("-") && i + 1 < flat.length && !flat[i + 1].startsWith("-")) {
      out.push(`${tok} ${flat[i + 1]}`); i++;
    } else out.push(tok);
  }
  return out;
}

export function migrateLocalModels(legacy: LocalModelsSettings): LocalLlmSettings {
  const byResource = new Map(LOCAL_LLM_MODELS.map((m) => [m.resourceName, m]));
  const models: LocalLlmModelConfig[] = [];
  let n = 0;
  for (const [key, v] of Object.entries(legacy.perModel ?? {})) {
    const m = byResource.get(key);
    if (!m) continue; // non-catalog keys dropped
    models.push({
      id: `mig-${++n}`, name: m.name, providerId: m.ds4Only ? "ds4" : "mlx-serve",
      modelId: m.id, contextWindow: m.maxContext, visible: true,
      argsOverride: v.args ? groupArgs(v.args) : undefined,
    });
  }
  return {
    ramBudgetBytes: legacy.ramBudgetBytes ?? 0,
    providers: {
      "mlx-serve": {
        visible: true,
        modelsDir: legacy.modelsDir,
        defaultArgs: legacy.defaultArgs ? groupArgs(legacy.defaultArgs) : undefined,
      },
      ds4: {
        visible: legacy.ds4?.enabled ?? false,
        binaryPath: legacy.ds4?.binaryPath,
        modelsDir: legacy.ds4?.modelsDir,
        defaultArgs: legacy.ds4?.defaultArgs ? groupArgs(legacy.ds4.defaultArgs) : undefined,
      },
    } as LocalLlmSettings["providers"],
    models,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/contracts && vp test run src/localLlmMigration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire migration into server settings load**

In `apps/server/src/serverSettings.ts`, after settings are decoded to `ServerSettings`, if `settings.localLlm.models.length === 0 && Object.keys(settings.localLlm.providers).length === 0` and the legacy `settings.localModels` is meaningfully populated (non-default `modelsDir`/`perModel`/`ds4.enabled`), set `settings.localLlm = migrateLocalModels(settings.localModels)`. Keep this idempotent (only when `localLlm` is empty). Add a unit test alongside existing serverSettings tests asserting the wiring (decode a legacy blob → `localLlm` populated). Use the existing test file pattern in that directory.

- [ ] **Step 6: Run the server settings test**

Run: `cd apps/server && vp test run src/serverSettings.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/localLlmMigration.ts packages/contracts/src/localLlmMigration.test.ts apps/server/src/serverSettings.ts apps/server/src/serverSettings.test.ts
git commit -m "feat(contracts): migrate legacy localModels into localLlm"
```

---

### Task 4: RPC contract — load/unload by configId; sample fields

**Files:**
- Modify: `packages/contracts/src/rpc.ts` (`LlmModel` ~669-706 add `configId`/`configName`; `WsLlmServeLoadRpc`/`WsLlmServeUnloadRpc` ~755-766 payloads; `LlmServeError` kinds ~738-752 add `"external_not_managed"`)
- Test: `packages/contracts/src/rpc.localLlm.test.ts`

**Interfaces:**
- Produces:
  - `LlmModel.configId?: string`, `LlmModel.configName?: string`
  - `WsLlmServeLoadRpc` payload `{ configId: string }`
  - `WsLlmServeUnloadRpc` payload `{ configId: string }`
  - `LlmServeError.kind` includes `"external_not_managed"`

- [ ] **Step 1: Write the failing test**

```ts
// packages/contracts/src/rpc.localLlm.test.ts
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { LlmModel, WsLlmServeLoadRpc, WsLlmServeUnloadRpc } from "./rpc.ts";

describe("local llm rpc", () => {
  it("LlmModel carries configId/configName", () => {
    const m = Schema.decodeUnknownSync(LlmModel)({ id: "x", loaded: false, configId: "c1", configName: "Fast" });
    expect(m.configId).toBe("c1");
    expect(m.configName).toBe("Fast");
  });
  it("load/unload payloads use configId", () => {
    const load = Schema.decodeUnknownSync(WsLlmServeLoadRpc.payloadSchema)({ configId: "c1" });
    expect(load.configId).toBe("c1");
    const unload = Schema.decodeUnknownSync(WsLlmServeUnloadRpc.payloadSchema)({ configId: "c1" });
    expect(unload.configId).toBe("c1");
  });
});
```

> If `Rpc.make` doesn't expose `payloadSchema` in this effect version, assert against the local `Schema.Struct({ configId: Schema.String })` you define and pass to `Rpc.make` (export it as `LlmServeLoadPayload` and test that). Adjust import accordingly.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/contracts && vp test run src/rpc.localLlm.test.ts`
Expected: FAIL.

- [ ] **Step 3: Edit the contracts**

Add `configId`/`configName` optionals to `LlmModel`. Change both RPC payloads from `{ modelId }`/`{ pid }` to `{ configId: Schema.String }` (export named payload structs `LlmServeLoadPayload`, `LlmServeUnloadPayload` and pass them to `Rpc.make`). Add `"external_not_managed"` to the `LlmServeError.kind` literals.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/contracts && vp test run src/rpc.localLlm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/rpc.ts packages/contracts/src/rpc.localLlm.test.ts
git commit -m "feat(contracts): local-LLM RPCs address models by configId"
```

---

### Task 5: Server — config→spawn resolution helpers (pure)

**Files:**
- Create: `apps/server/src/llm/resolveLaunch.ts`
- Test: `apps/server/src/llm/resolveLaunch.test.ts`

**Interfaces:**
- Consumes: catalog (`getProvider`, `getModel`); settings types (`LocalLlmSettings`, `LocalLlmModelConfig`, `LocalLlmProviderConfig`); existing `expandTilde` from the server (import the same helper `LlmServeManager` currently uses).
- Produces:
  - `resolveProvider(catalogId, settings): ResolvedProvider | null` — merges catalog defaults with `settings.providers[catalogId]` overrides; `{ id, managed, host, port, binaryPath, modelsDir, cwdFromBinary, defaultArgs, baseUrl }`.
  - `resolveLaunch(config: LocalLlmModelConfig, settings): ResolvedLaunch | { error: string }` — produces `{ executable, args, cwd, host, port, modelPath, estBytes, engineId }` for managed providers; returns `{ error }` for external providers or unknown ids.
  - Engine arg builders: mlx → `["--serve", ...defaultArgs/override, "--host", host, "--port", port, "--model", modelPath]`; ds4 → `[...args, "--host", host, "--port", port, "-m", modelPath]`. `cwd = cwdFromBinary && binaryPath looks path-shaped ? dirname(expandTilde(binaryPath)) : undefined`.
  - `splitGroupedArgs(args: readonly string[]): string[]` — splits `"--flag val"` grouped tokens back into `["--flag","val"]` for spawn (single-space split, max 2).

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/llm/resolveLaunch.test.ts
import { describe, expect, it } from "vitest";
import { resolveLaunch, splitGroupedArgs } from "./resolveLaunch.ts";

const base = { ramBudgetBytes: 0, providers: {}, models: [] };

describe("resolveLaunch", () => {
  it("builds mlx-serve args with grouped defaultArgs split and model path joined", () => {
    const cfg = { id: "c1", name: "Fast", providerId: "mlx-serve", modelId: "Qwen3.6-35B-A3B-4bit",
      visible: true, port: 8765, contextWindow: 65536 } as never;
    const r = resolveLaunch(cfg, { ...base, providers: { "mlx-serve": { visible: true, modelsDir: "/models" } } } as never);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.executable).toBe("mlx-serve");
    expect(r.modelPath).toBe("/models/Qwen3.6-35B-A3B-4bit");
    expect(r.args).toEqual(["--serve", "--reasoning-budget", "0", "--host", "127.0.0.1", "--port", "8765", "--model", "/models/Qwen3.6-35B-A3B-4bit"]);
    expect(r.cwd).toBeUndefined();
  });

  it("uses contextWindow as --ctx-size when no explicit override given", () => {
    // (only if spec opts the slider into --ctx-size — see Task note; assert it is appended)
  });

  it("ds4 builds -m and a cwd pinned to the binary dir", () => {
    const cfg = { id: "c2", name: "DS", providerId: "ds4", modelId: "deepseek-v4-flash", visible: true, port: 8000 } as never;
    const r = resolveLaunch(cfg, { ...base, providers: { ds4: { visible: true, binaryPath: "/opt/ds4/ds4-server", modelsDir: "/g" } } } as never);
    if ("error" in r) throw new Error(r.error);
    expect(r.executable).toBe("/opt/ds4/ds4-server");
    expect(r.modelPath).toBe("/g/ds4flash.gguf");
    expect(r.args).toEqual(["--host", "127.0.0.1", "--port", "8000", "-m", "/g/ds4flash.gguf"]);
    expect(r.cwd).toBe("/opt/ds4");
  });

  it("returns an error for an external provider", () => {
    const cfg = { id: "c3", name: "L", providerId: "llamacpp", modelId: "gemma-4-12B-it-4bit", visible: true } as never;
    const r = resolveLaunch(cfg, base as never);
    expect("error" in r && r.error).toMatch(/external/i);
  });

  it("splitGroupedArgs splits flag+value but leaves bare flags", () => {
    expect(splitGroupedArgs(["--reasoning-budget 0", "--no-pld"])).toEqual(["--reasoning-budget", "0", "--no-pld"]);
  });
});
```

> **Slider vs --ctx-size:** Per spec note, the context slider owns `--ctx-size` (mlx) / `--ctx` (ds4). In `resolveLaunch`, if `config.contextWindow` is set and the override args do not already contain that flag, append it (`--ctx-size <n>` for mlx, `--ctx <n>` for ds4). Add an explicit test asserting this once the rule is implemented; remove the empty placeholder test above.

- [ ] **Step 2: Run test to verify it fails** — `cd apps/server && vp test run src/llm/resolveLaunch.test.ts` → FAIL.
- [ ] **Step 3: Implement `resolveLaunch.ts`** per the Interfaces + slider rule. Pure functions only; no fs except none (path joins via `node:path`).
- [ ] **Step 4: Run test to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/llm/resolveLaunch.ts apps/server/src/llm/resolveLaunch.test.ts
git commit -m "feat(server): pure config->launch resolution for local LLM configs"
```

---

### Task 6: Server — port assignment + RAM budget helpers

**Files:**
- Create: `apps/server/src/llm/portBudget.ts`
- Test: `apps/server/src/llm/portBudget.test.ts`

**Interfaces:**
- Produces:
  - `providerPortRange(catalogId): { min: number; max: number }` — `{ defaultPort, defaultPort+34 }`.
  - `assignPort(catalogId, taken: ReadonlySet<number>): number | null` — first free in range.
  - `budgetBytes(ramBudgetBytes: number, totalMem: number): number` — `>0 ? value : floor(0.8*totalMem)`.
  - `fits(estBytes, onlineRss, inflight, budget): boolean` — `onlineRss + inflight + estBytes <= budget`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/llm/portBudget.test.ts
import { describe, expect, it } from "vitest";
import { assignPort, budgetBytes, fits, providerPortRange } from "./portBudget.ts";

describe("portBudget", () => {
  it("mlx range starts at 8765", () => expect(providerPortRange("mlx-serve")).toEqual({ min: 8765, max: 8799 }));
  it("assigns first free port", () => expect(assignPort("mlx-serve", new Set([8765, 8766]))).toBe(8767));
  it("returns null when range is full", () => {
    const full = new Set(Array.from({ length: 35 }, (_, i) => 8765 + i));
    expect(assignPort("mlx-serve", full)).toBeNull();
  });
  it("budget falls back to 80% of total memory", () => expect(budgetBytes(0, 1000)).toBe(800));
  it("fits respects the budget", () => {
    expect(fits(100, 500, 100, 800)).toBe(true);
    expect(fits(300, 500, 100, 800)).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** (`cd apps/server && vp test run src/llm/portBudget.test.ts`)
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/llm/portBudget.ts apps/server/src/llm/portBudget.test.ts
git commit -m "feat(server): port-assignment + RAM-budget helpers for local LLM"
```

---

### Task 7: Server — `LlmServeManager` refactor (config-driven, mocked spawner)

**Files:**
- Modify: `apps/server/src/llm/LlmServeManager.ts` (replace ps-scan/dir-discovery enumeration with config-driven load/unload + status; remove `matchMlxRow`/`matchDs4Row`/`discover`/`estimateDirBytes` enumeration paths; keep spawn/scope/supervisor/semaphore)
- Modify: `apps/server/src/diagnostics/LlmModels.ts` (sample now built from `localLlm.models` + per-config probe + registry)
- Test: `apps/server/src/llm/LlmServeManager.test.ts` (spawner + probe + settings all mocked — **never spawns**)

**Interfaces:**
- Consumes: `resolveLaunch`/`resolveProvider` (Task 5), `assignPort`/`budgetBytes`/`fits` (Task 6), `probeProvider` (existing), `LocalLlmSettings`.
- Produces (manager service surface):
  - `load(configId: string): Effect<{ pid; port }, LlmServeError | EnvironmentAuthorizationError>`
  - `unload(configId: string): Effect<{ ok: true }, LlmServeError | ...>`
  - `list(): Effect<LlmModelsSample>` — for each `localLlm.models` entry: resolve target; probe (managed: config.port; external: provider baseUrl/port); status from registry + probe; group by provider.

- [ ] **Step 1: Write the failing test** — inject a fake spawner (returns a handle with a controllable pid/exit) and a fake probe (returns reachable/models per port). Assert:
  - `load("c1")` on a managed config calls the spawner with the exact `resolveLaunch` args, registers it, returns `{ pid, port }`.
  - `load` on an external-provider config fails with `LlmServeError.kind === "external_not_managed"` and **does not** call the spawner.
  - `load` refused with `"budget_exceeded"` when `fits` is false (assert spawner not called).
  - `list()` reports a config `online` when its port probes reachable, `offline` otherwise, `loading` while registered-but-not-yet-reachable.
  - `unload("c1")` closes the scope / kills the registered process and returns `{ ok: true }`.

  Provide the fakes via the manager's existing dependency seams (the `ChildProcessSpawner` service and `HttpClient`); construct the layer in-test with mocks. Model the test on the existing `LlmServeManager` test if present; otherwise add a new Effect test using `@effect/vitest`.

- [ ] **Step 2: Run → FAIL.** (`cd apps/server && vp test run src/llm/LlmServeManager.test.ts`)
- [ ] **Step 3: Implement the refactor.** Remove enumeration of external processes and filesystem discovery; loadable set = `settings.localLlm.models`. Status from registry + per-config probe. Keep loopback, detached groups, scope reaping, supervisor fiber, load semaphore, and the resolved-path `realpath` confinement guard from the old code.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/llm/LlmServeManager.ts apps/server/src/diagnostics/LlmModels.ts apps/server/src/llm/LlmServeManager.test.ts
git commit -m "feat(server): drive LlmServeManager from model configs, drop auto-detect"
```

---

### Task 8: Server — WS wiring for new payloads

**Files:**
- Modify: `apps/server/src/ws.ts` (~1501-1514 handlers: `llmServeLoad`/`llmServeUnload` now take `{ configId }`)
- Test: covered by Task 7 manager tests + a thin ws handler test if the file has an existing pattern; otherwise assert handler delegates via a manager mock.

- [ ] **Step 1:** Update the two handlers to pass `input.configId` to `manager.load`/`manager.unload`. Keep auth scopes (`AuthOrchestrationOperateScope`).
- [ ] **Step 2:** Run the server package unit tests touching ws if present: `cd apps/server && vp test run src/ws.test.ts` (skip if no such test). Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add apps/server/src/ws.ts
git commit -m "feat(server): ws load/unload handlers take configId"
```

---

### Task 9: Web — `ArgPickerMenu` component + logic

**Files:**
- Create: `apps/web/src/components/llm/ArgPickerMenu.tsx`
- Create: `apps/web/src/components/llm/argPicker.logic.ts`
- Test: `apps/web/src/components/llm/argPicker.logic.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_ARG_SPECS`, `ArgSpec` (Task 1).
- Produces:
  - `argPicker.logic.ts`: `buildArg(spec: ArgSpec, value?: string): string` (flag→`"--x"`, value→`"--x val"`); `filterSpecs(specs, query): ArgSpec[]`; `addArg(list, str): string[]`; `removeArg(list, index): string[]`.
  - `ArgPickerMenu` props: `{ providerId: string; value: readonly string[]; onChange: (next: string[]) => void }` — renders chips + a “＋ arg” popover (flag list, filter box, enum buttons / number+string inputs), calling `onChange` via the logic helpers.

- [ ] **Step 1: Write the failing logic test**

```ts
// apps/web/src/components/llm/argPicker.logic.test.ts
import { describe, expect, it } from "vitest";
import { addArg, buildArg, filterSpecs, removeArg } from "./argPicker.logic.ts";

describe("argPicker.logic", () => {
  it("builds flag and value args", () => {
    expect(buildArg({ flag: "--no-pld", type: "flag" })).toBe("--no-pld");
    expect(buildArg({ flag: "--kv-quant", type: "enum", values: ["8"] }, "8")).toBe("--kv-quant 8");
  });
  it("filters specs by flag and description", () => {
    const specs = [{ flag: "--ctx-size", type: "number" as const, desc: "context" }, { flag: "--temp", type: "number" as const }];
    expect(filterSpecs(specs, "ctx").map((s) => s.flag)).toEqual(["--ctx-size"]);
    expect(filterSpecs(specs, "context").map((s) => s.flag)).toEqual(["--ctx-size"]);
  });
  it("adds and removes", () => {
    expect(addArg(["--a"], "--b")).toEqual(["--a", "--b"]);
    expect(removeArg(["--a", "--b"], 0)).toEqual(["--b"]);
  });
});
```

- [ ] **Step 2: Run → FAIL.** (`cd apps/web && vp test run --project unit src/components/llm/argPicker.logic.test.ts`)
- [ ] **Step 3:** Implement `argPicker.logic.ts`, then `ArgPickerMenu.tsx` (follow the prototype's popover behavior; use existing UI primitives — Popover/DropdownMenu — from `apps/web/src/components/ui`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/llm/ArgPickerMenu.tsx apps/web/src/components/llm/argPicker.logic.ts apps/web/src/components/llm/argPicker.logic.test.ts
git commit -m "feat(web): CLI-flag arg picker menu for local LLM args"
```

---

### Task 10: Web — model-config logic (compatibility, defaults, ctx clamp)

**Files:**
- Create: `apps/web/src/components/settings/localLlm/modelConfig.logic.ts`
- Test: `apps/web/src/components/settings/localLlm/modelConfig.logic.test.ts`

**Interfaces:**
- Consumes: catalog (`compatibleModels`, `getModel`, `getProvider`, `LOCAL_LLM_PROVIDERS`), settings types.
- Produces:
  - `visibleProviders(settings): ProviderCatalogEntry[]` (visible OR referenced by a config).
  - `newModelConfig(settings): LocalLlmModelConfig` — pick first visible provider, first compatible model, default name/ctx/port (uses `assignPort`-equivalent purely: first free in range given existing config ports).
  - `onProviderChange(cfg, providerId): LocalLlmModelConfig` — reset model to first compatible, clamp ctx to model max.
  - `onModelChange(cfg, modelId): LocalLlmModelConfig` — clamp ctx to new model max.
  - `clampContext(value, modelId): number`.

- [ ] **Step 1: Write the failing test** — assert: compatible-model reset on provider change; ctx clamp to model `maxContext`; `newModelConfig` chooses a free port not colliding with existing config ports; hidden provider still listed if referenced.
- [ ] **Step 2: Run → FAIL.** (`cd apps/web && vp test run --project unit src/components/settings/localLlm/modelConfig.logic.test.ts`)
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/localLlm/modelConfig.logic.ts apps/web/src/components/settings/localLlm/modelConfig.logic.test.ts
git commit -m "feat(web): model-config logic (compatibility, ctx clamp, port assign)"
```

---

### Task 11: Web — merged "Local LLM" settings tab (providers + model configs)

**Files:**
- Create: `apps/web/src/components/settings/localLlm/LocalLlmSettings.tsx` (panel: `LocalLlmProvidersSection` + `LocalLlmModelConfigsSection`)
- Create: `apps/web/src/routes/settings.local-llm.tsx` (lazy route, mirrors `settings.local-models.tsx`)
- Modify: `apps/web/src/components/settings/SettingsSidebarNav.tsx` (replace the "Local Models" item with "Local LLM" → `/settings/local-llm`, `CpuIcon`)
- Delete: `apps/web/src/routes/settings.local-models.tsx`, `apps/web/src/components/settings/LocalModelsSettings.tsx` (+ its `.logic.ts`/tests) — the raw editor is replaced
- Test: rendering smoke via existing settings test harness if present; logic is already covered by Task 10. (No new browser test this phase.)

**Interfaces:**
- Consumes: `useSettings`/`useUpdateSettings` (existing), catalog, `ArgPickerMenu` (Task 9), `modelConfig.logic` (Task 10), shared eye-icon presentation.
- Produces: `LocalLlmSettingsPanel` exported for the route.

- [ ] **Step 1:** Implement the two sections per spec §5 and the prototype (eye-icon visibility via the existing icon set; provider override fields; model-config cards with provider→model selects, context slider, Advanced accordion with `ArgPickerMenu` + port/path overrides). Persist via `updateSettings({ localLlm: { ...lm, ... } })` (whole-object). Reuse `modelPresentation.tsx` for status dots if needed.
- [ ] **Step 2:** Update `SettingsSidebarNav` and add the route; remove the old route/component/tests.
- [ ] **Step 3:** Typecheck the web package without a full build: `cd apps/web && vp run typecheck`. Expected: no errors. *(typecheck only — not a build.)*
- [ ] **Step 4:** Run web unit tests: `cd apps/web && vp test run --project unit`. Expected: PASS (no references to deleted modules remain).
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/localLlm apps/web/src/routes/settings.local-llm.tsx apps/web/src/components/settings/SettingsSidebarNav.tsx
git add -u   # stage deletions of old local-models files
git commit -m "feat(web): merged Local LLM settings tab (providers + model configs)"
```

---

### Task 12: Web — sidebar sourced from model configs

**Files:**
- Modify: `apps/web/src/components/sidebar/SidebarLocalModels.tsx` (rows from `localLlm.models` joined with live `LlmModelsSample`; click load/unload by `configId`; external rows non-loadable with tooltip)
- Modify: `apps/web/src/hooks/useLlmModels.ts` (`load`/`unload` actions take `configId`)
- Modify: `apps/web/src/lib/llmModels.ts` if needed (status derivation by config)
- Test: `apps/web/src/components/sidebar/sidebarLocalModels.logic.test.ts` (extract a pure `mergeConfigsWithSample(models, sample)` → rows with status; test online/offline/loading/hidden filtering)

**Interfaces:**
- Consumes: `useSettings` (`localLlm.models`), `useLlmModels` sample, `getProvider`/`getModel`.
- Produces: `mergeConfigsWithSample(models, sample): SidebarRow[]` and updated actions `load(configId)`/`unload(configId)`.

- [ ] **Step 1: Write the failing logic test** for `mergeConfigsWithSample` (visible configs only; status from sample by `configId`; external provider → `loadable: false`).
- [ ] **Step 2: Run → FAIL.** (`cd apps/web && vp test run --project unit src/components/sidebar/sidebarLocalModels.logic.test.ts`)
- [ ] **Step 3: Implement** the merge logic + wire the component and hook actions to `configId`.
- [ ] **Step 4: Run → PASS**, then `cd apps/web && vp run typecheck` (no build).
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/sidebar/SidebarLocalModels.tsx apps/web/src/hooks/useLlmModels.ts apps/web/src/lib/llmModels.ts apps/web/src/components/sidebar/sidebarLocalModels.logic.test.ts
git commit -m "feat(web): sidebar local models sourced from model configs"
```

---

### Task 13: Web — Providers tab env-var presets

**Files:**
- Create: `apps/web/src/components/settings/providers/localLlmPreset.logic.ts`
- Create: `apps/web/src/components/settings/providers/PresetDialog.tsx`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx` (`ProviderSettingsPanel` ~1132-1149: add a `Presets` button beside `+ Add`, open `PresetDialog`)
- Test: `apps/web/src/components/settings/providers/localLlmPreset.logic.test.ts`

**Interfaces:**
- Consumes: catalog (`getProvider`, `getModel`), `localLlm.models`, `ProviderInstanceEnvironmentVariable` type, `ProviderDriverKind`.
- Produces:
  - `presetEnv(config, driverKind): ProviderInstanceEnvironmentVariable[]` — driver-aware names via `DRIVER_ENV_NAMES: Record<string, { baseUrl: string; apiKey: string; model: string }>` (default/codex → `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`CODEX_MODEL`; claude → `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`; fall back to the OPENAI names). Base URL = `http://${host}:${port}/v1` from resolved provider; api key value `"local"` (sensitive); model = `config.modelId`.
  - `mergeEnv(existing, preset): { merged; added; overridden }` — preset wins on name conflict; classify each row.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/components/settings/providers/localLlmPreset.logic.test.ts
import { describe, expect, it } from "vitest";
import { mergeEnv, presetEnv } from "./localLlmPreset.logic.ts";

const cfg = { id: "c1", name: "Fast", providerId: "mlx-serve", modelId: "Qwen3.6-35B-A3B-4bit", visible: true, port: 8765 } as never;

describe("localLlmPreset", () => {
  it("produces OpenAI-style vars for codex driver", () => {
    const env = presetEnv(cfg, "codex" as never);
    const byName = Object.fromEntries(env.map((e) => [e.name, e.value]));
    expect(byName.OPENAI_BASE_URL).toBe("http://127.0.0.1:8765/v1");
    expect(byName.CODEX_MODEL).toBe("Qwen3.6-35B-A3B-4bit");
  });
  it("merge: preset wins on conflict and flags rows", () => {
    const existing = [{ name: "OPENAI_API_KEY", value: "old", sensitive: true }, { name: "KEEP", value: "x", sensitive: false }];
    const preset = [{ name: "OPENAI_API_KEY", value: "local", sensitive: true }, { name: "OPENAI_BASE_URL", value: "u", sensitive: false }];
    const r = mergeEnv(existing as never, preset as never);
    expect(r.merged.find((e) => e.name === "OPENAI_API_KEY")!.value).toBe("local");
    expect(r.merged.some((e) => e.name === "KEEP")).toBe(true);
    expect(r.overridden).toContain("OPENAI_API_KEY");
    expect(r.added).toContain("OPENAI_BASE_URL");
  });
});
```

- [ ] **Step 2: Run → FAIL.** (`cd apps/web && vp test run --project unit src/components/settings/providers/localLlmPreset.logic.test.ts`)
- [ ] **Step 3: Implement** the logic, then `PresetDialog.tsx` (pick a model config → preview merged env with added/override highlights → apply, writing the instance's `environment` via the existing provider-instance update path), then add the `Presets` button.
- [ ] **Step 4: Run → PASS**, then `cd apps/web && vp run typecheck` (no build).
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/providers apps/web/src/components/settings/SettingsPanels.tsx
git commit -m "feat(web): Providers tab env-var presets from local LLM model configs"
```

---

### Task 14: Cleanup sweep + per-package unit suites

**Files:** repo-wide (no new feature code)

- [ ] **Step 1:** Grep for dangling references to removed symbols: `localModels` UI editor, `modelId` RPC payloads, `matchMlxRow`, filesystem-discovery helpers. Fix imports/usages. Run:
  `rg -n "settings/LocalModelsSettings|llmServe.*modelId|matchMlxRow|matchDs4Row" apps packages`
- [ ] **Step 2:** Run each touched package's unit suite (NOT a build, NOT browser):
  - `cd packages/shared && vp test run`
  - `cd packages/contracts && vp test run`
  - `cd apps/server && vp test run`
  - `cd apps/web && vp test run --project unit`
  Expected: all PASS.
- [ ] **Step 3:** Typecheck touched packages: `cd packages/contracts && vp run typecheck`, then shared/server/web the same way. Expected: clean.
- [ ] **Step 4: Commit** any fixups.

```bash
git add -A
git commit -m "chore(llm): resolve dangling refs after local LLM overhaul"
```

- [ ] **Step 5: STOP.** Do not run `pnpm verify`/build, browser tests, or any real model-load. Report status and wait for the user's explicit signal before those steps.

---

## Self-Review

**Spec coverage:**
- Build-time catalog (decision 1, 2) → Task 1. ✔
- New settings model + clean redesign (decision 4) → Tasks 2, 11. ✔
- Migration (decision 4) → Task 3. ✔
- Managed = mlx+ds4 (decision 3), drop auto-detect → Tasks 5, 7. ✔
- Merged tab (decision 5) → Task 11. ✔
- Eye-icon visibility (decision 6) → Tasks 11, 12. ✔
- CLI-flag arg picker (decision 7) → Task 9. ✔
- Context slider owns --ctx-size → Tasks 5 (resolve), 10/11 (UI). ✔
- Sidebar from configs (req 4) → Task 12. ✔
- Providers presets (req 3) → Task 13. ✔
- RPC by configId → Tasks 4, 8. ✔

**Placeholder scan:** One intentional placeholder test in Task 5 is explicitly flagged for removal/replacement by the slider rule — not a silent gap. No other TBDs.

**Type consistency:** `LocalLlmModelConfig`/`LocalLlmProviderConfig`/`LocalLlmSettings` names match across Tasks 2/3/5/7/10–13. `configId` payloads consistent across Tasks 4/7/8/12. `resolveLaunch`/`resolveProvider`/`splitGroupedArgs` names match across Tasks 5/7. `presetEnv`/`mergeEnv` match across Task 13.
