import { describe, expect, it } from "vite-plus/test";

import { basenamePathSegment, formatWorkspaceRelativePath } from "./filePathDisplay";

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

describe("formatWorkspaceRelativePath", () => {
  it("labels only relative paths, not Windows paths outside the workspace", () => {
    const workspaceRoot = "C:\\Users\\mike\\dev-stuff\\t3code";
    expect(
      formatWorkspaceRelativePath("C:\\Users\\mike\\.claude\\settings.json:3", workspaceRoot),
    ).toBe("C:/Users/mike/.claude/settings.json:3");
    expect(formatWorkspaceRelativePath("D:/data/report.csv", workspaceRoot)).toBe(
      "D:/data/report.csv",
    );
    expect(formatWorkspaceRelativePath("src/app.ts", workspaceRoot)).toBe("t3code/src/app.ts");
  });

  it("keeps home paths as written instead of labelling them as workspace paths", () => {
    expect(formatWorkspaceRelativePath("~/.claude/CLAUDE.md", "/workspace/t3code")).toBe(
      "~/.claude/CLAUDE.md",
    );
    expect(formatWorkspaceRelativePath("~\\.claude\\CLAUDE.md:3", "C:\\dev\\t3code")).toBe(
      "~/.claude/CLAUDE.md:3",
    );
  });
});
