import type { LocalLlmSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { LOCAL_LLM_PROVIDERS, compatibleModels } from "@t3tools/shared/localLlm";
import {
  clampContext,
  newModelConfig,
  onModelChange,
  onProviderChange,
  visibleProviders,
} from "./modelConfig.logic.ts";

const settings = (over: Partial<LocalLlmSettings> = {}): LocalLlmSettings =>
  ({ ramBudgetBytes: 0, providers: {}, models: [], ...over }) as never;

describe("visibleProviders", () => {
  it("hides a provider toggled off, but keeps the current one", () => {
    const s = settings({ providers: { "mlx-serve": { visible: false } } as never });
    expect(visibleProviders(s).some((p) => p.id === "mlx-serve")).toBe(false);
    expect(visibleProviders(s, "mlx-serve").some((p) => p.id === "mlx-serve")).toBe(true);
  });
});

describe("clampContext", () => {
  it("clamps to the model max", () => {
    expect(clampContext(999999, "gemma-4-12B-it-4bit")).toBe(131072);
    expect(clampContext(32768, "gemma-4-12B-it-4bit")).toBe(32768);
  });
});

describe("newModelConfig", () => {
  it("picks the first visible provider + compatible model and a free port", () => {
    const cfg = newModelConfig(settings());
    expect(cfg.providerId).toBe("mlx-serve");
    expect(cfg.modelId).toBe("Qwen3.6-35B-A3B-4bit");
    expect(cfg.port).toBe(8765);
    expect(cfg.visible).toBe(true);
  });

  it("avoids colliding with an existing config port", () => {
    const cfg = newModelConfig(
      settings({
        models: [
          { id: "a", name: "A", providerId: "mlx-serve", modelId: "x", visible: true, port: 8765 },
        ] as never,
      }),
    );
    expect(cfg.port).toBe(8766);
  });

  it("generates a unique id when the model id is already used", () => {
    const cfg = newModelConfig(
      settings({
        models: [
          {
            id: "qwen3.6-35b-a3b-4bit",
            name: "A",
            providerId: "mlx-serve",
            modelId: "x",
            visible: true,
          },
        ] as never,
      }),
    );
    expect(cfg.id).not.toBe("qwen3.6-35b-a3b-4bit");
  });
});

describe("onProviderChange / onModelChange", () => {
  it("resets to a compatible model and clamps ctx on provider change", () => {
    const start = {
      id: "c1",
      name: "C",
      providerId: "mlx-serve",
      modelId: "Qwen3.6-35B-A3B-4bit",
      visible: true,
      contextWindow: 163840,
    } as never;
    const next = onProviderChange(start, "ds4");
    expect(next.providerId).toBe("ds4");
    expect(next.modelId).toBe("deepseek-v4-flash");
    expect(next.contextWindow).toBe(163840); // ds4 model max
  });

  it("clamps ctx when switching to a smaller model", () => {
    const start = {
      id: "c1",
      name: "C",
      providerId: "mlx-serve",
      modelId: "Qwen3.6-35B-A3B-4bit",
      visible: true,
      contextWindow: 163840,
    } as never;
    const next = onModelChange(start, "gemma-4-12B-it-4bit");
    expect(next.contextWindow).toBe(131072);
  });
});

describe("providers with no compatible model", () => {
  const empty = settings();

  it("keeps a provider the catalog has no model for out of the picker", () => {
    // vllm is `format: "safetensors"` and the model catalog carries only mlx/gguf, so
    // offering it can only produce `modelId: ""` — which the contract rejects, taking the
    // entire localLlm patch down with it.
    const ids = visibleProviders(empty).map((p) => p.id);
    for (const id of ids) {
      expect(compatibleModels(id).length).toBeGreaterThan(0);
    }
  });

  it("still lists the provider a config is already on", () => {
    const withNone = LOCAL_LLM_PROVIDERS.find((p) => compatibleModels(p.id).length === 0);
    if (!withNone) return;
    expect(visibleProviders(empty, withNone.id).some((p) => p.id === withNone.id)).toBe(true);
  });

  it("refuses to switch to a provider that would produce an empty modelId", () => {
    const withNone = LOCAL_LLM_PROVIDERS.find((p) => compatibleModels(p.id).length === 0);
    if (!withNone) return;
    const start = newModelConfig(empty);
    expect(onProviderChange(start, withNone.id)).toEqual(start);
  });

  it("never builds a fresh config with an empty modelId", () => {
    expect(newModelConfig(empty).modelId).not.toBe("");
  });
});
