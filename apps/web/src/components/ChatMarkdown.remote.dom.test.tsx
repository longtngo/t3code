import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../testing/renderDom";

/**
 * The chip on a client with NO shell actions (browser or mobile). `ChatMarkdown.test.tsx` mocks
 * `local-exec`, which always gives the chip a primary action, so these gates are unreachable there;
 * the mock is why this file is separate.
 */
vi.mock("../hooks/useFileMetadata", () => ({ useFileMetadata: () => null }));
const atomReader = vi.hoisted(() => ({
  initialValues: (): Array<readonly [never, unknown]> => [],
}));
vi.mock("@effect/atom-react", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  let registry: ReturnType<typeof AtomRegistry.make> | null = null;
  // ChatMarkdown derives its server-config fields in an atom of its own; evaluate that one for
  // real (seeded with this file's config) and keep every other read on the stub.
  const isConfigFields = (atom: unknown) =>
    (atom as { label?: readonly [string, string] }).label?.[0] === "markdown-server-config-fields";
  return {
    useAtomValue: (atom: never) => {
      if (!isConfigFields(atom)) return null;
      registry ??= AtomRegistry.make({ initialValues: atomReader.initialValues() });
      return registry.get(atom);
    },
  };
});
vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
  useRenderedAppearance: () => "dark",
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/session")>();
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...actual,
    useEnvironmentScope: hasScope,
    readEnvironmentScope: hasScope,
    usePreparedConnection: () => ({ _tag: "Loading" }),
  };
});
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
  readEnvironmentSupportsServerBrowser: () => false,
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
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import { useRightPanelStore } from "../rightPanelStore";

import ChatMarkdown from "./ChatMarkdown";
import { shouldUseMarkdownFileBrowserPrimaryAction } from "./chat/MarkdownFileLink.logic";

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
    // `handleOpenInFilePreview` opens any absolute path a thread owns, falling back outside the
    // workspace to the read-only trusted view. Demanding a workspace-relative path cost the chip
    // its primary action, leaving web and mobile only the two copy entries.
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
    // The negative arm: without a thread `openTrustedFile` has nothing to open against, so the chip
    // has no primary action (the pull-request-body surface). A relative path is NOT the negative
    // case: it resolves against `cwd` and is already a link.
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
  // The chip's affordance must count the read-only trusted view; "should the browser win over the
  // panel?" must not, because out of tree the panel is only a source view. Feeding one flag to both
  // flipped out-of-workspace .html from the browser to the source view.
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
