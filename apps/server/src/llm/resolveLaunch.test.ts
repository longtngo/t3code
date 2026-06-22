import { describe, expect, it } from "vite-plus/test";
import { resolveLaunch, resolveProvider, splitGroupedArgs } from "./resolveLaunch.ts";

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
    expect(r.cwd).toBeUndefined();
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

  it("ds4 builds -m and a cwd pinned to the binary dir", () => {
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
    if ("error" in r) throw new Error(r.error);
    expect(r.executable).toBe("/opt/ds4/ds4-server");
    expect(r.modelPath).toBe("/g/ds4flash.gguf");
    expect(r.args).toEqual(["--host", "127.0.0.1", "--port", "8000", "-m", "/g/ds4flash.gguf"]);
    expect(r.cwd).toBe("/opt/ds4");
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
