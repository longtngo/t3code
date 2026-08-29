import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

/**
 * The chip on a client with NO shell actions — a browser or the mobile app.
 *
 * `ChatMarkdown.test.tsx` mocks `remote-links`' sibling `local-exec`, which hands the
 * chip an editor action and so a primary action no matter what else is false. Every
 * gate below is therefore unreachable from that file, and a defect that only bites
 * without shell actions renders correctly there. This file exists to hold that arm;
 * the mock is the whole point of the separate file.
 */
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({ readThreadShell: () => null, useProjects: () => [] }));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "remote-links" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown, { shouldUseMarkdownFileBrowserPrimaryAction } from "./ChatMarkdown";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

const renderChip = (target: string) =>
  renderToStaticMarkup(
    <ChatMarkdown cwd="/tmp/project" threadRef={threadRef} text={`[Link](${target})`} />,
  );

/** The menu-only fallback the chip falls back to when nothing can open the file. */
const rendersAsMenuOnlyButton = (html: string) => html.includes("File options for");

describe("file chips without shell actions", () => {
  it("keeps the open affordance for a file outside the workspace root", () => {
    // `handleOpenInFilePreview` opens any absolute path a thread owns: outside the
    // workspace it falls back to the read-only trusted view (a report under ~/reports,
    // a temp file). Upstream #7140's `canOpenInPanel` did not know that and demanded a
    // workspace-relative path, which is null out here -- so the chip lost its primary
    // action and a tap opened the context menu, which carries neither "View in side
    // panel" nor "Open in new tab". With shell actions the editor item hides this; on
    // web and mobile it left only the two copy entries.
    const html = renderChip("/tmp/reports/2026-08-29-followup-catalog.md");

    expect(rendersAsMenuOnlyButton(html)).toBe(false);
    expect(html).toContain("<a ");
  });

  it("still opens a file inside the workspace root", () => {
    // The control that makes the assertion above mean something: same client, same
    // thread, one variable changed -- whether the path is under `cwd`.
    const html = renderChip("/tmp/project/src/main.ts");

    expect(rendersAsMenuOnlyButton(html)).toBe(false);
    expect(html).toContain("<a ");
  });

  it("stays a menu-only button when no thread owns the path", () => {
    // The negative arm, and what stops the fix from being "always render a link".
    // `openTrustedFile` needs a thread to open against; without one the chip genuinely
    // has no primary action. This is the pull-request-body surface.
    //
    // A relative path is NOT the negative case, which is worth recording because it
    // was the first thing tried here: `resolveMarkdownFileLinkTarget` resolves
    // relatives against `cwd`, so "./notes.md" lands inside the workspace and is a
    // link already.
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd="/tmp/project" text="[Link](/tmp/reports/out-of-tree.md)" />,
    );

    expect(rendersAsMenuOnlyButton(html)).toBe(true);
  });
});

describe("browser-vs-panel primary action outside the workspace", () => {
  // The chip's affordance and this choice need DIFFERENT questions answered.
  // "Can anything open this?" must count the read-only trusted view, or the chip
  // loses its primary action out of tree. "Should the browser win over the panel?"
  // must not, because out here the panel only offers a read-only source view and
  // the rendered browser view is better. Feeding the widened flag to both flips
  // out-of-workspace .html from the integrated browser to the source view -- a
  // regression a review caught before this shipped.
  const htmlOutsideWorkspace = {
    iconPath: "/tmp/reports/coverage.html",
    canOpenInEditor: false,
    canOpenInBrowser: true,
  };

  it("keeps the integrated browser for out-of-workspace HTML", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...htmlOutsideWorkspace,
        // The narrow sense: no workspace-relative path out here.
        canOpenInPanel: false,
      }),
    ).toBe(true);
  });

  it("would have handed HTML to the panel if the widened flag were passed here", () => {
    // Pins the mistake itself, so a future edit that passes `canOpenInPanel`
    // instead of `canOpenInWorkspacePanel` fails rather than silently reroutes.
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...htmlOutsideWorkspace,
        canOpenInPanel: true,
      }),
    ).toBe(false);
  });
});
