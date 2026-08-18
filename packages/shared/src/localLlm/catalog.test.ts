import { describe, expect, it } from "vite-plus/test";
import { LOCAL_LLM_MODELS, LOCAL_LLM_PROVIDERS, compatibleModels, getModel } from "./index.ts";

describe("local llm catalog", () => {
  it("has unique provider and model ids", () => {
    const pids = LOCAL_LLM_PROVIDERS.map((p) => p.id);
    expect(new Set(pids).size).toBe(pids.length);
    const mids = LOCAL_LLM_MODELS.map((m) => m.id);
    expect(new Set(mids).size).toBe(mids.length);
  });

  it("marks only mlx-serve and ds4 as managed", () => {
    const managed = LOCAL_LLM_PROVIDERS.filter((p) => p.managed)
      .map((p) => p.id)
      .sort();
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
  });

  it("managed model resources resolve to a non-empty resourceName", () => {
    for (const m of LOCAL_LLM_MODELS) expect(m.resourceName.length).toBeGreaterThan(0);
    expect(getModel("deepseek-v4-flash")?.resourceName).toBe("ds4flash.gguf");
  });
});
