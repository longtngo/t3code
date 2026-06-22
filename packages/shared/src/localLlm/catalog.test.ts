import { describe, expect, it } from "vite-plus/test";
import {
  LOCAL_LLM_MODELS,
  LOCAL_LLM_PROVIDERS,
  PROVIDER_ARG_SPECS,
  compatibleModels,
  getModel,
  getProvider,
} from "./index.ts";

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
