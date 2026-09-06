import { EnvironmentId, type PreviewAnnotationPayload } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";
import { ComposerPreviewAnnotationCards } from "./ComposerPreviewAnnotationCards";

const annotation: PreviewAnnotationPayload = {
  id: "annotation_1",
  pageUrl: "http://localhost:3000/welcome",
  pageTitle: "Welcome",
  comment: "Make this headline feel intentional.",
  elements: [],
  regions: [{ id: "region_1", rect: { x: 1, y: 2, width: 30, height: 20 } }],
  strokes: [],
  styleChanges: [
    {
      targetId: "element_1",
      selector: "h1",
      property: "font-size",
      previousValue: "32px",
      value: "40px",
    },
  ],
  screenshot: null,
  createdAt: "2026-06-13T00:00:00.000Z",
};

const screenshot = {
  type: "image" as const,
  id: annotation.id,
  name: "annotation.png",
  mimeType: "image/png",
  sizeBytes: 3,
  previewUrl: "blob:annotation",
  file: new File([new Uint8Array([1, 2, 3])], "annotation.png", { type: "image/png" }),
};

const failedUpload = {
  [screenshot.id]: {
    status: "failed" as const,
    environmentId: EnvironmentId.make("environment-1"),
    reason: "Upload rejected",
  },
};

describe("ComposerPreviewAnnotationCards", () => {
  it("presents the annotation as one contextual attachment", async () => {
    const view = await renderDom(
      <ComposerPreviewAnnotationCards
        annotations={[annotation]}
        images={[]}
        onRemove={vi.fn()}
        onExpandImage={vi.fn()}
      />,
    );

    expect(view.text()).toContain("Make this headline feel intentional.");
    // One trigger per non-empty target group: the region and the style change.
    expect(view.findAll('[data-slot="tooltip-trigger"]')).toHaveLength(2);
    // The counts belong to the tooltip, not to a native `title` (which would
    // draw a second, differently styled bubble alongside it) and not to the
    // card's own text.
    expect(view.find('[title="1 region"]')).toBeNull();
    expect(view.find('[title="1 style change"]')).toBeNull();
    expect(view.text()).not.toContain("1 region");
    expect(view.text()).not.toContain("1 style change");
    // The card is a compact chip: no page title, no URL, no redundant heading.
    expect(view.text()).not.toContain("Welcome");
    expect(view.text()).not.toContain("localhost:3000");
    expect(view.text()).not.toContain("Preview annotation");
  });

  it("uses the shared button contract for removal", async () => {
    const view = await renderDom(
      <ComposerPreviewAnnotationCards
        annotations={[annotation]}
        images={[]}
        onRemove={vi.fn()}
        onExpandImage={vi.fn()}
      />,
    );

    const remove = view.find('[aria-label="Remove preview annotation"]');
    expect(remove).not.toBeNull();
    expect(remove?.getAttribute("data-slot")).toBe("button");
  });

  // Removal is the only way to take an annotation back out of the draft, and it
  // has to name which one — the composer can hold several at once.
  it("removes the annotation it was clicked on", async () => {
    const onRemove = vi.fn();
    const view = await renderDom(
      <ComposerPreviewAnnotationCards
        annotations={[annotation]}
        images={[]}
        onRemove={onRemove}
        onExpandImage={vi.fn()}
      />,
    );

    await view.click(view.find('[aria-label="Remove preview annotation"]'));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("annotation_1");
  });

  it("shows a retry action for a failed screenshot upload", async () => {
    const view = await renderDom(
      <ComposerPreviewAnnotationCards
        annotations={[annotation]}
        images={[screenshot]}
        uploadsByImageId={failedUpload}
        onRetryUpload={vi.fn()}
        onRemove={vi.fn()}
        onExpandImage={vi.fn()}
      />,
    );

    expect(view.find('[aria-label="Retry upload for annotation.png"]')).not.toBeNull();
  });

  // A retry control that renders but reports nothing leaves the annotation
  // permanently attached to an upload that never lands.
  it("retries the failed upload for the image it belongs to", async () => {
    const onRetryUpload = vi.fn();
    const view = await renderDom(
      <ComposerPreviewAnnotationCards
        annotations={[annotation]}
        images={[screenshot]}
        uploadsByImageId={failedUpload}
        onRetryUpload={onRetryUpload}
        onRemove={vi.fn()}
        onExpandImage={vi.fn()}
      />,
    );

    await view.click(view.find('[aria-label="Retry upload for annotation.png"]'));

    expect(onRetryUpload).toHaveBeenCalledTimes(1);
    expect(onRetryUpload).toHaveBeenCalledWith(screenshot);
  });

  it("opens the screenshot crop from its thumbnail", async () => {
    const onExpandImage = vi.fn();
    const view = await renderDom(
      <ComposerPreviewAnnotationCards
        annotations={[annotation]}
        images={[screenshot]}
        onRemove={vi.fn()}
        onExpandImage={onExpandImage}
      />,
    );

    await view.click(view.find('[aria-label="Preview annotation.png"]'));

    expect(onExpandImage).toHaveBeenCalledTimes(1);
    expect(onExpandImage).toHaveBeenCalledWith("annotation_1");
  });
});
