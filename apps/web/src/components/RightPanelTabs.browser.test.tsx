import type { DesktopPreviewFavicon, PreviewSessionSnapshot } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const setAudioMuted = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ theme: "light", resolvedTheme: "light", themeHalves: null }) as never,
}));
vi.mock(import("~/browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => ({ profiles: [] }) as never,
}));
vi.mock(import("./preview/previewBridge"), () => ({
  previewBridge: { setAudioMuted } as never,
}));

import { RightPanelTabs } from "./RightPanelTabs";

// A real 1x1 PNG, so the browser keeps it instead of falling back on a decode error.
const PIXEL_B =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const previewSurface = {
  id: "browser:tab-1" as const,
  kind: "preview" as const,
  resourceId: "tab-1",
};
const secondSurface = {
  id: "browser:tab-2" as const,
  kind: "preview" as const,
  resourceId: "tab-2",
};
const sessions: Readonly<Record<string, PreviewSessionSnapshot>> = {
  "tab-1": {
    threadId: "thread-1",
    tabId: "tab-1",
    navStatus: { _tag: "Success", url: "http://24x.xf.local/", title: "Local site" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-08-09T00:00:00.000Z",
  },
  "tab-2": {
    threadId: "thread-1",
    tabId: "tab-2",
    navStatus: { _tag: "Success", url: "http://24x.xf.local/admin", title: "Admin" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-08-09T00:00:00.000Z",
  },
};

const favicon = (dataUrl: string, pageUrl: string): DesktopPreviewFavicon => ({
  dataUrl,
  pageUrl,
  capturedAt: 1,
});

function overlay(icon: DesktopPreviewFavicon | null) {
  return {
    hasWebContents: true,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system" as const,
    audioMuted: false,
    audible: false,
    controller: "none" as const,
    favicon: icon,
  };
}

const noop = () => undefined;

function renderTabs(
  handlers: { onActivate?: (id: string) => void; onCloseSurface?: (id: string) => void } = {},
) {
  const second = favicon(PIXEL_B, "http://24x.xf.local/admin");
  return render(
    <RightPanelTabs
      mode="inline"
      open
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      })}
      surfaces={[previewSurface, secondSurface]}
      environmentId={null}
      activeSurfaceId={previewSurface.id}
      pendingSurfaceIds={new Set()}
      previewSessions={sessions}
      desktopByTabId={{ "tab-1": overlay(null), "tab-2": overlay(second) }}
      previewRuntimeTabId={(tabId) => `runtime:${tabId}`}
      terminalLabelsById={new Map()}
      onActivate={(surface) => handlers.onActivate?.(surface.id)}
      onCloseSurface={(surface) => handlers.onCloseSurface?.(surface.id)}
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseAllSurfaces={noop}
      onCopyFilePath={noop}
      onAddBrowser={noop}
      onAddBrowserInProfile={noop}
      onAddTerminal={noop}
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddDiff={noop}
      onAddFiles={noop}
      onAddDevice={noop}
      browserAvailable
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
    >
      <div>content</div>
    </RightPanelTabs>,
  );
}

// FORK: the drag-to-reorder sensors must leave a click on a tab's title and close control alone.
describe("preview tab controls", () => {
  it("activates the tab whose title was clicked", async () => {
    const onActivate = vi.fn();
    await using screen = await renderTabs({ onActivate });

    const secondTitle = [...screen.container.querySelectorAll("button")].find(
      (element) => element.textContent === "Admin",
    );
    await act(() => secondTitle!.click());

    expect(onActivate).toHaveBeenCalledWith(secondSurface.id);
  });

  it("closes only the tab whose close control was clicked", async () => {
    const onCloseSurface = vi.fn();
    await using screen = await renderTabs({ onCloseSurface });

    const close = [...screen.container.querySelectorAll("button")].find(
      (element) => element.ariaLabel === "Close Admin",
    );
    await act(() => close!.click());

    expect(onCloseSurface).toHaveBeenCalledTimes(1);
    expect(onCloseSurface).toHaveBeenCalledWith(secondSurface.id);
  });
});
