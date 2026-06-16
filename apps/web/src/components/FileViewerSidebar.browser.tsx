import "../index.css";

import { useState } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { EnvironmentApi, EnvironmentId } from "@t3tools/contracts";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "~/environmentApi";
import { FileViewerContent } from "./FileViewerSidebar";
import { RightPanelSheet } from "./RightPanelSheet";
import { RIGHT_PANEL_SHEET_EXPANDED_CLASS_NAME } from "../rightPanelLayout";
import { useFileViewerStore } from "../fileViewerStore";

const ENVIRONMENT_ID = "env-1" as EnvironmentId;

/**
 * Mirrors the chat route's mobile (sheet) composition: store-driven open state,
 * an `expanded` full-width toggle, and {@link FileViewerContent} inside a
 * {@link RightPanelSheet}. Lets these tests exercise the sheet layout without the
 * full route.
 */
function FileViewerSheetHarness() {
  const open = useFileViewerStore((state) => state.open);
  const request = useFileViewerStore((state) => state.request);
  const closeFileViewer = useFileViewerStore((state) => state.closeFileViewer);
  const [expanded, setExpanded] = useState(false);
  const handleClose = () => {
    setExpanded(false);
    closeFileViewer();
  };
  return (
    <RightPanelSheet
      open={open && request != null}
      onClose={handleClose}
      className={expanded ? RIGHT_PANEL_SHEET_EXPANDED_CLASS_NAME : undefined}
    >
      {request ? (
        <FileViewerContent
          key={request.requestId}
          request={request}
          onClose={handleClose}
          expanded={expanded}
          onToggleExpand={() => setExpanded((value) => !value)}
        />
      ) : null}
    </RightPanelSheet>
  );
}

function installMarkdownApi() {
  const readFile = vi.fn(async () => ({
    contents: "# Heading\n\nBody text.",
    resolvedPath: "/repo/project/notes.md",
  }));
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
    projects: { readFile },
  } as unknown as EnvironmentApi);
  return readFile;
}

function popup() {
  return document.querySelector('[data-slot="sheet-popup"]');
}

function viewerIframe() {
  return popup()?.querySelector("iframe") as HTMLIFrameElement | null;
}

