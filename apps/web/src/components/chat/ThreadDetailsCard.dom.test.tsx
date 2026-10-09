import { createRef } from "react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { renderDom } from "../../testing/renderDom";
import { useRightPanelStore } from "../../rightPanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsCard } from "./ThreadDetailsCard";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
// 424 tall leaves the inline card 400 px (12 px gap above and below).
const container = { width: 1400, height: 424 };
const SECTION = 2000;
const canvas = {
  container,
  lane: { padding: 0, minChatWidth: 0 },
  layout: resolveChatCanvasLayout({ container, preview: null }),
  previewKey: null,
  reportPreview: () => {},
  clearPreview: () => {},
  registerTimeline: () => {},
  reportDetailsCard: () => {},
  detailsCardTopInset: 0,
};

// happy-dom has no layout, so every height is 0. Give each activity section a tall height and
// make the card's content element the sum of the workspace rows and both sections.
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
function stubHeights(workspaceHeight: number) {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (
        this.hasAttribute("data-thread-details-activity") ||
        this.hasAttribute("data-thread-relationships-panel")
      )
        return SECTION;
      // The content element is the one whose first child is the render-prop output below; if that
      // shape changes this matches nothing, and the "still folds" arm goes red.
      if (this.firstElementChild?.matches("[data-testid=density]"))
        return workspaceHeight + SECTION * 2;
      return 0;
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
  useRightPanelStore.getState().setThreadPanelOpen(threadRef, "inline", false);
});

async function renderCard(workspaceHeight: number) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubHeights(workspaceHeight);
  useRightPanelStore.getState().setThreadPanelOpen(threadRef, "inline", true);
  const view = await renderDom(
    <ChatCanvasContext.Provider value={canvas}>
      <ThreadDetailsCard
        threadRef={threadRef}
        anchor={createRef<Element>()}
        handle={PopoverCreateHandle()}
        onPresentationChange={() => {}}
      >
        {(density) => (
          <div data-testid="density">
            {density}
            <div>workspace</div>
            <section data-thread-details-activity>tasks</section>
            <section data-thread-relationships-panel>lineage</section>
          </div>
        )}
      </ThreadDetailsCard>
    </ChatCanvasContext.Provider>,
  );
  return view.find("[data-thread-details-panel=inline]")?.getAttribute("data-density");
}

describe("ThreadDetailsCard density", () => {
  it("does not count growing activity sections toward the fit", async () => {
    expect(await renderCard(200)).toBe("full");
  });

  it("still folds when the workspace rows alone do not fit", async () => {
    expect(await renderCard(600)).not.toBe("full");
  });
});
