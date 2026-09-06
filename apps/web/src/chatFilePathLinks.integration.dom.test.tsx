/**
 * Integration test for the PROSE file-path linking pipeline.
 *
 * The unit tests cover resolution and the hast rewrite in isolation. This one
 * runs the real react-markdown pipeline — the same remark/rehype plugin array
 * and `urlTransform` ChatMarkdown uses — to prove an anchor with the resolved
 * absolute href actually survives sanitisation and URL transformation and
 * reaches the anchor renderer. That last hop is where the feature would silently
 * become inert (a blanked href still renders, just as dead text).
 *
 * Rendered into a real DOM rather than to a markup string: the question is what
 * the browser ends up with, and an `href` read back off a mounted anchor is the
 * value a click would follow.
 */
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { collectKnownAbsolutePaths } from "./chatFilePathLinks";
import { rehypeChatFilePathLinks } from "./rehypeChatFilePathLinks";
import { rewriteMarkdownFileUriHref } from "./markdown-links";
import { renderDom } from "./testing/renderDom";

const CWD = "/Users/dev/project";

function render(markdown: string) {
  const resolution = { cwd: CWD, knownPaths: collectKnownAbsolutePaths(markdown) };
  return renderDom(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeSanitize, [rehypeChatFilePathLinks, resolution]]}
      urlTransform={(href) => rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href)}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe("chat file-path links (pipeline)", () => {
  it("renders an anchor whose href is the absolute path, through urlTransform", async () => {
    const view = await render("I edited /Users/dev/project/src/main.ts today.");
    expect(view.find('a[href="/Users/dev/project/src/main.ts"]')).not.toBeNull();
  });

  it("keeps a line suffix on the href instead of blanking it", async () => {
    const view = await render("Failure at /Users/dev/project/src/main.ts:42:7 in the parser.");
    expect(view.find('a[href="/Users/dev/project/src/main.ts:42:7"]')).not.toBeNull();
  });

  it("resolves a cwd-relative path to an absolute href", async () => {
    const view = await render("Check src/lib/util.ts for the helper.");
    expect(view.find('a[href="/Users/dev/project/src/lib/util.ts"]')).not.toBeNull();
  });

  it("leaves a path inside inline code to ChatMarkdown's own code renderer", async () => {
    // This plugin only linkifies PROSE. ChatMarkdown's `code` renderer swaps a
    // path-only inline span for a file chip; linkifying here too nested a chip
    // inside the bordered inline-code element and drew two frames.
    const view = await render("The entry point is `/Users/dev/project/src/main.ts` now.");
    expect(view.find("a")).toBeNull();
    expect(view.find("code")?.textContent).toBe("/Users/dev/project/src/main.ts");
  });

  it("resolves a bare filename from an absolute path stated earlier", async () => {
    const view = await render(
      "I rewrote /Users/dev/project/src/lib/util.ts.\n\nAfter that, util.ts exports a helper.",
    );
    // Both the full path and the later shorthand point at the same file.
    expect(view.findAll('a[href="/Users/dev/project/src/lib/util.ts"]')).toHaveLength(2);
  });

  it("leaves fenced code alone", async () => {
    const view = await render("```sh\ncat /Users/dev/project/src/main.ts\n```");
    expect(view.find("a")).toBeNull();
    expect(view.text()).toContain("cat /Users/dev/project/src/main.ts");
  });

  it("does not double-wrap an existing markdown link", async () => {
    const view = await render("See [the entry](/Users/dev/project/src/main.ts) for details.");
    expect(view.findAll("a")).toHaveLength(1);
  });

  it("leaves ordinary prose untouched", async () => {
    const view = await render("We discussed the plan and agreed on the approach.");
    expect(view.find("a")).toBeNull();
  });
});
