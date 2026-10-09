import type { RunId } from "@t3tools/contracts";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../testing/renderDom";
import type { TaskListEntry } from "./TaskListPanel.logic";

let limit = 6;
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: <T,>(selector: (s: { threadDetailsSectionRowLimit: number }) => T) =>
    selector({ threadDetailsSectionRowLimit: limit }),
}));
const { TaskListPanel } = await import("./TaskListPanel");

// Each update of a list carries a new time, as `planTime` does from the list's turn item.
let clock = Date.parse("2026-10-08T10:00:00.000Z");

function entry(
  groupKey: string,
  steps: ReadonlyArray<string>,
  completed = steps.length,
): TaskListEntry {
  return {
    groupKey,
    createdAt: new Date((clock += 60_000)).toISOString(),
    runId: groupKey as RunId,
    steps: steps.map((step, index) => ({
      step,
      status: index < completed ? "completed" : "pending",
    })),
  };
}

const steps = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, index) => `${prefix} ${index + 1}`);

function panel(
  primary: TaskListEntry | null,
  history: ReadonlyArray<TaskListEntry> = [],
  threadKey = "env:thread-1",
) {
  return createElement(TaskListPanel, {
    threadKey,
    primary,
    primaryKind: primary === null ? null : "latest",
    history,
    latestRunActive: false,
  });
}

type View = Awaited<ReturnType<typeof renderDom>>;
const button = (view: View, text: string) =>
  view.findAll("button").find((candidate) => candidate.textContent?.includes(text)) ?? null;
const primaryRows = (view: View) =>
  view.find("ul[aria-label^='Task list.']")?.querySelectorAll("li").length ?? 0;

describe("TaskListPanel", () => {
  beforeEach(() => {
    limit = 6;
  });

  it("renders nothing without a task list", async () => {
    const view = await renderDom(panel(null));
    expect(view.container.innerHTML).toBe("");
  });

  it("names the fraction once, in the section title", async () => {
    const view = await renderDom(panel(entry("run-1", ["A", "B", "C"], 1)));
    const header = view.find("h3")?.parentElement;
    expect(view.find("h3")?.textContent).toBe("Tasks · 1/3");
    expect(header?.textContent?.match(/\d+\/\d+/g)).toEqual(["1/3"]);
    expect(view.text()).not.toContain("complete");
  });

  it("windows the primary steps to the row limit", async () => {
    const view = await renderDom(panel(entry("run-1", steps("Step", 10))));
    expect(primaryRows(view)).toBe(6);
    expect(view.text()).toContain("Show 4 more");
    // The list's label counts the whole list, not the window.
    expect(view.find("ul")?.getAttribute("aria-label")).toBe("Task list. 10 of 10 complete.");
  });

  it("keeps the running step in view past the row limit", async () => {
    const list = entry("run-1", steps("Step", 9), 7);
    const running = {
      ...list,
      steps: list.steps.map((s, i) => (i === 7 ? { ...s, status: "inProgress" as const } : s)),
    };
    const view = await renderDom(panel(running));
    expect(primaryRows(view)).toBe(8);
    expect(view.text()).toContain("Step 8");
    expect(view.text()).not.toContain("Step 9");
    expect(view.text()).toContain("Show 1 more");
  });

  it("folds earlier lists behind a counted label, each still expandable", async () => {
    const view = await renderDom(
      panel(entry("run-3", ["Ship the panel"]), [
        entry("run-2", ["Audit the registry", "Hidden step of run two"]),
        entry("run-1", ["Trace the banner", "Hidden step of run one"]),
      ]),
    );
    expect(view.text()).toContain("Previous task lists (2)");
    expect(view.text()).not.toContain("Audit the registry");

    await view.click(button(view, "Previous task lists"));
    expect(view.text()).toContain("Audit the registry");
    expect(view.text()).toContain("Trace the banner");
    expect(view.text()).not.toContain("Hidden step of run two");

    await view.click(button(view, "Audit the registry"));
    expect(view.text()).toContain("Hidden step of run two");
    expect(view.text()).not.toContain("Hidden step of run one");
  });

  it("keeps Show more open across a run's list update, and resets for a new run", async () => {
    const view = await renderDom(panel(entry("run-1", steps("First", 10))));
    await view.click(button(view, "Show 4 more"));
    expect(primaryRows(view)).toBe(10);

    await view.rerender(panel(entry("run-1", steps("Updated", 10), 3)));
    expect(primaryRows(view)).toBe(10);
    expect(view.text()).toContain("Updated 10");

    await view.rerender(panel(entry("run-2", steps("Next", 10))));
    expect(primaryRows(view)).toBe(6);
  });

  it("resets Show more on a thread switch, even when both lists share a group key", async () => {
    const view = await renderDom(panel(entry("run-1", steps("First", 10))));
    await view.click(button(view, "Show 4 more"));
    expect(primaryRows(view)).toBe(10);

    await view.rerender(panel(entry("run-1", steps("Other", 10)), [], "env:thread-2"));
    expect(primaryRows(view)).toBe(6);
  });

  it("marks its root as the activity section", async () => {
    const view = await renderDom(panel(entry("run-1", ["A"])));
    expect(view.container.firstElementChild?.hasAttribute("data-thread-details-activity")).toBe(
      true,
    );
  });
});
