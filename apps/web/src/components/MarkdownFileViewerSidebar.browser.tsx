import "../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { EnvironmentApi, EnvironmentId } from "@t3tools/contracts";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "~/environmentApi";
import { MarkdownFileViewerSidebar } from "./MarkdownFileViewerSidebar";
import { useMarkdownViewerStore } from "../markdownViewerStore";

const ENVIRONMENT_ID = "env-1" as EnvironmentId;

function installEnvironmentApi() {
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

describe("MarkdownFileViewerSidebar", () => {
  afterEach(() => {
    useMarkdownViewerStore.setState({ open: false, request: null });
    __resetEnvironmentApiOverridesForTests();
  });

  it("toggles between default and full width via the expand button", async () => {
    installEnvironmentApi();
    const screen = await render(<MarkdownFileViewerSidebar />);

    try {
      useMarkdownViewerStore.getState().openMarkdownViewer({
        path: "notes.md",
        cwd: "/repo/project",
        environmentId: ENVIRONMENT_ID,
      });

      const expandButton = page.getByRole("button", {
        name: "Expand markdown viewer to full width",
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
        .element(page.getByRole("button", { name: "Collapse markdown viewer" }))
        .toBeInTheDocument();

      await page.getByRole("button", { name: "Collapse markdown viewer" }).click();

      await vi.waitFor(() => {
        expect(popup()?.className).toContain("max-w-[28rem]");
        expect(popup()?.className).not.toContain("max-w-none");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("resets to default width after the viewer is closed and reopened", async () => {
    installEnvironmentApi();
    const screen = await render(<MarkdownFileViewerSidebar />);

    try {
      useMarkdownViewerStore.getState().openMarkdownViewer({
        path: "notes.md",
        cwd: "/repo/project",
        environmentId: ENVIRONMENT_ID,
      });

      await page
        .getByRole("button", { name: "Expand markdown viewer to full width" })
        .click();
      await vi.waitFor(() => {
        expect(popup()?.className).toContain("max-w-none");
      });

      await page.getByRole("button", { name: "Close markdown viewer" }).click();

      // Reopen: width should be back to the default narrow panel.
      useMarkdownViewerStore.getState().openMarkdownViewer({
        path: "notes.md",
        cwd: "/repo/project",
        environmentId: ENVIRONMENT_ID,
      });

      await vi.waitFor(() => {
        expect(popup()?.className).toContain("max-w-[28rem]");
        expect(popup()?.className).not.toContain("max-w-none");
      });
    } finally {
      await screen.unmount();
    }
  });
});
