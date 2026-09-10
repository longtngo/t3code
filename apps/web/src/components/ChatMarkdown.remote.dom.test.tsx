import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../testing/renderDom";

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
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "remote-links" }, isResolved: true }),
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

import { useRightPanelStore } from "../rightPanelStore";

import ChatMarkdown, { shouldUseMarkdownFileBrowserPrimaryAction } from "./ChatMarkdown";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

const renderChip = (target: string) =>
  renderDom(<ChatMarkdown cwd="/tmp/project" threadRef={threadRef} text={`[Link](${target})`} />);

type View = Awaited<ReturnType<typeof renderDom>>;

/** The menu-only fallback the chip falls back to when nothing can open the file. */
const rendersAsMenuOnlyButton = (view: View) =>
  view.find('button[aria-label^="File options for"]') !== null;

/** The chip's primary action: an anchor that opens the file. */
const chipLink = (view: View) => view.find("a[data-markdown-copy]");

describe("file chips without shell actions", () => {
  it("keeps the open affordance for a file outside the workspace root", async () => {
    // `handleOpenInFilePreview` opens any absolute path a thread owns: outside the
    // workspace it falls back to the read-only trusted view (a report under ~/reports,
    // a temp file). Upstream #7140's `canOpenInPanel` did not know that and demanded a
    // workspace-relative path, which is null out here -- so the chip lost its primary
    // action and a tap opened the context menu, which carries neither "View in side
    // panel" nor "Open in new tab". With shell actions the editor item hides this; on
    // web and mobile it left only the two copy entries.
    const view = await renderChip("/tmp/reports/2026-08-29-followup-catalog.md");

    expect(rendersAsMenuOnlyButton(view)).toBe(false);
    expect(chipLink(view)).not.toBeNull();
  });

  it("still opens a file inside the workspace root", async () => {
    // The control that makes the assertion above mean something: same client, same
    // thread, one variable changed -- whether the path is under `cwd`.
    const view = await renderChip("/tmp/project/src/main.ts");

    expect(rendersAsMenuOnlyButton(view)).toBe(false);
    expect(chipLink(view)).not.toBeNull();
  });

  it("stays a menu-only button when no thread owns the path", async () => {
    // The negative arm, and what stops the fix from being "always render a link".
    // `openTrustedFile` needs a thread to open against; without one the chip genuinely
    // has no primary action. This is the pull-request-body surface.
    //
    // A relative path is NOT the negative case, which is worth recording because it
    // was the first thing tried here: `resolveMarkdownFileLinkTarget` resolves
    // relatives against `cwd`, so "./notes.md" lands inside the workspace and is a
    // link already.
    const view = await renderDom(
      <ChatMarkdown cwd="/tmp/project" text="[Link](/tmp/reports/out-of-tree.md)" />,
    );

    expect(rendersAsMenuOnlyButton(view)).toBe(true);
    expect(chipLink(view)).toBeNull();
  });

  it("opens the out-of-workspace file in the side panel when the chip is tapped", async () => {
    // What the affordance above is *for*: the primary action has to actually open the
    // file. Static markup could only ever show that an anchor exists.
    const environmentId = EnvironmentId.make("environment-click");
    const threadId = ThreadId.make("thread-click");
    const path = "/tmp/reports/2026-08-29-followup-catalog.md";
    const view = await renderDom(
      <ChatMarkdown
        cwd="/tmp/project"
        threadRef={{ environmentId, threadId }}
        text={`[Link](${path})`}
      />,
    );

    await view.click(chipLink(view));

    const panel = Object.values(useRightPanelStore.getState().byThreadKey).find((entry) =>
      entry.surfaces.some((surface) => surface.kind === "file" && surface.relativePath === path),
    );

    expect(panel?.isOpen).toBe(true);
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
