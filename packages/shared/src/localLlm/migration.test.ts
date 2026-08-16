import { describe, expect, it } from "vite-plus/test";
import { migrateLocalModels } from "./migration.ts";

describe("migrateLocalModels", () => {
  it("maps modelsDir/defaultArgs/ramBudget and ds4 enabled->visible", () => {
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
    expect(out.providers.ds4!.visible).toBe(true);
    expect(out.providers.ds4!.binaryPath).toBe("~/x/ds4-server");
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

  it("seeds a ds4 model config from ds4.perModel", () => {
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
    const cfg = out.models.find((m) => m.modelId === "deepseek-v4-flash");
    expect(cfg).toBeDefined();
    expect(cfg!.providerId).toBe("ds4");
    expect(cfg!.argsOverride).toEqual(["--quality"]);
  });
});
