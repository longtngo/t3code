import { act } from "react";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { renderToStaticMarkup } from "react-dom/server";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ForeignQueueRow, SidebarQueueBlock } from "./SidebarQueueBlock";
import { useQueueSlotSettingsStore } from "../queueSlotSettingsStore";
import { renderDom } from "../testing/renderDom";
import { threadQueueEntryKey, type ThreadQueueEntry } from "../threadQueueRules";
import { queueDeviceId, useThreadQueueStore } from "../threadQueueStore";

const entry = (id: string): ThreadQueueEntry => ({
  environmentId: "env" as EnvironmentId,
  threadId: id as ThreadId,
  draftId: null,
  addedAt: 0,
  ownerId: "device-a",
  label: id,
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

/** The class attribute of the element carrying the queue-header testid, and nothing else's. */
function headerClass(markup: string) {
  const tag = markup.match(/<[^>]*data-testid="sidebar-queue-header"[^>]*>/)?.[0];
  if (tag === undefined) throw new Error("no queue header in the markup");
  return tag.match(/class="([^"]*)"/)?.[1] ?? "";
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
    // This is the state the header gets covered in - no slack to collapse into, so the sorting
    // preview shifts a row onto it. BOTH classes are load-bearing and neither is cosmetic: z-20
    // wins the hit test against the transformed row, and the background is what stops the row's
    // title rendering through. Measured live with a sentinel background on the rows: with both,
    // 0 of 6480 band pixels show row ink; with z-20 alone, 5953; with neither, 6088.
    //
    // Two traps, both of which a real mutation walked through:
    //  - read the HEADER's own class attribute, not the whole markup - a plain
    //    `toContain("bg-sidebar")` matches other elements in this tree and stayed green with the
    //    background deleted;
    //  - match `bg-sidebar` as a WHOLE token - as a substring it also accepts `bg-sidebar/50`, a
    //    half-transparent header you can read the row's title straight through.
    expect(headerClass(markup).split(/\s+/)).toContain("z-20");
    expect(headerClass(markup).split(/\s+/)).toContain("bg-sidebar");
  });
});

