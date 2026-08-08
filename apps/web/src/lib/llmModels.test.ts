import { describe, assert, it } from "vite-plus/test";
import { formatContext } from "./llmModels";

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
