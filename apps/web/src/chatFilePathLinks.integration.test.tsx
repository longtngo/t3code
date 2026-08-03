/**
 * Integration test for the plain-text file-path linking pipeline.
 *
 * The unit tests cover resolution and the hast rewrite in isolation. This one
 * runs the real react-markdown pipeline — the same remark/rehype plugin array
 * and `urlTransform` ChatMarkdown uses — to prove an anchor with the resolved
 * absolute href actually survives sanitisation and URL transformation and
 * reaches the anchor renderer. That last hop is where the feature would silently
 * become inert (a blanked href still renders, just as dead text).
 */
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { collectKnownAbsolutePaths } from "./chatFilePathLinks";
import { rehypeChatFilePathLinks } from "./rehypeChatFilePathLinks";
import { rewriteMarkdownFileUriHref } from "./markdown-links";

const CWD = "/Users/dev/project";

function render(markdown: string): string {
  const resolution = { cwd: CWD, knownPaths: collectKnownAbsolutePaths(markdown) };
  return renderToStaticMarkup(
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
  it("renders an anchor whose href is the absolute path, through urlTransform", () => {
    const html = render("I edited /Users/dev/project/src/main.ts today.");
    expect(html).toContain('href="/Users/dev/project/src/main.ts"');
  });

  it("keeps a line suffix on the href instead of blanking it", () => {
    const html = render("Failure at /Users/dev/project/src/main.ts:42:7 in the parser.");
    expect(html).toContain('href="/Users/dev/project/src/main.ts:42:7"');
  });

  it("resolves a cwd-relative path to an absolute href", () => {
    const html = render("Check src/lib/util.ts for the helper.");
    expect(html).toContain('href="/Users/dev/project/src/lib/util.ts"');
  });

  it("links a path written inside inline code", () => {
    const html = render("The entry point is `/Users/dev/project/src/main.ts` now.");
    expect(html).toContain('href="/Users/dev/project/src/main.ts"');
  });

  it("resolves a bare filename from an absolute path stated earlier", () => {
    const html = render(
      "I rewrote /Users/dev/project/src/lib/util.ts.\n\nAfter that, util.ts exports a helper.",
    );
    // Both the full path and the later shorthand point at the same file.
    expect(html.match(/href="\/Users\/dev\/project\/src\/lib\/util\.ts"/g)).toHaveLength(2);
  });

  it("leaves fenced code alone", () => {
    const html = render("```sh\ncat /Users/dev/project/src/main.ts\n```");
    expect(html).not.toContain("<a ");
    expect(html).toContain("cat /Users/dev/project/src/main.ts");
  });

  it("does not double-wrap an existing markdown link", () => {
    const html = render("See [the entry](/Users/dev/project/src/main.ts) for details.");
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("leaves ordinary prose untouched", () => {
    const html = render("We discussed the plan and agreed on the approach.");
    expect(html).not.toContain("<a ");
  });
});
