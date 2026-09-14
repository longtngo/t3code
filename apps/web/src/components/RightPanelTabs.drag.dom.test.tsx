import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../testing/renderDom";

import { RightPanelTabs } from "./RightPanelTabs";

const contextMenu = vi.hoisted(() => ({
  show: vi.fn(async () => null),
  close: vi.fn(async () => undefined),
}));

vi.mock("~/localApi", () => ({ readLocalApi: () => ({ contextMenu }) }));

const session = (tabId: string, title: string): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId,
  navStatus: { _tag: "Success", url: `http://${tabId}.local/`, title },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-09-14T00:00:00.000Z",
});
const surfaces = [
  { id: "browser:tab-1" as const, kind: "preview" as const, resourceId: "tab-1" },
  { id: "browser:tab-2" as const, kind: "preview" as const, resourceId: "tab-2" },
];

function renderTabs(onMoveSurface: (id: string, toIndex: number) => void = () => undefined) {
  return renderDom(
    <RightPanelTabs
      mode="sheet"
      surfaces={surfaces}
      environmentId={null}
      activeSurfaceId={surfaces[0]!.id}
      pendingSurfaceIds={new Set()}
      previewSessions={{ "tab-1": session("tab-1", "One"), "tab-2": session("tab-2", "Two") }}
      desktopByTabId={{}}
      terminalLabelsById={new Map()}
      onActivate={() => undefined}
      onCloseSurface={() => undefined}
      onCloseOtherSurfaces={() => undefined}
      onCloseSurfacesToRight={() => undefined}
      onCloseAllSurfaces={() => undefined}
      onMoveSurface={onMoveSurface}
      onCopyFilePath={() => undefined}
      onAddBrowser={() => undefined}
      onAddBrowserInProfile={() => undefined}
      onAddTerminal={() => undefined}
      onAddPullRequest={() => undefined}
      onAddPullRequests={() => undefined}
      onAddDiff={() => undefined}
      onAddFiles={() => undefined}
      onAddAgents={() => undefined}
      onAddTasks={() => undefined}
      onAddBackground={() => undefined}
      onUndoClosedTab={() => undefined}
      onAddDevice={() => undefined}
      liveAgentCount={0}
      liveBackgroundCount={0}
      browserAvailable
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      agentsAvailable={false}
      tasksAvailable={false}
      backgroundAvailable={false}
      closedTabCount={0}
      deviceAvailable={false}
    >
      <div>content</div>
    </RightPanelTabs>,
  );
}

/** happy-dom has no layout: give each tab a 100px-wide box side by side. */
function layOutTabs(tabs: HTMLElement[]) {
  tabs.forEach((tab, index) => {
    const left = index * 100;
    tab.getBoundingClientRect = () =>
      ({
        x: left,
        y: 0,
        left,
        top: 0,
        right: left + 100,
        bottom: 24,
        width: 100,
        height: 24,
      }) as DOMRect;
  });
}

const tabElements = (view: Awaited<ReturnType<typeof renderTabs>>) =>
  view.findAll<HTMLElement>("[data-active-tab]");

async function dispatch(target: EventTarget, event: Event) {
  await act(async () => {
    target.dispatchEvent(event);
  });
}

beforeEach(() => {
  contextMenu.show.mockClear();
  contextMenu.close.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RightPanelTabs drag to reorder", () => {
  it("moves a tab dragged onto its neighbour to that index", async () => {
    const onMoveSurface = vi.fn();
    const view = await renderTabs(onMoveSurface);
    const tabs = tabElements(view);
    layOutTabs(tabs);

    await dispatch(
      tabs[1]!,
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 150, clientY: 12 }),
    );
    for (const clientX of [140, 100, 60, 40]) {
      await dispatch(
        document,
        new MouseEvent("mousemove", { bubbles: true, clientX, clientY: 12 }),
      );
    }
    await dispatch(
      document,
      new MouseEvent("mouseup", { bubbles: true, clientX: 40, clientY: 12 }),
    );

    expect(onMoveSurface).toHaveBeenCalledWith("browser:tab-2", 0);
  });

  it("keeps a click a click", async () => {
    const onMoveSurface = vi.fn();
    const view = await renderTabs(onMoveSurface);
    const tabs = tabElements(view);
    layOutTabs(tabs);

    await dispatch(
      tabs[1]!,
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 150, clientY: 12 }),
    );
    await dispatch(
      document,
      new MouseEvent("mousemove", { bubbles: true, clientX: 152, clientY: 12 }),
    );
    await dispatch(
      document,
      new MouseEvent("mouseup", { bubbles: true, clientX: 152, clientY: 12 }),
    );

    expect(onMoveSurface).not.toHaveBeenCalled();
  });

  it("closes a long-press menu once the held tab starts moving", async () => {
    vi.useFakeTimers();
    const view = await renderTabs();
    const tabs = tabElements(view);
    layOutTabs(tabs);
    const touch = (clientX: number) =>
      new Touch({ identifier: 1, target: tabs[0]!, clientX, clientY: 12 });

    await dispatch(
      tabs[0]!,
      new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch(50)] }),
    );
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    // Holding still: the long-press menu is allowed to open.
    await dispatch(tabs[0]!, new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(contextMenu.show).toHaveBeenCalledTimes(1);
    expect(contextMenu.close).not.toHaveBeenCalled();

    await dispatch(
      document,
      new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [touch(120)] }),
    );

    expect(contextMenu.close).toHaveBeenCalled();
  });
});
