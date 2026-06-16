import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { TasksPanelToggle } from "./TasksPanelToggle";

function renderToggle(props?: Partial<Parameters<typeof TasksPanelToggle>[0]>) {
  return render(
    <TasksPanelToggle
      open={false}
      onToggle={vi.fn()}
      label="Tasks"
      completedCount={0}
      totalCount={0}
      hasActive={false}
      {...props}
    />,
  );
}

function toggle() {
  return document.querySelector<HTMLButtonElement>('[aria-label="Toggle tasks panel"]');
}

describe("TasksPanelToggle", () => {
  it("renders a permanent toggle even with no tracked activity", async () => {
    await renderToggle();
    expect(toggle()).not.toBeNull();
    // No count badge, no spinner when nothing is tracked.
    expect(toggle()?.textContent).toBe("Tasks");
    expect(toggle()?.querySelector(".animate-spin")).toBeNull();
  });

  it("shows the completed/total count when items are tracked", async () => {
    await renderToggle({ completedCount: 2, totalCount: 5 });
    expect(toggle()?.textContent).toContain("2/5");
  });

  it("shows the spinner whenever any tracked item is running", async () => {
    await renderToggle({ completedCount: 1, totalCount: 3, hasActive: true });
    expect(toggle()).not.toBeNull();
    expect(toggle()?.querySelector(".animate-spin")).not.toBeNull();
  });

  it("fires onToggle when pressed", async () => {
    const onToggle = vi.fn();
    await renderToggle({ onToggle });
    await userEvent.click(toggle()!);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
