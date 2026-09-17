import { describe, expect, it } from "vite-plus/test";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { renderToStaticMarkup } from "react-dom/server";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { SidebarQueueBlock } from "./SidebarQueueBlock";
import { threadQueueEntryKey, type ThreadQueueEntry } from "../threadQueueStore";

const entry = (id: string): ThreadQueueEntry => ({
  environmentId: "env" as EnvironmentId,
  threadId: id as ThreadId,
  draftId: null,
  addedAt: 0,
});
const entries = [entry("one"), entry("two")];

function render(dragging: boolean, collapse: boolean) {
  return renderToStaticMarkup(
    <DndContext>
      <SortableContext items={entries.map(threadQueueEntryKey)}>
        <ul>
          <SidebarQueueBlock
            entries={entries}
            routeKey={null}
            routeDraftId={null}
            expanded
            onToggleExpanded={() => {}}
            dragging={dragging}
            collapse={collapse}
            renderEntry={(queued) => <li data-row={queued.threadId}>{queued.threadId}</li>}
          />
        </ul>
      </SortableContext>
    </DndContext>,
  );
}

describe("SidebarQueueBlock", () => {
  it("lists the queued rows at rest", () => {
    const markup = render(false, false);
    expect(markup).toContain('data-row="one"');
    expect(markup).toContain('data-row="two"');
  });

  it("collapses to a docked header while a main-list drag runs", () => {
    // The drag preview opens space where the Queue sits: the rows step aside and the header
    // docks above the shelves, so the drop zone never moves under the pointer.
    const markup = render(true, true);
    expect(markup).not.toContain("data-row=");
    expect(markup).toContain("mt-auto");
    // The rows are gone, so the count has to say how many are waiting.
    expect(markup).toContain("Queue (2)");
  });

  it("keeps the rows in place when the drag cannot collapse the list", () => {
    // A scrolling sidebar has no slack: the Queue stays as it is and only the drop outline shows.
    const markup = render(true, false);
    expect(markup).toContain('data-row="one"');
    expect(markup).toContain('data-row="two"');
    expect(markup).not.toContain("mt-auto");
    expect(markup).toContain("border-dashed");
    expect(markup).not.toContain("Queue (2)");
  });
});