describe("queue slots header control", () => {
  beforeEach(() => {
    useQueueSlotSettingsStore.setState({ slots: 1, perProvider: false, providerSlots: {} });
    useThreadQueueStore.setState({ paused: false });
  });

  const mount = () =>
    renderDom(
      <DndContext>
        <SortableContext items={entries.map(threadQueueEntryKey)}>
          <ul>
            <SidebarQueueBlock
              entries={entries}
              routeKey={null}
              routeDraftId={null}
              expanded
              onToggleExpanded={() => {}}
              dragging={false}
              collapse={false}
              renderEntry={(queued) => <li>{queued.threadId}</li>}
            />
          </ul>
        </SortableContext>
      </DndContext>,
    );
  const press = (target: Element, key: string) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  const slotText = (view: Awaited<ReturnType<typeof mount>>) =>
    view.find('[data-testid="sidebar-queue-slots"]')?.textContent;

  // A row this device can open still says when another device holds its draft.
  it("hands a row queued on another device its note, and this device's own rows none", async () => {
    const view = await renderDom(
      <DndContext>
        <ul>
          <SidebarQueueBlock
            entries={[entry("theirs"), { ...entry("mine"), ownerId: queueDeviceId() }]}
            routeKey={null}
            routeDraftId={null}
            expanded
            onToggleExpanded={() => {}}
            dragging={false}
            collapse={false}
            renderEntry={(queued, _bag, note) => <li data-row={queued.threadId}>{note}</li>}
          />
        </ul>
      </DndContext>,
    );
    expect(view.find('[data-row="theirs"]')?.textContent).toBe("Queued on another device");
    expect(view.find('[data-row="mine"]')?.textContent).toBe("");
  });

  it("shows the slot count and edits it from the gear popover", async () => {
    const view = await mount();
    expect(slotText(view)).toBe("1");
    await view.click(view.find('button[aria-label="Queue slots"]'));
    expect(document.body.textContent).toContain("Active slots");
    await view.click(document.querySelector('button[aria-label="Increase active slots"]'));
    expect(useQueueSlotSettingsStore.getState().slots).toBe(2);
    expect(slotText(view)).toBe("2");
  });

  it("edits the slots from the keyboard and closes the popover on Escape", async () => {
    const view = await mount();
    await view.click(view.find('button[aria-label="Queue slots"]'));
    const input = document.querySelector<HTMLInputElement>('input[aria-label="active slots"]');
    if (input === null) throw new Error("no active slots input");
    input.focus();
    await press(input, "ArrowUp");
    expect(useQueueSlotSettingsStore.getState().slots).toBe(2);
    expect(document.body.textContent).toContain("Active slots");
    await press(input, "Escape");
    expect(document.body.textContent).not.toContain("Active slots");
  });

  const type = (input: HTMLInputElement, text: string) =>
    act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const blur = (input: HTMLInputElement) =>
    act(async () => {
      input.blur();
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
  const openSlotsInput = async (view: Awaited<ReturnType<typeof mount>>) => {
    await view.click(view.find('button[aria-label="Queue slots"]'));
    const input = document.querySelector<HTMLInputElement>('input[aria-label="active slots"]');
    if (input === null) throw new Error("no active slots input");
    input.focus();
    return input;
  };

  it("saves a typed slot count on commit, not per keystroke", async () => {
    const view = await mount();
    const input = await openSlotsInput(view);
    await type(input, "1");
    await type(input, "12");
    expect(input.value).toBe("12");
    expect(useQueueSlotSettingsStore.getState().slots).toBe(1);
    await blur(input);
    expect(useQueueSlotSettingsStore.getState().slots).toBe(12);
  });

  it("keeps the saved slot count when the field is cleared and committed", async () => {
    const view = await mount();
    const input = await openSlotsInput(view);
    await type(input, "");
    expect(useQueueSlotSettingsStore.getState().slots).toBe(1);
    await blur(input);
    expect(useQueueSlotSettingsStore.getState().slots).toBe(1);
    expect(input.value).toBe("1");
  });

  it("labels the queue Paused when there are no slots", async () => {
    useQueueSlotSettingsStore.setState({ slots: 0 });
    const view = await mount();
    expect(slotText(view)).toBe("0");
    expect(view.text()).toContain("Paused");
  });
});

describe("queue rows from another device", () => {
  const foreign = {
    ...entry("elsewhere"),
    draftId: "draft-b",
    ownerId: "device-b",
    label: "Fix it",
  };
  const bag = {
    listeners: undefined,
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  };
  const mount = () =>
    renderDom(
      <ul>
        <ForeignQueueRow entry={foreign as ThreadQueueEntry} sortable={bag} />
      </ul>,
    );
  const removeButton = (view: Awaited<ReturnType<typeof mount>>) =>
    view.find<HTMLButtonElement>('button[aria-label="Remove from queue"]');

  beforeEach(() => {
    useThreadQueueStore.setState({
      mode: "local",
      readOnly: false,
      entries: [foreign as ThreadQueueEntry, entry("mine")],
    });
  });

  it("shows the entry's label and removes it from the Queue", async () => {
    const view = await mount();
    expect(view.text()).toContain("Fix it");
    expect(view.text()).toContain("Queued on another device");
    await view.click(removeButton(view));
    expect(useThreadQueueStore.getState().entries.map((queued) => queued.threadId)).toEqual([
      "mine",
    ]);
  });

  it("this device's own entry for a thread it cannot see does not claim another device", async () => {
    const view = await renderDom(
      <ul>
        <ForeignQueueRow entry={{ ...entry("unseen"), ownerId: queueDeviceId() }} sortable={bag} />
      </ul>,
    );
    expect(view.text()).toContain("Not available on this device");
    expect(view.text()).not.toContain("Queued on another device");
  });

  it("cannot be removed, and the queue cannot be paused, while the queue is read-only", async () => {
    useThreadQueueStore.setState({ readOnly: true });
    const view = await mount();
    expect(removeButton(view)?.disabled).toBe(true);
    const block = await renderDom(
      <DndContext>
        <ul>
          <SidebarQueueBlock
            entries={entries}
            routeKey={null}
            routeDraftId={null}
            expanded
            onToggleExpanded={() => {}}
            dragging={false}
            collapse={false}
            renderEntry={(queued) => <li>{queued.threadId}</li>}
          />
        </ul>
      </DndContext>,
    );
    expect(block.find<HTMLButtonElement>('[data-testid="sidebar-queue-pause"]')?.disabled).toBe(
      true,
    );
  });
});
