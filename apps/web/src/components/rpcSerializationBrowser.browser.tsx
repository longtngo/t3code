import { makeCompressedMsgPackSerialization } from "@t3tools/shared/rpcSerialization";
import { describe, expect, it } from "vite-plus/test";

// Proves the production compressed-msgpack codec (msgpackr + fflate) runs in a real
// browser — the environment the web/desktop clients actually encode and decode in.
// (The msw-based harness tests run over JSON because msw can't transport binary
// frames; this guards the browser msgpack path they can't exercise.)
describe("compressed msgpack serialization (browser)", () => {
  it("round-trips small and large frames in the browser", () => {
    const parser = makeCompressedMsgPackSerialization().makeUnsafe();

    const small = { _tag: "Pong" };
    const encodedSmall = parser.encode(small);
    if (encodedSmall === undefined) {
      throw new Error("encode returned undefined for small frame");
    }
    expect(encodedSmall).toBeInstanceOf(Uint8Array);
    expect(parser.decode(encodedSmall)).toEqual([small]);

    const large = { _tag: "Response", body: "x".repeat(5000) };
    const encodedLarge = parser.encode(large);
    if (encodedLarge === undefined) {
      throw new Error("encode returned undefined for large frame");
    }
    expect(parser.decode(encodedLarge)).toEqual([large]);
  });
});
