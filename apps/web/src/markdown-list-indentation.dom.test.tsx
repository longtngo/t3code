import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { remarkNormalizeListItemIndentation } from "./markdown-list-indentation";
import { renderDom } from "./testing/renderDom";

function renderMarkdown(markdown: string) {
  return renderDom(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkNormalizeListItemIndentation]}>
      {markdown}
    </ReactMarkdown>,
  );
}

/** List item texts, so "rendered as list text" is asserted against the list, not a markup string. */
function listItemTexts(view: Awaited<ReturnType<typeof renderMarkdown>>): string[] {
  return view.findAll("li").map((item) => item.textContent ?? "");
}

describe("remarkNormalizeListItemIndentation", () => {
  it("renders same-line over-indented list content as list text", async () => {
    const view = await renderMarkdown(`why did you do this?

-       for (const step of rest.steps) {
-           if (step.request.body) {
-               step.request.body = "<redacted>";
-           }
-       }`);

    expect(view.find("pre")).toBeNull();
    expect(listItemTexts(view)).toContain("for (const step of rest.steps) {");
    expect(listItemTexts(view)).toContain("if (step.request.body) {");
    expect(listItemTexts(view)).toContain('step.request.body = "<redacted>";');
  });

  it("parses inline markdown in recovered list content", async () => {
    const view = await renderMarkdown(
      "-       **important** [docs](https://example.com) use `inline code`, not ~~plain text~~",
    );

    expect(view.find("strong")?.textContent).toBe("important");
    expect(view.find('a[href="https://example.com"]')?.textContent).toBe("docs");
    expect(view.find("code")?.textContent).toBe("inline code");
    expect(view.find("del")?.textContent).toBe("plain text");
    expect(view.text()).not.toContain("**important**");
  });

  it("preserves every recovered block separated by blank lines", async () => {
    const view = await renderMarkdown(`-       **first block**

        [second block](https://example.com)`);

    expect(view.find("strong")?.textContent).toBe("first block");
    expect(view.find('a[href="https://example.com"]')?.textContent).toBe("second block");
  });

  it("recursively normalizes lists in recovered tail blocks", async () => {
    const view = await renderMarkdown(`-       first block

        -       nested block`);

    expect(view.find("pre")).toBeNull();
    expect(listItemTexts(view)).toContain("nested block");
  });

  it("preserves fenced code blocks within list items", async () => {
    const view = await renderMarkdown(`- \`\`\`ts
  const value = 1;
  \`\`\``);

    expect(view.find("pre > code.language-ts")?.textContent).toContain("const value = 1;");
  });

  it("preserves indented code blocks that start below a list marker", async () => {
    const view = await renderMarkdown(`-
      const value = 1;`);

    const code = view.find("pre > code");
    expect(code?.textContent).toContain("const value = 1;");
    expect(code?.className).toBe("");
  });

  it("preserves same-line code blocks without excess indentation", async () => {
    const view = await renderMarkdown("-     const value = 1;");

    const code = view.find("pre > code");
    expect(code?.textContent).toContain("const value = 1;");
    expect(code?.className).toBe("");
  });
});
