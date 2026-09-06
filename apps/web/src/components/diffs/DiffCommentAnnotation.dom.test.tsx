import { act } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";

import { DiffCommentAnnotation } from "./DiffCommentAnnotation";

/** Fresh spies per test, so a behavioural assertion cannot see a call from an earlier one. */
function makeCallbacks() {
  return {
    onTextChange: vi.fn(),
    onCancel: vi.fn(),
    onComment: vi.fn(),
    onDelete: vi.fn(),
  };
}

type View = Awaited<ReturnType<typeof renderDom>>;

/** Buttons here are labelled by their text, which is what the user actually reads. */
function buttonNamed(view: View, label: string): HTMLButtonElement | null {
  return (
    view.findAll<HTMLButtonElement>("button").find((button) => button.textContent === label) ?? null
  );
}

/** Types into a controlled textarea the way the browser does: native setter, then `input`. */
async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set?.bind(textarea);
  await act(async () => {
    setValue?.(value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("DiffCommentAnnotation", () => {
  it("renders the shared draft composer directly in the selected diff", async () => {
    const view = await renderDom(
      <DiffCommentAnnotation kind="draft" rangeLabel="+78" text="" {...makeCallbacks()} />,
    );

    expect(view.find("[data-diff-comment-annotation]")?.className).toContain("font-sans");
    expect(view.find("[data-slot='composer-banner']")).toBeNull();
    expect(view.find("[data-composer-banner-surface]")).toBeNull();
    expect(view.findAll("[class*='font-mono']")).toHaveLength(0);
    expect(view.text()).not.toContain("Local comment");
    expect(view.text()).not.toContain("on +78");
    expect(view.text()).toContain("⌘/Ctrl Enter to send");
    expect(view.find<HTMLTextAreaElement>("textarea")?.placeholder).toBe("Add a comment…");
    expect(buttonNamed(view, "Comment")).not.toBeNull();
    // `autoFocus` never reaches the DOM as an attribute on the client; React focuses the node
    // instead, so the focus itself is the only observable form of that prop.
    expect(document.activeElement).toBe(view.find("textarea"));
    const textareaControl = view.find("[data-slot='textarea-control']");
    expect(textareaControl).not.toBeNull();
    expect(textareaControl?.className).not.toContain("ring-ring");
    expect(view.findAll("[class*='cursor-text']").length).toBeGreaterThan(0);
  });

  it("lets a pull-request diff configure actions without replacing the composer", async () => {
    const view = await renderDom(
      <DiffCommentAnnotation
        kind="draft"
        rangeLabel="src/app.ts:4"
        text=""
        {...makeCallbacks()}
        submitLabel="Add to review"
        secondaryAction={{
          label: "Add to agent",
          onAction: vi.fn(),
        }}
      />,
    );

    expect(view.find<HTMLTextAreaElement>("textarea")?.placeholder).toBe("Add a comment…");
    expect(buttonNamed(view, "Add to review")).not.toBeNull();
    expect(buttonNamed(view, "Add to review")?.disabled).toBe(true);
    expect(buttonNamed(view, "Add to agent")?.disabled).toBe(true);
  });

  it("renders a saved comment without a nested card or redundant range label", async () => {
    const view = await renderDom(
      <DiffCommentAnnotation
        kind="comment"
        rangeLabel="+78"
        text="Please keep this branch explicit."
        {...makeCallbacks()}
      />,
    );

    const annotation = view.find("[data-diff-comment-annotation]");
    expect(annotation?.className).toContain("font-sans");
    expect(view.find("[data-slot='composer-banner']")).toBeNull();
    expect(view.find("[data-composer-banner-surface]")).toBeNull();
    expect(view.text()).not.toContain("on +78");
    expect(view.text()).toContain("Please keep this branch explicit.");
    expect(view.find("[aria-label='Delete comment']")).not.toBeNull();
    expect(annotation?.className).toContain("border-s-2");
    expect(annotation?.className).toContain("bg-primary/[0.045]");
    expect(view.find(".lucide-message-circle")).not.toBeNull();
  });

  it("renders draft text owned by the annotation wrapper", async () => {
    const view = await renderDom(
      <DiffCommentAnnotation
        kind="draft"
        rangeLabel="+78"
        text="Keep this unsaved draft"
        {...makeCallbacks()}
      />,
    );

    expect(view.find<HTMLTextAreaElement>("textarea")?.value).toBe("Keep this unsaved draft");
  });

  it("submits the trimmed draft to the owner", async () => {
    const callbacks = makeCallbacks();
    const view = await renderDom(
      <DiffCommentAnnotation
        kind="draft"
        rangeLabel="+78"
        text="  Keep this branch explicit.  "
        {...callbacks}
      />,
    );

    await view.click(buttonNamed(view, "Comment"));

    expect(callbacks.onComment).toHaveBeenCalledWith("Keep this branch explicit.");
  });

  it("reports every keystroke to the owner instead of keeping its own draft", async () => {
    const callbacks = makeCallbacks();
    const view = await renderDom(
      <DiffCommentAnnotation kind="draft" rangeLabel="+78" text="" {...callbacks} />,
    );

    await typeInto(view.find<HTMLTextAreaElement>("textarea")!, "half a thought");

    expect(callbacks.onTextChange).toHaveBeenCalledWith("half a thought");
  });

  it("keeps its own draft when nobody owns the text", async () => {
    const callbacks = makeCallbacks();
    const view = await renderDom(
      <DiffCommentAnnotation
        kind="draft"
        rangeLabel="+78"
        text=""
        onCancel={callbacks.onCancel}
        onComment={callbacks.onComment}
      />,
    );

    await typeInto(view.find<HTMLTextAreaElement>("textarea")!, "an unowned draft");
    expect(view.find<HTMLTextAreaElement>("textarea")?.value).toBe("an unowned draft");

    await view.click(buttonNamed(view, "Comment"));
    expect(callbacks.onComment).toHaveBeenCalledWith("an unowned draft");
  });

  it("abandons the draft when the composer is cancelled", async () => {
    const callbacks = makeCallbacks();
    const view = await renderDom(
      <DiffCommentAnnotation kind="draft" rangeLabel="+78" text="a draft" {...callbacks} />,
    );

    await view.click(buttonNamed(view, "Cancel"));

    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
    expect(callbacks.onComment).not.toHaveBeenCalled();
  });

  it("hands the trimmed draft to a pull-request secondary action", async () => {
    const onAction = vi.fn();
    const view = await renderDom(
      <DiffCommentAnnotation
        kind="draft"
        rangeLabel="src/app.ts:4"
        text="  route this to the agent  "
        {...makeCallbacks()}
        submitLabel="Add to review"
        secondaryAction={{ label: "Add to agent", onAction }}
      />,
    );

    await view.click(buttonNamed(view, "Add to agent"));

    expect(onAction).toHaveBeenCalledWith("route this to the agent");
  });

  it("deletes a saved comment through its owner", async () => {
    const callbacks = makeCallbacks();
    const view = await renderDom(
      <DiffCommentAnnotation
        kind="comment"
        rangeLabel="+78"
        text="Please keep this branch explicit."
        {...callbacks}
      />,
    );

    await view.click(view.find("[aria-label='Delete comment']"));

    expect(callbacks.onDelete).toHaveBeenCalledTimes(1);
  });
});
