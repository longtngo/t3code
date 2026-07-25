import type { ProviderInstanceEnvironmentVariable } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { mergeEnv, presetEnv } from "./localLlmPreset.logic.ts";

const cfg = {
  id: "c1",
  name: "Fast",
  providerId: "mlx-serve",
  modelId: "Qwen3.6-35B-A3B-4bit",
  visible: true,
  port: 8765,
} as never;

describe("presetEnv", () => {
  it("produces OpenAI-style vars for the codex driver", () => {
    const env = presetEnv(cfg, "codex");
    const byName = Object.fromEntries(env.map((e) => [e.name, e.value]));
    expect(byName.OPENAI_BASE_URL).toBe("http://127.0.0.1:8765/v1");
    expect(byName.OPENAI_API_KEY).toBe("local");
    expect(byName.CODEX_MODEL).toBe("Qwen3.6-35B-A3B-4bit");
    expect(env.find((e) => e.name === "OPENAI_API_KEY")?.sensitive).toBe(true);
  });

  it("uses Anthropic names for the claude driver", () => {
    const names = presetEnv(cfg, "claudeAgent").map((e) => e.name);
    expect(names).toContain("ANTHROPIC_BASE_URL");
    expect(names).toContain("ANTHROPIC_MODEL");
  });

  it("falls back to OpenAI names for an unknown driver", () => {
    expect(presetEnv(cfg, "mystery").map((e) => e.name)).toContain("OPENAI_BASE_URL");
  });
});

describe("mergeEnv", () => {
  it("preset wins on conflict and rows are classified", () => {
    const existing: ProviderInstanceEnvironmentVariable[] = [
      { name: "OPENAI_API_KEY", value: "old", sensitive: true },
      { name: "KEEP", value: "x", sensitive: false },
    ];
    const preset: ProviderInstanceEnvironmentVariable[] = [
      { name: "OPENAI_API_KEY", value: "local", sensitive: true },
      { name: "OPENAI_BASE_URL", value: "u", sensitive: false },
    ];
    const r = mergeEnv(existing, preset);
    expect(r.merged.find((e) => e.name === "OPENAI_API_KEY")!.value).toBe("local");
    expect(r.merged.some((e) => e.name === "KEEP")).toBe(true);
    expect(r.overridden).toContain("OPENAI_API_KEY");
    expect(r.added).toContain("OPENAI_BASE_URL");
    expect(r.added).not.toContain("OPENAI_API_KEY");
  });
});
