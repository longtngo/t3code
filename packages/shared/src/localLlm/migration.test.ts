import { describe, expect, it } from "vite-plus/test";
import { migrateLocalModels } from "./migration.ts";

describe("migrateLocalModels", () => {
  it("maps modelsDir/defaultArgs/ramBudget onto the mlx-serve provider", () => {
    const out = migrateLocalModels({
      modelsDir: "~/llm/models",
      ramBudgetBytes: 42,
      defaultArgs: ["--reasoning-budget", "0"],
      perModel: {},
      ds4: {
        enabled: true,
        binaryPath: "~/x/ds4-server",
        modelsDir: "~/g",
        defaultArgs: [],
        perModel: {},
      },
    } as never);
    expect(out.ramBudgetBytes).toBe(42);
    expect(out.providers["mlx-serve"]!.modelsDir).toBe("~/llm/models");
    expect(out.providers["mlx-serve"]!.defaultArgs).toEqual(["--reasoning-budget 0"]);
    // ds4 is retired and absent from the catalog, so its legacy block must not become a
    // provider override — that would name a provider nothing can resolve.
    expect(out.providers.ds4).toBeUndefined();
  });

  it("seeds a model config from a perModel key matching a catalog resourceName", () => {
    const out = migrateLocalModels({
      modelsDir: "~/llm/models",
      ramBudgetBytes: 0,
      defaultArgs: [],
      perModel: {
        "gemma-4-12B-it-4bit": { args: ["--kv-quant", "8"] },
        "unknown-dir": { args: ["--x"] },
      },
      ds4: {
        enabled: false,
        binaryPath: "ds4-server",
        modelsDir: "~/ds4/gguf",
        defaultArgs: [],
        perModel: {},
      },
    } as never);
    const cfg = out.models.find((m) => m.modelId === "gemma-4-12B-it-4bit");
    expect(cfg).toBeDefined();
    expect(cfg!.providerId).toBe("mlx-serve");
    expect(cfg!.argsOverride).toEqual(["--kv-quant 8"]);
    expect(out.models.some((m) => m.modelId === "unknown-dir")).toBe(false);
  });

  // A settings file written before ds4 was retired still carries its block. Migrating it would
  // produce configs pointing at a provider and a model that no longer exist, which surface as
  // "Unknown local LLM provider" the first time someone clicks load. Dropped instead.
  it("drops the retired ds4 block rather than migrating it", () => {
    const out = migrateLocalModels({
      modelsDir: "~/llm/models",
      ramBudgetBytes: 0,
      defaultArgs: [],
      perModel: {},
      ds4: {
        enabled: true,
        binaryPath: "ds4-server",
        modelsDir: "~/ds4/gguf",
        defaultArgs: [],
        perModel: { "ds4flash.gguf": { args: ["--quality"] } },
      },
    } as never);
    expect(out.models).toEqual([]);
    expect(Object.keys(out.providers)).toEqual(["mlx-serve"]);
  });
});
