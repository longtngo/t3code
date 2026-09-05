import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerPendingReviewComments } from "./ComposerPendingReviewComments";

const comment = {
  id: "selection-1",
  sectionId: "pull-request:42",
  sectionTitle: "PR #42",
  filePath: "src/app.ts",
  startIndex: 3,
  endIndex: 5,
  rangeLabel: "L4-L6",
  text: "",
  diff: "+const answer = 42;",
};

let host: HTMLElement | undefined;
let root: Root | undefined;

const render = async (onRemove: (commentId: string) => void) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<ComposerPendingReviewComments comments={[comment]} onRemove={onRemove} />);
  });
  return host;
};

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe("ComposerPendingReviewComments", () => {
  it("keeps an empty-note chip visible without an empty tooltip", async () => {
    const container = await render(vi.fn());

    expect(container.textContent).toContain("src/app.ts L4-L6");
    expect(container.querySelector('[data-slot="tooltip-trigger"]')).toBeNull();
  });

  // Only reachable with a real DOM: the previous version of this test rendered to static markup,
  // which cannot dispatch an event, so the remove affordance went uncovered.
  it("removes the comment it was clicked on", async () => {
    const onRemove = vi.fn();
    const container = await render(onRemove);

    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove comment on src/app.ts L4-L6"]',
    );
    expect(remove).not.toBeNull();
    await act(async () => remove?.click());

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("selection-1");
  });
});
