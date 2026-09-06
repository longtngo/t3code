import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";
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

describe("ComposerPendingReviewComments", () => {
  it("keeps an empty-note chip visible without an empty tooltip", async () => {
    const view = await renderDom(
      <ComposerPendingReviewComments comments={[comment]} onRemove={vi.fn()} />,
    );

    expect(view.text()).toContain("src/app.ts L4-L6");
    expect(view.find('[data-slot="tooltip-trigger"]')).toBeNull();
  });

  // Only reachable with a real DOM: the previous version rendered to static markup, which cannot
  // dispatch an event, so the remove affordance went uncovered.
  it("removes the comment it was clicked on", async () => {
    const onRemove = vi.fn();
    const view = await renderDom(
      <ComposerPendingReviewComments comments={[comment]} onRemove={onRemove} />,
    );

    await view.click(view.find('button[aria-label="Remove comment on src/app.ts L4-L6"]'));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("selection-1");
  });
});
