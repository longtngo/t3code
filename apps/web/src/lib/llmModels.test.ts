import { describe, assert, it } from "vite-plus/test";
import type { LlmModelsSample } from "./llmModels";
import { countAvailable, countResident, formatContext } from "./llmModels";

function sample(providers: LlmModelsSample["providers"]): LlmModelsSample {
  return { ts: 0, providers };
}

describe("countResident / countAvailable", () => {
  const s = sample([
    {
      name: "mlx-serve",
      baseUrl: "http://127.0.0.1:8765",
      reachable: true,
      models: [
        { id: "a", loaded: true },
        { id: "b", loaded: false },
      ],
    },
    {
      name: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      reachable: true,
      models: [{ id: "c", loaded: true }],
    },
    { name: "down", baseUrl: "http://127.0.0.1:9", reachable: false, error: "timeout", models: [] },
  ]);

  it("counts only loaded models as resident", () => {
    assert.equal(countResident(s), 2);
  });

  it("counts every known model as available", () => {
    assert.equal(countAvailable(s), 3);
  });

  it("returns 0 for a null sample", () => {
    assert.equal(countResident(null), 0);
    assert.equal(countAvailable(null), 0);
  });
});

describe("formatContext", () => {
  it("formats thousands as k", () => {
    assert.equal(formatContext(163223), "163k ctx");
    assert.equal(formatContext(8192), "8k ctx");
  });

  it("formats millions as M", () => {
    assert.equal(formatContext(1_050_000), "1.1M ctx");
  });

  it("passes small counts through and guards bad input", () => {
    assert.equal(formatContext(512), "512 ctx");
    assert.equal(formatContext(0), "");
    assert.equal(formatContext(-1), "");
  });
});
