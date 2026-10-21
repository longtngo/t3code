import { describe, expect, it } from "vite-plus/test";

import { basenamePathSegment } from "./filePathDisplay";

describe("basenamePathSegment", () => {
  it("returns the final segment of a file path", () => {
    expect(basenamePathSegment("/Users/julius/project/main.ts")).toBe("main.ts");
    expect(basenamePathSegment("C:\\Users\\mike\\project\\main.ts")).toBe("main.ts");
    expect(basenamePathSegment("main.ts")).toBe("main.ts");
  });

  it("names the folder when the path is written as a directory", () => {
    expect(basenamePathSegment("/Users/julius/reports/2026-08/")).toBe("2026-08");
    expect(basenamePathSegment("/Users/julius/reports///")).toBe("reports");
    expect(basenamePathSegment("C:\\Users\\mike\\project\\")).toBe("project");
    expect(basenamePathSegment("scripts/")).toBe("scripts");
  });

  it("keeps a separator-only path labelled rather than empty", () => {
    expect(basenamePathSegment("/")).toBe("/");
    expect(basenamePathSegment("//")).toBe("//");
    expect(basenamePathSegment("")).toBe("");
  });
});
