import { describe, expect, it } from "vite-plus/test";
import { launchArgs, resolveLaunch, resolveProvider, splitGroupedArgs } from "./resolveLaunch.ts";

const base = { ramBudgetBytes: 0, providers: {}, models: [] };

describe("splitGroupedArgs", () => {
  it("splits flag+value but leaves bare flags", () => {
    expect(splitGroupedArgs(["--reasoning-budget 0", "--no-pld"])).toEqual([
      "--reasoning-budget",
      "0",
      "--no-pld",
    ]);
  });
  it("drops empty tokens", () => {
    expect(splitGroupedArgs(["", "  ", "--quality"])).toEqual(["--quality"]);
  });
});

describe("resolveProvider", () => {
  it("merges catalog defaults with overrides", () => {
    const r = resolveProvider("mlx-serve", {
      ...base,
      providers: { "mlx-serve": { visible: true, host: "0.0.0.0", port: 9000 } },
    } as never);
    expect(r?.host).toBe("0.0.0.0");
    expect(r?.port).toBe(9000);
    expect(r?.baseUrl).toBe("http://0.0.0.0:9000");
    expect(r?.defaultArgs).toEqual(["--reasoning-budget 0"]); // catalog default
  });
  it("returns null for unknown provider", () => {
    expect(resolveProvider("nope", base as never)).toBeNull();
  });
});

describe("resolveLaunch", () => {
  it("builds mlx-serve args, splits grouped defaults, appends ctx flag, joins model path", () => {
    const cfg = {
      id: "c1",
      name: "Fast",
      providerId: "mlx-serve",
      modelId: "Qwen3.6-35B-A3B-4bit",
      visible: true,
      port: 8765,
      contextWindow: 65536,
    } as never;
    const r = resolveLaunch(cfg, {
      ...base,
      providers: { "mlx-serve": { visible: true, modelsDir: "/models" } },
    } as never);
    if ("error" in r) throw new Error(r.error);
    expect(r.executable).toBe("mlx-serve");
    expect(r.modelPath).toBe("/models/Qwen3.6-35B-A3B-4bit");
    expect(r.args).toEqual([
      "--serve",
      "--reasoning-budget",
      "0",
      "--ctx-size",
      "65536",
      "--host",
      "127.0.0.1",
      "--port",
      "8765",
      "--model",
      "/models/Qwen3.6-35B-A3B-4bit",
    ]);
    expect(r.engineId).toBe("mlx-serve");
  });

  it("does not duplicate the ctx flag when an override already sets it", () => {
    const cfg = {
      id: "c1b",
      name: "Fast",
      providerId: "mlx-serve",
      modelId: "Qwen3.6-35B-A3B-4bit",
      visible: true,
      port: 8765,
      contextWindow: 65536,
      argsOverride: ["--ctx-size 1000"],
    } as never;
    const r = resolveLaunch(cfg, {
      ...base,
      providers: { "mlx-serve": { visible: true, modelsDir: "/models" } },
    } as never);
    if ("error" in r) throw new Error(r.error);
    expect(r.args.filter((a) => a === "--ctx-size")).toHaveLength(1);
    expect(r.args).toContain("1000");
    expect(r.args).not.toContain("65536");
  });

  // The retired ds4 engine is gone from the catalog. A settings file that still names it must
  // fail with a readable message rather than half-resolve into a launch nothing can run.
  it("refuses a config still pointing at the retired ds4 engine", () => {
    const cfg = {
      id: "c2",
      name: "DS",
      providerId: "ds4",
      modelId: "deepseek-v4-flash",
      visible: true,
      port: 8000,
    } as never;
    const r = resolveLaunch(cfg, {
      ...base,
      providers: { ds4: { visible: true, binaryPath: "/opt/ds4/ds4-server", modelsDir: "/g" } },
    } as never);
    expect("error" in r && r.error).toMatch(/Unknown local LLM provider: ds4/);
  });

  // The whole point of a per-model default: Qwen3.8 is unusable-slow without --mtp-depth 2,
  // and the provider layer cannot carry it without applying it to every mlx model.
  it("appends the model's own default args after the provider's", () => {
    const cfg = {
      id: "c2b",
      name: "Qwen3.8",
      providerId: "mlx-serve",
      modelId: "Qwen3.8-27B-MLX-Serve-4bit",
      visible: true,
      port: 8766,
    } as never;
    const r = resolveLaunch(cfg, {
      ...base,
      providers: { "mlx-serve": { visible: true, modelsDir: "/models" } },
    } as never);
    if ("error" in r) throw new Error(r.error);
    expect(r.args).toEqual([
      "--serve",
      "--reasoning-budget",
      "0",
      "--mtp-depth",
      "2",
      "--host",
      "127.0.0.1",
      "--port",
      "8766",
      "--model",
      "/models/Qwen3.8-27B-MLX-Serve-4bit",
    ]);
  });

  // Paired with the case above: a model without its own defaults must not pick any up.
  it("leaves a model with no defaults on the provider args alone", () => {
    const cfg = {
      id: "c2c",
      name: "Fast",
      providerId: "mlx-serve",
      modelId: "Qwen3.6-35B-A3B-4bit",
      visible: true,
      port: 8765,
    } as never;
    const r = resolveLaunch(cfg, {
      ...base,
      providers: { "mlx-serve": { visible: true, modelsDir: "/models" } },
    } as never);
    if ("error" in r) throw new Error(r.error);
    expect(r.args).not.toContain("--mtp-depth");
  });

  it("returns an error for an external provider", () => {
    const cfg = {
      id: "c3",
      name: "L",
      providerId: "llamacpp",
      modelId: "gemma-4-12B-it-4bit",
      visible: true,
    } as never;
    const r = resolveLaunch(cfg, base as never);
    expect("error" in r && r.error).toMatch(/external/i);
  });

  it("honors modelPathOverride", () => {
    const cfg = {
      id: "c4",
      name: "Custom",
      providerId: "mlx-serve",
      modelId: "gemma-4-12B-it-4bit",
      visible: true,
      port: 8766,
      modelPathOverride: "/custom/path/model",
    } as never;
    const r = resolveLaunch(cfg, base as never);
    if ("error" in r) throw new Error(r.error);
    expect(r.modelPath).toBe("/custom/path/model");
  });
});

