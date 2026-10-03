import { act, createElement, useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { QueuedRecallOutcome } from "../ChatView.logic";
import { renderDom } from "../../testing/renderDom";
import { useChatEscapeKey } from "./useChatEscapeKey";

/** A composer stand-in: a form holding a focused textarea, wired the way ChatComposer is. */
function Composer(props: {
  onInterrupt: () => void;
  queuedMessageCount: number;
  onRecallQueuedMessage: () => QueuedRecallOutcome;
  canInterrupt: boolean;
}) {
  const composerFormRef = useRef<HTMLFormElement>(null);
  useChatEscapeKey(props, {
    composerFormRef,
    canInterrupt: props.canInterrupt,
    hasPendingQuestion: false,
  });
  return createElement("form", { ref: composerFormRef }, createElement("textarea"));
}

async function pressEscape() {
  const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  await act(async () => {
    window.dispatchEvent(event);
  });
  return event;
}

async function mount(props: Parameters<typeof Composer>[0]) {
  const view = await renderDom(createElement(Composer, props));
  view.find<HTMLTextAreaElement>("textarea")?.focus();
  return view;
}

describe("useChatEscapeKey", () => {
  it("stops a running turn through the composer's own interrupt action", async () => {
    const onInterrupt = vi.fn();
    await mount({
      onInterrupt,
      queuedMessageCount: 0,
      onRecallQueuedMessage: () => "nothing",
      canInterrupt: true,
    });
    const event = await pressEscape();
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("never stops the turn while the user backs out of a queued-message edit", async () => {
    const onInterrupt = vi.fn();
    const onRecallQueuedMessage = vi.fn((): QueuedRecallOutcome => "editOpen");
    await mount({ onInterrupt, queuedMessageCount: 1, onRecallQueuedMessage, canInterrupt: true });
    await pressEscape();
    await pressEscape();
    await pressEscape();
    expect(onRecallQueuedMessage).toHaveBeenCalledTimes(3);
    expect(onInterrupt).not.toHaveBeenCalled();
  });
});
