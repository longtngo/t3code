import { describe, expect, it } from "@effect/vitest";

import { createMarkdownHtmlCache, renderMarkdownDocument } from "./markdownHtml.ts";

const entry = (html: string) => ({ mtimeMs: 1, size: html.length, hash: html, html });

describe("renderMarkdownDocument", () => {
  it("wraps rendered markdown in a self-contained document", () => {
    const html = renderMarkdownDocument("# Hi\n\nA [link](./a.md).");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<article class="markdown-body">');
    expect(html).toContain("<h1>Hi</h1>");
    expect(html).toContain('href="./a.md"');
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("renders GitHub-flavored tables", () => {
    const html = renderMarkdownDocument("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
  });
});

describe("createMarkdownHtmlCache", () => {
  it("evicts the least-recently-used entry past the cap", () => {
    const cache = createMarkdownHtmlCache(2);
    cache.set("a", entry("A"));
    cache.set("b", entry("B"));
    // Touch "a" so "b" becomes least-recently-used.
    expect(cache.get("a")?.html).toBe("A");
    cache.set("c", entry("C"));

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")?.html).toBe("A");
    expect(cache.get("c")?.html).toBe("C");
  });

  it("overwrites an existing key without growing", () => {
    const cache = createMarkdownHtmlCache(1);
    cache.set("a", entry("A1"));
    cache.set("a", entry("A2"));
    expect(cache.get("a")?.html).toBe("A2");
  });
});