describe("launchArgs", () => {
  const cfg = (argsOverride?: readonly string[]) =>
    ({
      id: "x",
      name: "x",
      providerId: "mlx-serve",
      modelId: "m",
      visible: true,
      argsOverride,
    }) as never;

  it("layers model defaults onto provider defaults", () => {
    expect(launchArgs(cfg(), ["--reasoning-budget 0"], ["--mtp-depth 2"])).toEqual([
      "--reasoning-budget",
      "0",
      "--mtp-depth",
      "2",
    ]);
  });

  // The provider layer wins on conflict, otherwise a model default would silently override a
  // deliberate per-provider setting the user typed in Settings.
  it("skips a model default whose flag the provider already set", () => {
    expect(launchArgs(cfg(), ["--mtp-depth 4"], ["--mtp-depth 2"])).toEqual(["--mtp-depth", "4"]);
  });

  // An explicit override is a command line someone wrote out; layering onto it would mean the
  // args they see in Settings are not the args that run.
  it("lets an explicit override replace both layers", () => {
    expect(launchArgs(cfg(["--quality"]), ["--reasoning-budget 0"], ["--mtp-depth 2"])).toEqual([
      "--quality",
    ]);
  });

  it("is unchanged for a model with no defaults of its own", () => {
    expect(launchArgs(cfg(), ["--reasoning-budget 0"], undefined)).toEqual([
      "--reasoning-budget",
      "0",
    ]);
  });
});