describe("FileViewerSidebar", () => {
  afterEach(() => {
    useFileViewerStore.setState({ open: false, request: null });
    __resetEnvironmentApiOverridesForTests();
  });

  it("toggles between default and full width via the expand button", async () => {
    installMarkdownApi();
    const screen = await render(<FileViewerSheetHarness />);

    try {
      useFileViewerStore.getState().openFileViewer({
        path: "notes.md",
        cwd: "/repo/project",
        environmentId: ENVIRONMENT_ID,
        kind: "markdown",
      });

      const expandButton = page.getByRole("button", {
        name: "Expand file viewer to full width",
      });
      await expect.element(expandButton).toBeInTheDocument();

      // Default width: the narrow class is applied, the full-width override is not.
      await vi.waitFor(() => {
        expect(popup()?.className).toContain("max-w-[28rem]");
        expect(popup()?.className).not.toContain("max-w-none");
      });

      await expandButton.click();

      // Expanded: full-width override wins, narrow cap is gone, button flips to collapse.
      await vi.waitFor(() => {
        expect(popup()?.className).toContain("max-w-none");
        expect(popup()?.className).not.toContain("max-w-[28rem]");
      });
      await expect
        .element(page.getByRole("button", { name: "Collapse file viewer" }))
        .toBeInTheDocument();

      await page.getByRole("button", { name: "Collapse file viewer" }).click();

      await vi.waitFor(() => {
        expect(popup()?.className).toContain("max-w-[28rem]");
        expect(popup()?.className).not.toContain("max-w-none");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("resets to default width after the viewer is closed and reopened", async () => {
    installMarkdownApi();
    const screen = await render(<FileViewerSheetHarness />);

    try {
      useFileViewerStore.getState().openFileViewer({
        path: "notes.md",
        cwd: "/repo/project",
        environmentId: ENVIRONMENT_ID,
        kind: "markdown",
      });

      await page.getByRole("button", { name: "Expand file viewer to full width" }).click();
      await vi.waitFor(() => {
        expect(popup()?.className).toContain("max-w-none");
      });

      await page.getByRole("button", { name: "Close file viewer" }).click();

      // Reopen: width should be back to the default narrow panel.
      useFileViewerStore.getState().openFileViewer({
        path: "notes.md",
        cwd: "/repo/project",
        environmentId: ENVIRONMENT_ID,
        kind: "markdown",
      });

      await vi.waitFor(() => {
        expect(popup()?.className).toContain("max-w-[28rem]");
        expect(popup()?.className).not.toContain("max-w-none");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("renders an HTML file in a sandboxed iframe with the link interceptor injected", async () => {
    const readFile = vi.fn(async () => ({
      contents: "<!doctype html><h1>Report</h1>",
      resolvedPath: "/repo/project/report.html",
    }));
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
      projects: { readFile },
    } as unknown as EnvironmentApi);

    const screen = await render(<FileViewerSheetHarness />);
    try {
      useFileViewerStore.getState().openFileViewer({
        path: "report.html",
        cwd: "/repo/project",
        environmentId: ENVIRONMENT_ID,
        kind: "html",
      });

      await vi.waitFor(() => {
        const iframe = viewerIframe();
        expect(iframe).not.toBeNull();
        // Scripts may run, but same-origin access is withheld.
        expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts allow-popups");
        expect(iframe?.getAttribute("sandbox")).not.toContain("allow-same-origin");
        // The interceptor script is prepended ahead of the file contents.
        expect(iframe?.srcdoc).toContain("__t3FileViewerNav");
        // …and it handles same-page anchors itself (a srcdoc iframe would
        // otherwise resolve `#id` against the embedder URL and blank out).
        expect(iframe?.srcdoc).toContain("scrollIntoView");
        expect(iframe?.srcdoc).toContain("<!doctype html><h1>Report</h1>");
      });

      // HTML gets the "open in new tab" pop-out escape hatch.
      await expect
        .element(page.getByRole("button", { name: "Open in new tab" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("follows an intra-report link into the same sidebar and exposes a back button", async () => {
    const readFile = vi.fn(async ({ path }: { cwd: string; path: string }) => ({
      contents: `<!doctype html><h1>${path}</h1>`,
      resolvedPath: `/repo/project/design/${path}`,
    }));
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
      projects: { readFile },
    } as unknown as EnvironmentApi);

    const screen = await render(<FileViewerSheetHarness />);
    try {
      useFileViewerStore.getState().openFileViewer({
        path: "index.html",
        cwd: "/repo/project/design",
        environmentId: ENVIRONMENT_ID,
        kind: "html",
      });

      await vi.waitFor(() => expect(viewerIframe()).not.toBeNull());
      const iframe = viewerIframe();

      // Simulate the injected interceptor posting a relative-link click.
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { __t3FileViewerNav: true, href: "architecture.html" },
          source: iframe?.contentWindow ?? null,
        }),
      );

      // The linked page is read relative to the current file's directory…
      await vi.waitFor(() => {
        expect(readFile).toHaveBeenCalledWith({
          cwd: "/repo/project/design",
          path: "architecture.html",
        });
      });
      // …and a back button appears to walk the history.
      await expect.element(page.getByRole("button", { name: "Back" })).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("ignores nav messages when no viewer iframe is mounted (markdown view)", async () => {
    // The XSS-relevant case: in markdown view there is NO iframe, so the once-
    // subscribed message listener must reject forged nav messages. (With the old
    // `iframeRef.current && …` guard this path fell through and navigated.)
    const readFile = vi.fn(async ({ path }: { cwd: string; path: string }) =>
      path.endsWith(".md")
        ? { contents: "# notes", resolvedPath: `/repo/project/${path}` }
        : { contents: `<h1>${path}</h1>`, resolvedPath: `/repo/project/${path}` },
    );
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
      projects: { readFile },
    } as unknown as EnvironmentApi);

    const screen = await render(<FileViewerSheetHarness />);
    try {
      useFileViewerStore.getState().openFileViewer({
        path: "notes.md",
        cwd: "/repo/project",
        environmentId: ENVIRONMENT_ID,
        kind: "markdown",
      });

      // Markdown renders without an iframe.
      await vi.waitFor(() => expect(readFile).toHaveBeenCalledWith({ cwd: "/repo/project", path: "notes.md" }));
      expect(viewerIframe()).toBeNull();
      readFile.mockClear();

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { __t3FileViewerNav: true, href: "attacker.html" },
          source: window,
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(readFile).not.toHaveBeenCalledWith(
        expect.objectContaining({ path: "attacker.html" }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("toggles a markdown file between MD and backend-rendered HTML", async () => {
    const readFile = vi.fn(async () => ({
      contents: "# Heading\n\nBody text.",
      resolvedPath: "/repo/project/notes.md",
    }));
    const renderMarkdownHtml = vi.fn(async () => ({
      html: "<!doctype html><article class='markdown-body'><h1>Heading</h1></article>",
      resolvedPath: "/repo/project/notes.md",
      fromCache: false,
    }));
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
      projects: { readFile, renderMarkdownHtml },
    } as unknown as EnvironmentApi);

    const screen = await render(<FileViewerSheetHarness />);
    try {
      useFileViewerStore.getState().openFileViewer({
        path: "notes.md",
        cwd: "/repo/project",
        environmentId: ENVIRONMENT_ID,
        kind: "markdown",
      });

      // Default MD view: markdown is read and rendered without an iframe.
      await vi.waitFor(() =>
        expect(readFile).toHaveBeenCalledWith({ cwd: "/repo/project", path: "notes.md" }),
      );
      expect(viewerIframe()).toBeNull();

      // Switch to HTML: the backend conversion RPC runs and an iframe appears.
      await page.getByRole("button", { name: "HTML" }).click();
      await vi.waitFor(() => {
        expect(renderMarkdownHtml).toHaveBeenCalledWith({
          cwd: "/repo/project",
          path: "notes.md",
        });
        const iframe = viewerIframe();
        expect(iframe).not.toBeNull();
        expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts allow-popups");
        // The generated HTML also gets the link interceptor for in-report nav.
        expect(iframe?.srcdoc).toContain("__t3FileViewerNav");
        expect(iframe?.srcdoc).toContain("markdown-body");
      });

      // Back to MD: the iframe is gone again.
      await page.getByRole("button", { name: "MD" }).click();
      await vi.waitFor(() => expect(viewerIframe()).toBeNull());
    } finally {
      await screen.unmount();
    }
  });

  it("opens markdown in a new tab via a real /viewer URL", async () => {
    installMarkdownApi();
    const openSpy = vi.spyOn(window, "open").mockReturnValue({} as Window);

    const screen = await render(<FileViewerSheetHarness />);
    try {
      useFileViewerStore.getState().openFileViewer({
        path: "notes.md",
        cwd: "/repo/project",
        environmentId: ENVIRONMENT_ID,
        kind: "markdown",
      });

      // The pop-out escape hatch is offered in markdown view, not just HTML.
      const popOut = page.getByRole("button", { name: "Open in new tab" });
      await expect.element(popOut).toBeInTheDocument();

      await popOut.click();
      // It opens the real, refreshable viewer route for the resolved path —
      // same-origin (loopback test host) so the URL is used over srcdoc.
      expect(openSpy).toHaveBeenCalledTimes(1);
      const openedUrl = String(openSpy.mock.calls[0]?.[0]);
      expect(openedUrl).toContain("/viewer/repo/project/notes.md");
      expect(openSpy.mock.calls[0]?.[1]).toBe("_blank");
    } finally {
      openSpy.mockRestore();
      await screen.unmount();
    }
  });
});
