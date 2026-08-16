import type { LlmModelsSample, LocalLlmModelConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { countOnline, mergeConfigsWithSample } from "./sidebarLocalModels.logic.ts";

const configs: LocalLlmModelConfig[] = [
  {
    id: "c1",
    name: "Fast",
    providerId: "mlx-serve",
    modelId: "Qwen3.6-35B-A3B-4bit",
    visible: true,
  },
  {
    id: "c2",
    name: "Hidden",
    providerId: "mlx-serve",
    modelId: "gemma-4-12B-it-4bit",
    visible: false,
  },
  {
    id: "c3",
    name: "Llama",
    providerId: "llamacpp",
    modelId: "gemma-4-12B-it-4bit",
    visible: true,
  },
] as never;

const sample: LlmModelsSample = {
  ts: 0,
  providers: [
    {
      name: "mlx-serve",
      baseUrl: "http://127.0.0.1:8765",
      reachable: true,
      models: [
        {
          id: "Qwen3.6-35B-A3B-4bit",
          loaded: true,
          status: "online",
          configId: "c1",
          pid: 5,
          port: 8765,
        },
      ],
    },
  ],
};

describe("mergeConfigsWithSample", () => {
  it("includes only visible configs and joins live status by configId", () => {
    const rows = mergeConfigsWithSample(configs, sample);
    expect(rows.map((r) => r.configId)).toEqual(["c1", "c3"]); // c2 hidden
    const c1 = rows.find((r) => r.configId === "c1")!;
    expect(c1.status).toBe("online");
    expect(c1.pid).toBe(5);
    expect(c1.loadable).toBe(true);
  });

  it("marks an external provider row as not loadable and offline without a live row", () => {
    const c3 = mergeConfigsWithSample(configs, sample).find((r) => r.configId === "c3")!;
    expect(c3.loadable).toBe(false);
    expect(c3.status).toBe("offline");
  });

  it("treats a null sample as all offline", () => {
    const rows = mergeConfigsWithSample(configs, null);
    expect(rows.every((r) => r.status === "offline")).toBe(true);
    expect(countOnline(rows)).toBe(0);
  });
});
