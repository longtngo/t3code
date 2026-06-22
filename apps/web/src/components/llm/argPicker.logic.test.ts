import type { ArgSpec } from "@t3tools/shared/localLlm";
import { describe, expect, it } from "vite-plus/test";
import { addArg, buildArg, filterSpecs, removeArg } from "./argPicker.logic.ts";

describe("argPicker.logic", () => {
  it("builds flag and value args", () => {
    expect(buildArg({ flag: "--no-pld", type: "flag" })).toBe("--no-pld");
    expect(buildArg({ flag: "--kv-quant", type: "enum", values: ["8"] }, "8")).toBe("--kv-quant 8");
    expect(buildArg({ flag: "--ctx-size", type: "number" }, "65536")).toBe("--ctx-size 65536");
  });

  it("filters specs by flag and description", () => {
    const specs: ArgSpec[] = [
      { flag: "--ctx-size", type: "number", desc: "context" },
      { flag: "--temp", type: "number" },
    ];
    expect(filterSpecs(specs, "ctx").map((s) => s.flag)).toEqual(["--ctx-size"]);
    expect(filterSpecs(specs, "context").map((s) => s.flag)).toEqual(["--ctx-size"]);
    expect(filterSpecs(specs, "")).toHaveLength(2);
  });

  it("adds and removes", () => {
    expect(addArg(["--a"], "--b")).toEqual(["--a", "--b"]);
    expect(removeArg(["--a", "--b"], 0)).toEqual(["--b"]);
  });
});
