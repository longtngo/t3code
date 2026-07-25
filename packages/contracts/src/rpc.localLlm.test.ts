import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { LlmModel, LlmServeLoadPayload, LlmServeUnloadPayload } from "./rpc.ts";

const decodeLlmModel = Schema.decodeUnknownSync(LlmModel);
const decodeLoad = Schema.decodeUnknownSync(LlmServeLoadPayload);
const decodeUnload = Schema.decodeUnknownSync(LlmServeUnloadPayload);

describe("local llm rpc", () => {
  it("LlmModel carries configId/configName", () => {
    const m = decodeLlmModel({ id: "x", loaded: false, configId: "c1", configName: "Fast" });
    expect(m.configId).toBe("c1");
    expect(m.configName).toBe("Fast");
  });

  it("load/unload payloads use configId", () => {
    expect(decodeLoad({ configId: "c1" }).configId).toBe("c1");
    expect(decodeUnload({ configId: "c2" }).configId).toBe("c2");
  });
});
