import { describe, expect, it } from "vite-plus/test";

import { rehypeChatFilePathLinks } from "./rehypeChatFilePathLinks";

const CWD = "/Users/dev/project";

interface Node {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

const text = (value: string): Node => ({ type: "text", value });
const element = (tagName: string, children: Node[]): Node => ({
  type: "element",
  tagName,
  children,
});

function run(tree: Node, options = { cwd: CWD }): Node {
  rehypeChatFilePathLinks(options)(tree);
  return tree;
}

/** Flatten to `text` / `a:href` tokens for readable assertions. */
function describeChildren(node: Node): string[] {
  return (node.children ?? []).map((child) =>
    child.type === "text" ? `text:${child.value}` : `${child.tagName}:${child.properties?.href}`,
  );
}

describe("rehypeChatFilePathLinks", () => {
  it("wraps an absolute path in a paragraph with an anchor", () => {
    const tree = element("root", [
      element("p", [text("I edited /Users/dev/project/src/main.ts today")]),
    ]);
    run(tree);
    expect(describeChildren(tree.children![0]!)).toEqual([
      "text:I edited ",
      "a:/Users/dev/project/src/main.ts",
      "text: today",
    ]);
  });

  it("resolves a relative path against cwd", () => {
    const tree = element("root", [element("p", [text("see src/lib/util.ts")])]);
    run(tree);
    expect(describeChildren(tree.children![0]!)).toEqual([
      "text:see ",
      "a:/Users/dev/project/src/lib/util.ts",
    ]);
  });

  it("replaces an inline code element that is only a path, so the chip is not double-bordered", () => {
    // `.chat-markdown :not(pre) > code` draws its own border and background; a
    // chip nested inside it renders two frames. When the code element is nothing
    // but the path, the chip stands in for it.
    const tree = element("root", [
      element("p", [element("code", [text("/Users/dev/project/a.ts")])]),
    ]);
    run(tree);
    expect(describeChildren(tree.children![0]!)).toEqual(["a:/Users/dev/project/a.ts"]);
  });

  it("still linkifies inline when the code element holds more than the path", () => {
    const tree = element("root", [
      element("p", [element("code", [text("cat /Users/dev/project/a.ts")])]),
    ]);
    run(tree);
    const code = tree.children![0]!.children![0]!;
    expect(code.tagName).toBe("code");
    expect(describeChildren(code)).toEqual(["text:cat ", "a:/Users/dev/project/a.ts"]);
  });

  it("leaves fenced code blocks untouched", () => {
    const tree = element("root", [
      element("pre", [element("code", [text("cat /Users/dev/project/a.ts")])]),
    ]);
    run(tree);
    const code = tree.children![0]!.children![0]!;
    expect(code.children).toEqual([text("cat /Users/dev/project/a.ts")]);
  });

  it("never nests an anchor inside an existing link", () => {
    const tree = element("root", [
      element("p", [
        {
          type: "element",
          tagName: "a",
          properties: { href: "https://example.com" },
          children: [text("/Users/dev/project/a.ts")],
        },
      ]),
    ]);
    run(tree);
    const anchor = tree.children![0]!.children![0]!;
    expect(anchor.children).toEqual([text("/Users/dev/project/a.ts")]);
  });

  it("leaves prose without paths completely unchanged", () => {
    const original = element("root", [element("p", [text("no paths here at all")])]);
    const snapshot = JSON.stringify(original);
    run(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("resolves a bare filename using context from elsewhere in the message", () => {
    const tree = element("root", [element("p", [text("util.ts changed")])]);
    run(tree, {
      cwd: CWD,
      knownPaths: ["/Users/dev/project/src/lib/util.ts"],
    } as never);
    expect(describeChildren(tree.children![0]!)).toEqual([
      "a:/Users/dev/project/src/lib/util.ts",
      "text: changed",
    ]);
  });

  it("marks generated anchors so the renderer can identify them", () => {
    const tree = element("root", [element("p", [text("/Users/dev/project/a.ts")])]);
    run(tree);
    const anchor = tree.children![0]!.children![0]!;
    expect(anchor.properties?.dataChatFilePath).toBe("true");
  });

  it("handles several paths in one text node", () => {
    const tree = element("root", [
      element("p", [text("/Users/dev/a.ts and /Users/dev/b.ts both changed")]),
    ]);
    run(tree);
    expect(describeChildren(tree.children![0]!)).toEqual([
      "a:/Users/dev/a.ts",
      "text: and ",
      "a:/Users/dev/b.ts",
      "text: both changed",
    ]);
  });
});
