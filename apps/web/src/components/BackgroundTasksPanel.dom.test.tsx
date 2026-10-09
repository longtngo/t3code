import type { PendingBackgroundWorkTask } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../testing/renderDom";

let limit = 6;
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: <T,>(selector: (s: { threadDetailsSectionRowLimit: number }) => T) =>
    selector({ threadDetailsSectionRowLimit: limit }),
}));
const { BackgroundTasksPanel } = await import("./BackgroundTasksPanel");

function panel(tasks: ReadonlyArray<PendingBackgroundWorkTask>, threadKey = "env:thread-1") {
  return createElement(BackgroundTasksPanel, { threadKey, tasks });
}

const eightTasks = Array.from({ length: 8 }, (_, index) => ({
  taskId: `t${index}`,
  kind: "command" as const,
  description: `Task ${index}`,
}));

describe("BackgroundTasksPanel", () => {
  beforeEach(() => {
    limit = 6;
  });

  it("renders nothing without tasks", async () => {
    const view = await renderDom(panel([]));
    expect(view.container.innerHTML).toBe("");
  });

  it("lists subagents and shells with their kinds under a counted title", async () => {
    const view = await renderDom(
      panel([
        { taskId: "a", kind: "subagent", description: "Audit the registry" },
        { taskId: "b", kind: "command", description: "npm run dev" },
      ]),
    );
    expect(view.find("h3")?.textContent).toBe("Background · 2 running");
    expect(view.text()).toContain("Audit the registry");
    expect(view.text()).toContain("Subagent · running");
    expect(view.text()).toContain("npm run dev");
    expect(view.text()).toContain("Shell · running");
  });

  it("windows rows to the row limit", async () => {
    const view = await renderDom(panel(eightTasks));
    expect(view.findAll("li")).toHaveLength(6);
    expect(view.text()).toContain("Show 2 more");
  });

  it("collapses Show more again when the thread changes", async () => {
    const view = await renderDom(panel(eightTasks, "env:a"));
    await view.click(
      view.findAll("button").find((button) => button.textContent?.includes("Show 2 more")) ?? null,
    );
    expect(view.findAll("li")).toHaveLength(8);

    await view.rerender(panel(eightTasks, "env:b"));

    expect(view.findAll("li")).toHaveLength(6);
  });

  it("marks its root as the activity section", async () => {
    const view = await renderDom(panel([{ taskId: "a", kind: "command" }]));
    expect(view.container.firstElementChild?.hasAttribute("data-thread-details-activity")).toBe(
      true,
    );
  });
});
