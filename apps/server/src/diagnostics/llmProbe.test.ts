import { expect, it } from "@effect/vitest";

import { parseModelsResponse } from "./llmProbe.ts";

// Captured verbatim from a live `mlx-serve --serve` /v1/models response.
const REAL_MLX_SERVE_RESPONSE = {
  object: "list",
  data: [
    {
      id: "Qwen3.6-35B-A3B-4bit",
      object: "model",
      created: 1781544526,
      owned_by: "mlx-serve",
      loaded: true,
      state: "ready",
      bytes_resident: 1310720,
      bytes_on_disk: null,
      capabilities: ["chat", "tool_use", "streaming", "reasoning", "json_schema"],
      input_modalities: ["text"],
      meta: {
        architecture: "qwen3_5_moe",
        vocab_size: 248320,
        hidden_size: 2048,
        num_layers: 40,
        quantization: "4-bit",
        context_length: 163223,
        model_max_tokens: 262144,
        is_moe: true,
        drafter_loaded: false,
        drafter_path: null,
      },
    },
  ],
};

it("maps a real mlx-serve /v1/models response", () => {
  const models = parseModelsResponse(REAL_MLX_SERVE_RESPONSE);
  expect(models).toHaveLength(1);
  const model = models[0]!;
  expect(model.id).toBe("Qwen3.6-35B-A3B-4bit");
  expect(model.loaded).toBe(true);
  expect(model.state).toBe("ready");
  expect(model.quantization).toBe("4-bit");
  expect(model.contextLength).toBe(163223);
  expect(model.isMoe).toBe(true);
  expect(model.capabilities).toContain("tool_use");
  // bytes_resident is implausibly small (1.25 MB for a multi-GB model) -> dropped.
  expect(model.sizeBytes).toBeUndefined();
});

it("surfaces a plausible resident size and ignores unknown fields", () => {
  const models = parseModelsResponse({
    data: [{ id: "big-model", loaded: true, bytes_resident: 18_400_000_000, extra: "ignored" }],
  });
  expect(models[0]?.sizeBytes).toBe(18_400_000_000);
});

it("treats a served model with no `loaded` field as loaded", () => {
  // Generic OpenAI-compatible providers (vLLM/llama.cpp) list without `loaded`.
  const models = parseModelsResponse({ data: [{ id: "served-only" }] });
  expect(models[0]?.loaded).toBe(true);
  expect(models[0]?.quantization).toBeUndefined();
});

it("returns [] for unexpected payloads rather than throwing", () => {
  expect(parseModelsResponse(null)).toEqual([]);
  expect(parseModelsResponse({})).toEqual([]);
  expect(parseModelsResponse({ data: "not-an-array" })).toEqual([]);
  expect(parseModelsResponse("<html>404</html>")).toEqual([]);
});

it("sets status from the loaded flag", () => {
  const [online] = parseModelsResponse({ data: [{ id: "m", loaded: true }] });
  expect(online?.status).toBe("online");
  const [served] = parseModelsResponse({ data: [{ id: "m" }] });
  expect(served?.status).toBe("online"); // served == loaded fallback
});
