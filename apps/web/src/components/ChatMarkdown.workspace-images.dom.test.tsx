import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../testing/renderDom";

const testState = vi.hoisted(() => ({
  resources: [] as Array<unknown>,
  assetState: "success" as "success" | "loading" | "failure",
  imageDimensions: undefined as { width: number; height: number } | undefined,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlRefresh: () => vi.fn(),
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    testState.resources.push(resource);
    if (testState.assetState === "loading") return { _tag: "Loading" };
    if (testState.assetState === "failure") return { _tag: "Failure" };
    return {
      _tag: "Success",
      url: "https://signed.test/workspace-image.svg",
      ...(testState.imageDimensions ? { imageDimensions: testState.imageDimensions } : {}),
    };
  },
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown, { ChatMarkdownAssetImage } from "./ChatMarkdown";
import { FileMarkdownPreview } from "./files/FileMarkdownPreview";

const threadRef = {
  environmentId: EnvironmentId.make("env-windows"),
  threadId: ThreadId.make("thread-windows"),
};

type View = Awaited<ReturnType<typeof renderDom>>;

function render(markdown: string): Promise<View> {
  return renderDom(
    <ChatMarkdown cwd={"C:\\Users\\shawn\\project"} threadRef={threadRef} text={markdown} />,
  );
}

function renderWithoutThread(markdown: string): Promise<View> {
  return renderDom(<ChatMarkdown cwd={"C:\\Users\\shawn\\project"} text={markdown} />);
}

function renderFilePreview(cwd: string, relativePath: string): Promise<View> {
  return renderDom(
    <FileMarkdownPreview
      cwd={cwd}
      relativePath={relativePath}
      text="![diagram](images/diagram.png)"
      threadRef={threadRef}
    />,
  );
}

/** The markdown the copy affordance hands back for the first image in the tree. */
function copiedMarkdownFrom(view: View): string {
  const copy = view.find("[data-markdown-copy]")?.getAttribute("data-markdown-copy");
  expect(copy).not.toBeNull();
  return copy ?? "";
}

function firstInlineStyle(view: View): Record<string, string> {
  const style = view.find("[style]")?.getAttribute("style");
  expect(style).toBeDefined();
  return Object.fromEntries(
    (style ?? "")
      .split(";")
      .filter((declaration) => declaration.trim().length > 0)
      .map((declaration) => {
        const separator = declaration.indexOf(":");
        return [declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim()];
      }),
  );
}

/** Every element carrying a Tailwind class, which cannot be matched with a plain selector. */
const withClass = (view: View, className: string) =>
  view.findAll("*").filter((element) => element.classList.contains(className));

const classesOf = (element: Element | null | undefined) => [...(element?.classList ?? [])];

/** The frame a workspace image reserves while its URL, bytes, or failure resolves. */
const imageFrame = (view: View) => view.find('span[role="status"], span[role="alert"]');

/** Nothing in the tree may carry a raw source the sanitizer was meant to strip. */
const attributeValuesContaining = (view: View, needle: string) =>
  view
    .findAll("*")
    .flatMap((element) =>
      element.getAttributeNames().map((name) => element.getAttribute(name) ?? ""),
    )
    .filter((value) => value.includes(needle));

describe("ChatMarkdown workspace images", () => {
  beforeEach(() => {
    testState.resources = [];
    testState.assetState = "success";
    testState.imageDimensions = undefined;
  });

  it.each([
    ["/workspace/project", "docs/README.md", "/workspace/project/docs/images/diagram.png"],
    [
      "C:\\Users\\shawn\\project",
      "docs\\README.md",
      "C:\\Users\\shawn\\project\\docs\\images\\diagram.png",
    ],
    ["/workspace/project", "README.md", "/workspace/project/images/diagram.png"],
  ])("resolves images beside a nested file in %s", async (cwd, relativePath, expectedPath) => {
    await renderFilePreview(cwd, relativePath);

    expect(testState.resources).toEqual([
      {
        _tag: "media-file",
        threadId: threadRef.threadId,
        path: expectedPath,
      },
    ]);
  });

  it("loads every Windows workspace path form through a signed asset URL", async () => {
    const imagePath = "C:/Users/shawn/project/.t3/workspace-image.svg";
    const view = await render(
      [
        "![relative](.t3/workspace-image.svg)",
        `![absolute](${imagePath})`,
        `![file URL](file:///${imagePath})`,
        "![UNC file URL](file://server/share/workspace-image.svg)",
      ].join("\n\n"),
    );

    expect(testState.resources).toEqual([
      {
        _tag: "media-file",
        threadId: threadRef.threadId,
        path: "C:\\Users\\shawn\\project\\.t3\\workspace-image.svg",
      },
      { _tag: "media-file", threadId: threadRef.threadId, path: imagePath },
      { _tag: "media-file", threadId: threadRef.threadId, path: imagePath },
      {
        _tag: "media-file",
        threadId: threadRef.threadId,
        path: "\\\\server\\share\\workspace-image.svg",
      },
    ]);
    expect(view.findAll('img[src="https://signed.test/workspace-image.svg"]')).toHaveLength(4);
    expect(withClass(view, "max-w-[min(100%,30rem)]")).toHaveLength(4);
    expect(view.text()).not.toContain("Image unavailable");
  });

  it("loads a POSIX absolute path and file URI through a signed asset URL", async () => {
    const view = await renderDom(
      <ChatMarkdown
        cwd="/workspace/project"
        threadRef={threadRef}
        text={[
          "![absolute](/tmp/embed-test/2.png)",
          "![file URL](file:///tmp/embed-test/5.png)",
        ].join("\n\n")}
      />,
    );

    expect(testState.resources).toEqual([
      { _tag: "media-file", threadId: threadRef.threadId, path: "/tmp/embed-test/2.png" },
      { _tag: "media-file", threadId: threadRef.threadId, path: "/tmp/embed-test/5.png" },
    ]);
    expect(view.text()).not.toContain("Image unavailable");
  });

  it("normalizes a drive-absolute src in raw image HTML", async () => {
    const view = await render(String.raw`<img src="D:\screens\workspace-image.svg" alt="raw">`);

    expect(testState.resources).toEqual([
      {
        _tag: "media-file",
        threadId: threadRef.threadId,
        path: "D:/screens/workspace-image.svg",
      },
    ]);
    expect(view.find('img[src="https://signed.test/workspace-image.svg"]')).not.toBeNull();
  });

  it("keeps a tall image placeholder and loaded image at the same proportional bounds", async () => {
    const markdown = '<img src=".t3/workspace-image.svg" alt="sized" width="96" height="128">';
    const loadedStyle = firstInlineStyle(await render(markdown));
    testState.assetState = "loading";
    const loadingStyle = firstInlineStyle(await render(markdown));

    expect(loadedStyle).toMatchObject({
      width: "96px",
      height: "auto",
      "aspect-ratio": "96 / 128",
      "max-width": "min(100%, 30rem, 22.5rem)",
    });
    expect(loadingStyle).toEqual(loadedStyle);
  });

  it.each([
    ["width", "max-width", "min(100%, 30rem, 300px)"],
    ["height", "max-height", "min(30rem, 300px)"],
  ])("treats a lone authored %s as a cap", async (axis, constraint, expectedValue) => {
    const markdown = `<img src=".t3/workspace-image.svg" alt="sized" ${axis}="300">`;
    const loadedStyle = firstInlineStyle(await render(markdown));

    expect(loadedStyle).not.toHaveProperty(axis);
    expect(loadedStyle).toHaveProperty(constraint, expectedValue);
  });

  it("keeps images that share a line inline and lets a standalone one reserve a slot", async () => {
    const view = await render(
      "![remote](https://example.com/badge.svg) ![workspace](.t3/workspace-image.svg)",
    );

    // Two images in one paragraph are badges: neither reserves a slot.
    expect(withClass(view, "aspect-video")).toHaveLength(0);
    expect(view.find('img[src="https://example.com/badge.svg"]')).not.toBeNull();
    expect(view.find('img[src="https://signed.test/workspace-image.svg"]')).not.toBeNull();
    expect(
      view.findAll("img").filter((image) => image.classList.contains("inline-block!")),
    ).toHaveLength(1);
    expect(withClass(view, "invisible")).toHaveLength(0);

    const centered = await render(
      '<p align="center"><img src=".t3/workspace-image.svg" alt="logo"></p>',
    );

    expect(classesOf(imageFrame(centered))).toEqual(
      expect.arrayContaining(["inline-block!", "aspect-video"]),
    );
  });

  it("reserves a slot for an image that is the only content of its link", async () => {
    const view = await render("[![shot](.t3/workspace-image.svg)](https://example.com)");

    expect(withClass(view, "aspect-video").length).toBeGreaterThan(0);
  });

  it.each([
    ["a link", "Figure: [![shot](.t3/workspace-image.svg)](https://example.com)"],
    ["emphasis", "**![shot](.t3/workspace-image.svg)** caption"],
  ])(
    "keeps an image wrapped in %s inline when text shares its block",
    async (_wrapper, markdown) => {
      expect(withClass(await render(markdown), "aspect-video")).toHaveLength(0);
    },
  );

  it("keeps an authored id on a remote image so fragment links resolve", async () => {
    const view = await render(
      '<img id="diagram" src="https://example.com/diagram.png" alt="diagram">',
    );

    // The sanitizer prefixes authored ids; the loading slot carries it too.
    expect(view.find("span#user-content-diagram")).not.toBeNull();
  });

  it("sizes the slot from server-reported dimensions so a portrait image never grows", async () => {
    testState.imageDimensions = { width: 720, height: 1400 };

    const style = firstInlineStyle(await render("![shot](.t3/workspace-image.svg)"));

    expect(style).toMatchObject({ width: "720px", "aspect-ratio": "720 / 1400" });
  });

  it("folds a caller's height cap into the width bound so the ratio holds", async () => {
    testState.imageDimensions = { width: 720, height: 1400 };

    const view = await renderDom(
      <ChatMarkdownAssetImage
        environmentId={threadRef.environmentId}
        resource={{ _tag: "media-file", threadId: threadRef.threadId, path: "/shot.png" }}
        alt="shot"
        maxHeightRem={16}
      />,
    );

    expect(firstInlineStyle(view)).toMatchObject({
      "aspect-ratio": "720 / 1400",
      "max-width": `min(100%, 30rem, ${(16 * 720) / 1400}rem)`,
    });
  });

  it("lets an authored size override server-reported dimensions", async () => {
    testState.imageDimensions = { width: 720, height: 1400 };

    const style = firstInlineStyle(
      await render('<img src=".t3/workspace-image.svg" alt="sized" width="96" height="128">'),
    );

    expect(style).toMatchObject({ width: "96px", "aspect-ratio": "96 / 128" });
  });

  it("reserves a slot for an image that is alone in a list item", async () => {
    expect(
      withClass(await render("- ![shot](.t3/workspace-image.svg)"), "aspect-video").length,
    ).toBeGreaterThan(0);
  });

  it("retains an authored SVG fragment on the signed URL", async () => {
    const view = await render("![logo](icons.svg#logo)");

    expect(view.find('img[src="https://signed.test/workspace-image.svg#logo"]')).not.toBeNull();
  });

  it.each(["success", "loading", "failure", "no-thread"] as const)(
    "copies the authored workspace source (%s)",
    async (scenario) => {
      if (scenario === "no-thread") {
        const view = await renderWithoutThread("![diagram](images/diagram.png)");
        expect(copiedMarkdownFrom(view)).toBe("![diagram](images/diagram.png)");
        return;
      }

      testState.assetState = scenario;
      const view = await render("![diagram](images/diagram.png#preview)");

      expect(copiedMarkdownFrom(view)).toBe("![diagram](images/diagram.png#preview)");
    },
  );

  it("copies an authored title with a workspace image", async () => {
    const view = await render('![logo](images/logo.svg "My Title")');

    expect(copiedMarkdownFrom(view)).toBe('![logo](images/logo.svg "My Title")');
  });

  it("escapes double quotes in an authored image title", async () => {
    const view = await render(`![logo](images/logo.svg 'My "Title"')`);

    expect(copiedMarkdownFrom(view)).toBe('![logo](images/logo.svg "My \\"Title\\"")');
  });

  it("escapes a closing bracket in authored image alt text", async () => {
    const markdown = String.raw`![build\] badge](badge.svg)`;

    expect(copiedMarkdownFrom(await render(markdown))).toBe(markdown);
  });

  it("escapes a literal backslash in authored image alt text", async () => {
    const markdown = String.raw`![folder\\name](badge.svg)`;

    expect(copiedMarkdownFrom(await render(markdown))).toBe(markdown);
  });

  it("escapes a literal backslash before a quote in an authored image title", async () => {
    const view = await render(
      String.raw`<img src="images/logo.svg" alt="logo" title="Path \&quot;Title\&quot;">`,
    );

    expect(copiedMarkdownFrom(view)).toBe(
      String.raw`![logo](images/logo.svg "Path \\\"Title\\\"")`,
    );
  });

  it("reserves the same 16:9 frame while the URL, the bytes, and a failure resolve", async () => {
    const markdown = "![shot](.t3/workspace-image.svg)";

    testState.assetState = "loading";
    const loadingUrl = classesOf(imageFrame(await render(markdown)));
    testState.assetState = "success";
    const loadingBytes = await render(markdown);
    testState.assetState = "failure";
    const failure = await render(markdown);

    expect(loadingUrl).toEqual(expect.arrayContaining(["aspect-video", "w-full"]));
    expect(loadingUrl).not.toContain("animate-pulse");
    expect(classesOf(imageFrame(loadingBytes))).toEqual(loadingUrl);
    expect(classesOf(imageFrame(failure))).toEqual(loadingUrl);
    expect(failure.text()).toContain("Image unavailable");
    // The bytes are requested inside the frame but never paint at an unknown size.
    expect(loadingBytes.find('img[src^="https://signed"]')?.classList.contains("invisible")).toBe(
      true,
    );
    expect(loadingBytes.find('img[loading="lazy"]')).toBeNull();
  });

  it("gives a standalone remote image the same frame instead of a bare tag", async () => {
    const view = await render("![remote](https://example.com/shot.png)");

    expect(view.find('[aria-label="Loading image"]')).not.toBeNull();
    expect(withClass(view, "aspect-video").length).toBeGreaterThan(0);
  });

  it("never passes a workspace source to a raw image when thread context is unavailable", async () => {
    const view = await renderWithoutThread(
      "![file URL](file:///C:/Users/shawn/project/workspace-image.svg)",
    );

    expect(testState.resources).toEqual([]);
    expect(view.text()).toContain("Image unavailable");
    expect(attributeValuesContaining(view, "file://")).toHaveLength(0);
  });

  it("blocks unsupported image schemes instead of passing them to a raw image", async () => {
    const view = await render("![unsupported](content://media/image/1)");

    expect(testState.resources).toEqual([]);
    expect(view.text()).toContain("Image unavailable");
    expect(attributeValuesContaining(view, "content://")).toHaveLength(0);
  });

  it("keeps remote images directly loadable", async () => {
    const view = await render("![remote](https://example.com/image.png)");

    expect(testState.resources).toEqual([]);
    expect(view.find('img[src="https://example.com/image.png"]')).not.toBeNull();
    expect(withClass(view, "max-w-[min(100%,30rem)]").length).toBeGreaterThan(0);
    expect(view.text()).not.toContain("Image unavailable");
  });
});
