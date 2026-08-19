import { describe, expect, it } from "vite-plus/test";
import { LOCAL_LLM_MODELS, LOCAL_LLM_PROVIDERS, compatibleModels, getModel } from "./index.ts";

describe("local llm catalog", () => {
  it("has unique provider and model ids", () => {
    const pids = LOCAL_LLM_PROVIDERS.map((p) => p.id);
    expect(new Set(pids).size).toBe(pids.length);
    const mids = LOCAL_LLM_MODELS.map((m) => m.id);
    expect(new Set(mids).size).toBe(mids.length);
  });

  it("marks only mlx-serve as managed", () => {
    const managed = LOCAL_LLM_PROVIDERS.filter((p) => p.managed)
      .map((p) => p.id)
      .sort();
    expect(managed).toEqual(["mlx-serve"]);
  });

  // ds4 and its GGUF were retired and deleted from the machine. Left in the catalog they are
  // dead dropdown entries that resolve to a binary and a file nobody has.
  it("no longer carries the retired ds4 engine or its model", () => {
    expect(LOCAL_LLM_PROVIDERS.some((p) => p.id === "ds4")).toBe(false);
    expect(getModel("deepseek-v4-flash")).toBeUndefined();
  });

  it("every model format has at least one provider", () => {
    for (const m of LOCAL_LLM_MODELS) {
      expect(LOCAL_LLM_PROVIDERS.some((p) => p.format === m.format)).toBe(true);
    }
  });

  it("compatibleModels matches on format", () => {
    const mlx = compatibleModels("mlx-serve").map((m) => m.id);
    expect(mlx).toContain("Qwen3.6-35B-A3B-4bit");
    // Every catalog model is mlx today, so assert the filter by its negative too: an unknown
    // provider yields nothing, and a gguf provider finds no mlx model.
    expect(compatibleModels("llamacpp")).toEqual([]);
    expect(compatibleModels("nope")).toEqual([]);
  });

  // The catalog is hand-curated and its numbers are what the config UI presents as the model's
  // real limits, so a typo here silently mis-sizes a slider. These are the measured values from
  // the model's own config.json on disk (max_position_embeddings, quantization.bits, no expert
  // keys) rather than anything inferred from its name.
  it("carries Qwen3.8 27B with the values read off the model itself", () => {
    const qwen38 = getModel("Qwen3.8-27B-MLX-Serve-4bit");
    expect(qwen38).toBeDefined();
    expect(qwen38?.resourceName).toBe("Qwen3.8-27B-MLX-Serve-4bit");
    expect(qwen38?.maxContext).toBe(262144);
    expect(qwen38?.quant).toBe("4-bit");
    // Dense, unlike its 35B A3B sibling — the config has no expert keys at all.
    expect(qwen38?.moe).toBe(false);
    expect(compatibleModels("mlx-serve").map((m) => m.id)).toContain("Qwen3.8-27B-MLX-Serve-4bit");
    // The flag it cannot perform without; see resolveLaunch for how it layers on the provider's.
    expect(qwen38?.defaultArgs).toEqual(["--mtp-depth 2"]);
  });

  it("managed model resources resolve to a non-empty resourceName", () => {
    for (const m of LOCAL_LLM_MODELS) expect(m.resourceName.length).toBeGreaterThan(0);
    expect(getModel("Qwen3.6-35B-A3B-4bit")?.resourceName).toBe("Qwen3.6-35B-A3B-4bit");
  });
});
