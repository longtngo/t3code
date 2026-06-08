import "../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const { openInPreferredEditorMock, openExternalMock, readLocalApiMock } = vi.hoisted(() => {
  const openExternalMock = vi.fn(async () => undefined);
  return {
    openInPreferredEditorMock: vi.fn(async () => "vscode"),
    openExternalMock,
    readLocalApiMock: vi.fn(() => ({
      server: { getConfig: vi.fn(async () => ({ availableEditors: ["vscode"] })) },
      shell: { openInEditor: vi.fn(async () => undefined), openExternal: openExternalMock },
    })),
  };
});

vi.mock("../editorPreferences", () => ({
  openInPreferredEditor: openInPreferredEditorMock,
}));

vi.mock("../localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: readLocalApiMock,
}));

import type { EnvironmentId } from "@t3tools/contracts";

import { __resetEnvironmentApiOverridesForTests } from "~/environmentApi";
import ChatMarkdown from "./ChatMarkdown";
import { useFileViewerStore } from "../fileViewerStore";

describe("ChatMarkdown", () => {
  afterEach(() => {
    openInPreferredEditorMock.mockClear();
    openExternalMock.mockClear();
    readLocalApiMock.mockClear();
    useFileViewerStore.setState({ open: false, request: null });
    __resetEnvironmentApiOverridesForTests();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("rewrites file uri hrefs into direct paths before rendering", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath})`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", filePath);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), filePath);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps line anchors working after rewriting file uri hrefs", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts:1](file://${filePath}#L1)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}:1`);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), `${filePath}:1`);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows column information inline when present", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath}#L1C7)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1:C7" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}:1:7`);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          `${filePath}:1:7`,
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("disambiguates duplicate file basenames inline", async () => {
    const firstPath = "/Users/yashsingh/p/t3code/apps/web/src/components/chat/MessagesTimeline.tsx";
    const secondPath = "/Users/yashsingh/p/t3code/apps/web/src/components/MessagesTimeline.tsx";
    const screen = await render(
      <ChatMarkdown
        text={`See [MessagesTimeline.tsx](file://${firstPath}) and [MessagesTimeline.tsx](file://${secondPath}).`}
        cwd="/repo/project"
      />,
    );

    try {
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · components/chat" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · src/components" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("opens an inline html path in the viewer sidebar", async () => {
    const htmlPath = "/var/folders/58/abc/architecture-review-20260606.html";
    const screen = await render(
      <ChatMarkdown
        text={`Report: \`${htmlPath}\``}
        cwd="/repo/project"
        environmentId={"env-1" as EnvironmentId}
      />,
    );

    try {
      const button = page.getByRole("button", { name: "Open architecture-review-20260606.html" });
      await expect.element(button).toBeInTheDocument();

      await button.click();

      await vi.waitFor(() => {
        const state = useFileViewerStore.getState();
        expect(state.open).toBe(true);
        expect(state.request?.path).toBe(htmlPath);
        expect(state.request?.kind).toBe("html");
        expect(state.request?.environmentId).toBe("env-1");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("suppresses the file chip without an environment", async () => {
    const screen = await render(
      <ChatMarkdown text={"Report: `/tmp/report.html`"} cwd="/repo/project" />,
    );

    try {
      await expect.element(page.getByText("/tmp/report.html")).toBeInTheDocument();
      expect(document.querySelector(".chat-markdown-file-chip")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("opens an inline markdown path in the viewer sidebar", async () => {
    const mdPath = "~/reports/pickup-v2/2026-06/2026-06-06-decisions-needed.md";
    const screen = await render(
      <ChatMarkdown
        text={`See \`${mdPath}\``}
        cwd="/repo/project"
        environmentId={"env-1" as EnvironmentId}
      />,
    );

    try {
      const button = page.getByRole("button", { name: "Open 2026-06-06-decisions-needed.md" });
      await expect.element(button).toBeInTheDocument();

      await button.click();

      await vi.waitFor(() => {
        const state = useFileViewerStore.getState();
        expect(state.open).toBe(true);
        expect(state.request?.path).toBe(mdPath);
        expect(state.request?.kind).toBe("markdown");
        expect(state.request?.environmentId).toBe("env-1");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("suppresses the markdown chip without an environment", async () => {
    const screen = await render(<ChatMarkdown text={"See `notes.md`"} cwd="/repo/project" />);

    try {
      await expect.element(page.getByText("notes.md")).toBeInTheDocument();
      expect(document.querySelector(".chat-markdown-file-chip")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("does not treat inline-code URLs as openable file paths", async () => {
    const screen = await render(
      <ChatMarkdown
        text={"Docs at `https://example.com/readme.md` and `https://example.com/index.html`"}
        cwd="/repo/project"
        environmentId={"env-1" as EnvironmentId}
      />,
    );

    try {
      await expect.element(page.getByText("https://example.com/readme.md")).toBeInTheDocument();
      expect(document.querySelector(".chat-markdown-file-chip")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("leaves ordinary inline code without path affordances", async () => {
    const screen = await render(
      <ChatMarkdown text={"Run `pnpm install` first"} cwd="/repo/project" />,
    );

    try {
      await expect.element(page.getByText("pnpm install")).toBeInTheDocument();
      expect(document.querySelector(".chat-markdown-file-chip")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("still renders fenced code blocks with a copy button (not a path affordance)", async () => {
    const screen = await render(
      <ChatMarkdown
        text={"```js\nconst notes = 'index.md';\n```"}
        cwd="/repo/project"
        environmentId={"env-1" as EnvironmentId}
      />,
    );

    try {
      await expect.element(page.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
      // The `.md` literal inside a fenced block must not grow a chip affordance.
      expect(document.querySelector(".chat-markdown-file-chip")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps normal web links unchanged", async () => {
    const screen = await render(
      <ChatMarkdown text="[OpenAI](https://openai.com/docs)" cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "OpenAI" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", "https://openai.com/docs");
      await expect.element(link).toHaveAttribute("target", "_blank");
    } finally {
      await screen.unmount();
    }
  });
});
