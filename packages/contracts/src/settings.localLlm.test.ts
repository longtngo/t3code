import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
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
      models: [
        {
          id: "c1",
          name: "Fast",
          providerId: "mlx-serve",
          modelId: "Qwen3.6-35B-A3B-4bit",
          contextWindow: 65536,
          visible: true,
          port: 8765,
          argsOverride: ["--reasoning-budget 0"],
        },
      ],
    });
    expect(s.providers["mlx-serve"]!.visible).toBe(false);
    expect(s.providers["mlx-serve"]!.modelsDir).toBe("~/m");
    expect(s.models[0]!.contextWindow).toBe(65536);
    expect(s.models[0]!.visible).toBe(true);
    expect(s.models[0]!.argsOverride).toEqual(["--reasoning-budget 0"]);
  });

  it("defaults provider.visible and model.visible to true", () => {
    const s = decode({
      providers: { llamacpp: {} },
      models: [{ id: "c2", name: "X", providerId: "llamacpp", modelId: "some-model" }],
    });
    expect(s.providers.llamacpp!.visible).toBe(true);
    expect(s.models[0]!.visible).toBe(true);
  });
});
