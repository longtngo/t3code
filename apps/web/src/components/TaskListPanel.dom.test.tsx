import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import type { ActivePlanState } from "../session-logic";
import { renderDom } from "../testing/renderDom";
import { TaskListPanel } from "./TaskListPanel";

function plan(turn: string, steps: ReadonlyArray<string>): ActivePlanState {
  return {
    createdAt: new Date().toISOString(),
    turnId: turn as ActivePlanState["turnId"],
    steps: steps.map((step) => ({ step, status: "completed" })),
  };
}

describe("TaskListPanel", () => {
  it("keeps earlier task lists collapsed until their own header is clicked", async () => {
    const view = await renderDom(
      createElement(TaskListPanel, {
        primary: plan("turn-3", ["Ship the panel"]),
        primaryKind: "latest",
        history: [
          plan("turn-2", ["Audit the registry", "Hidden step of turn two"]),
          plan("turn-1", ["Trace the banner", "Hidden step of turn one"]),
        ],
        historyStatus: "ready",
        onRetry: () => {},
        latestTurnRunning: false,
      }),
    );

    expect(view.text()).toContain("Audit the registry");
    expect(view.text()).not.toContain("Hidden step of turn two");
    expect(view.text()).not.toContain("Hidden step of turn one");

    const trigger = view
      .findAll("button")
      .find((button) => button.textContent?.includes("Audit the registry"));
    await view.click(trigger ?? null);

    expect(view.text()).toContain("Hidden step of turn two");
    expect(view.text()).not.toContain("Hidden step of turn one");
  });

  it("keeps loaded earlier task lists visible when a refetch fails, with Retry below them", async () => {
    const view = await renderDom(
      createElement(TaskListPanel, {
        primary: plan("turn-3", ["Ship the panel"]),
        primaryKind: "latest",
        history: [plan("turn-2", ["Audit the registry"])],
        historyStatus: "error",
        onRetry: () => {},
        latestTurnRunning: false,
      }),
    );

    const text = view.text();
    expect(text).toContain("Audit the registry");
    expect(text).toContain("Couldn't load earlier task lists");
    expect(text.indexOf("Audit the registry")).toBeLessThan(
      text.indexOf("Couldn't load earlier task lists"),
    );
  });

  it("shows only the inline error when a failed read left no earlier task lists", async () => {
    const view = await renderDom(
      createElement(TaskListPanel, {
        primary: plan("turn-3", ["Ship the panel"]),
        primaryKind: "latest",
        history: [],
        historyStatus: "error",
        onRetry: () => {},
        latestTurnRunning: false,
      }),
    );

    expect(view.text()).toContain("Couldn't load earlier task lists");
    expect(view.text()).not.toContain("Earlier in this thread");
  });
});
