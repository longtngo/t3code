import type { LocalLlmSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { GiB } from "@t3tools/shared/localLlm";
import {
  type ProbeResult,
  type RegistryEntry,
  buildSample,
  planLoad,
  probeTarget,
} from "./LlmServeManager.logic.ts";

const mlxConfig = {
  id: "c1",
  name: "Fast",
  providerId: "mlx-serve",
  modelId: "Qwen3.6-35B-A3B-4bit",
  visible: true,
  port: 8765,
  contextWindow: 65536,
};
const ds4External = {
  id: "c-ext",
  name: "Llama",
  providerId: "llamacpp",
  modelId: "gemma-4-12B-it-4bit",
  visible: true,
};

const settings = (models: unknown[], ramBudgetBytes = 0): LocalLlmSettings =>
  ({
    ramBudgetBytes,
    providers: { "mlx-serve": { visible: true, modelsDir: "/models" } },
    models,
  }) as never;

const HUGE = GiB(1000);

describe("planLoad", () => {
  it("plans a managed launch with the config's port", () => {
    const plan = planLoad("c1", settings([mlxConfig]), new Map(), HUGE);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.launch.port).toBe(8765);
    expect(plan.launch.executable).toBe("mlx-serve");
    expect(plan.launch.args).toContain("--model");
  });

  it("rejects an unknown config id", () => {
    const plan = planLoad("nope", settings([mlxConfig]), new Map(), HUGE);
    expect(plan).toMatchObject({ ok: false, kind: "not_found" });
  });

  it("rejects an external provider without planning a launch", () => {
    const plan = planLoad("c-ext", settings([ds4External]), new Map(), HUGE);
    expect(plan).toMatchObject({ ok: false, kind: "external_not_managed" });
  });

  it("rejects when already loaded", () => {
    const reg = new Map<string, RegistryEntry>([
      [
        "c1",
        {
          configId: "c1",
          providerId: "mlx-serve",
          modelId: "x",
          pid: 1,
          port: 8765,
          estBytes: 1,
          state: "loading",
        },
      ],
    ]);
    expect(planLoad("c1", settings([mlxConfig]), reg, HUGE)).toMatchObject({
      ok: false,
      kind: "already_online",
    });
  });

  it("rejects when over the RAM budget", () => {
    const plan = planLoad("c1", settings([mlxConfig], 1), new Map(), 2); // budget = 1 byte
    expect(plan).toMatchObject({ ok: false, kind: "budget_exceeded" });
  });

  it("reassigns the port when the config's port is taken", () => {
    const reg = new Map<string, RegistryEntry>([
      [
        "other",
        {
          configId: "other",
          providerId: "mlx-serve",
          modelId: "y",
          pid: 2,
          port: 8765,
          estBytes: 1,
          state: "loading",
        },
      ],
    ]);
    const plan = planLoad("c1", settings([mlxConfig]), reg, HUGE);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.launch.port).toBe(8766); // first free in mlx range after 8765
  });
});

describe("buildSample", () => {
  it("reports offline when neither registered nor reachable", () => {
    const out = buildSample(settings([mlxConfig]), new Map(), new Map(), HUGE);
    expect(out.providers).toHaveLength(1);
    const row = out.providers[0]!.models[0]!;
    expect(row.status).toBe("offline");
    expect(row.configId).toBe("c1");
    expect(row.configName).toBe("Fast");
    expect(row.contextLength).toBe(65536);
    expect(out.ramUsedBytes).toBe(0);
  });

  it("reports loading when registered but not yet reachable", () => {
    const reg = new Map<string, RegistryEntry>([
      [
        "c1",
        {
          configId: "c1",
          providerId: "mlx-serve",
          modelId: "x",
          pid: 9,
          port: 8765,
          estBytes: GiB(19),
          state: "loading",
        },
      ],
    ]);
    const row = buildSample(settings([mlxConfig]), reg, new Map(), HUGE).providers[0]!.models[0]!;
    expect(row.status).toBe("loading");
    expect(row.pid).toBe(9);
    expect(row.port).toBe(8765);
  });

  it("reports online and counts RAM when the probe is reachable", () => {
    const reg = new Map<string, RegistryEntry>([
      [
        "c1",
        {
          configId: "c1",
          providerId: "mlx-serve",
          modelId: "x",
          pid: 9,
          port: 8765,
          estBytes: GiB(19),
          state: "loading",
        },
      ],
    ]);
    const probes = new Map<string, ProbeResult>([
      ["c1", { reachable: true, model: { id: "x", loaded: true, state: "ready" } }],
    ]);
    const out = buildSample(settings([mlxConfig]), reg, probes, HUGE);
    const row = out.providers[0]!.models[0]!;
    expect(row.status).toBe("online");
    expect(row.loaded).toBe(true);
    expect(out.ramUsedBytes).toBe(GiB(19));
  });

  it("marks external-provider rows as not managed", () => {
    const row = buildSample(settings([ds4External]), new Map(), new Map(), HUGE).providers[0]!
      .models[0]!;
    expect(row.managed).toBe(false);
    expect(row.engine).toBeUndefined();
  });
});

describe("probeTarget", () => {
  it("uses the registry port when present, else the config port", () => {
    expect(probeTarget("c1", settings([mlxConfig]), new Map())).toEqual({
      host: "127.0.0.1",
      port: 8765,
    });
    const reg = new Map<string, RegistryEntry>([
      [
        "c1",
        {
          configId: "c1",
          providerId: "mlx-serve",
          modelId: "x",
          pid: 1,
          port: 8790,
          estBytes: 1,
          state: "loading",
        },
      ],
    ]);
    expect(probeTarget("c1", settings([mlxConfig]), reg)).toEqual({
      host: "127.0.0.1",
      port: 8790,
    });
  });
});
