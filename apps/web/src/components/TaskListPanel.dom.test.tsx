import type { RunId } from "@t3tools/contracts";
import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import type { ActivePlanState } from "../session-logic";
import { renderDom } from "../testing/renderDom";
import { TaskListPanel } from "./TaskListPanel";

function plan(run: string, steps: ReadonlyArray<string>): ActivePlanState {
  return {
    createdAt: new Date().toISOString(),
    runId: run as RunId,
    steps: steps.map((step) => ({ step, status: "completed" })),
  };
}

describe("TaskListPanel", () => {
  it("keeps earlier task lists collapsed until their own header is clicked", async () => {
    const view = await renderDom(
      createElement(TaskListPanel, {
        primary: plan("run-3", ["Ship the panel"]),
        primaryKind: "latest",
        history: [
          plan("run-2", ["Audit the registry", "Hidden step of run two"]),
          plan("run-1", ["Trace the banner", "Hidden step of run one"]),
        ],
        latestRunActive: false,
      }),
    );

    expect(view.text()).toContain("Finished");
    expect(view.text()).toContain("Audit the registry");
    expect(view.text()).not.toContain("Hidden step of run two");
    expect(view.text()).not.toContain("Hidden step of run one");

    const trigger = view
      .findAll("button")
      .find((button) => button.textContent?.includes("Audit the registry"));
    await view.click(trigger ?? null);

    expect(view.text()).toContain("Hidden step of run two");
    expect(view.text()).not.toContain("Hidden step of run one");
  });

  it("says the thread has no task list rather than rendering an empty panel", async () => {
    const view = await renderDom(
      createElement(TaskListPanel, {
        primary: null,
        primaryKind: null,
        history: [],
        latestRunActive: false,
      }),
    );
    expect(view.text()).toContain("No task list yet");
  });
});
