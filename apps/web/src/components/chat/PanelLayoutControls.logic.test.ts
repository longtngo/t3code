import { describe, expect, it } from "vite-plus/test";

import { liveWorkBannerParts, panelToggleLabel } from "./PanelLayoutControls.logic";

describe("panelToggleLabel", () => {
  it("is null when neither agents nor tasks have anything to report", () => {
    expect(panelToggleLabel({ liveAgentCount: 0 })).toBeNull();
    expect(
      panelToggleLabel({ liveAgentCount: 0, taskCompletedCount: 0, taskTotalCount: 0 }),
    ).toBeNull();
  });

  it("reports agents only", () => {
    expect(panelToggleLabel({ liveAgentCount: 1 })).toBe("1 agent working");
    expect(panelToggleLabel({ liveAgentCount: 2 })).toBe("2 agents working");
  });

  it("reports tasks only", () => {
    expect(panelToggleLabel({ liveAgentCount: 0, taskCompletedCount: 3, taskTotalCount: 7 })).toBe(
      "3 of 7 tasks complete",
    );
  });

  it("reports both, agents first", () => {
    expect(panelToggleLabel({ liveAgentCount: 2, taskCompletedCount: 3, taskTotalCount: 7 })).toBe(
      "2 agents working, 3 of 7 tasks complete",
    );
  });

  it("reports background tasks between agents and the task list", () => {
    expect(panelToggleLabel({ liveAgentCount: 0, liveBackgroundCount: 1 })).toBe(
      "1 background task",
    );
    expect(
      panelToggleLabel({
        liveAgentCount: 2,
        liveBackgroundCount: 3,
        taskCompletedCount: 3,
        taskTotalCount: 7,
      }),
    ).toBe("2 agents working, 3 background tasks, 3 of 7 tasks complete");
  });

  it("names the plural task count as complete once every step is done", () => {
    expect(panelToggleLabel({ liveAgentCount: 0, taskCompletedCount: 7, taskTotalCount: 7 })).toBe(
      "all 7 tasks complete",
    );
  });

  it("names a single-step plan in the singular once complete", () => {
    expect(panelToggleLabel({ liveAgentCount: 0, taskCompletedCount: 1, taskTotalCount: 1 })).toBe(
      "all 1 task complete",
    );
  });
});

describe("liveWorkBannerParts", () => {
  it("counts each kind of live work as its own part, agents first", () => {
    expect(
      liveWorkBannerParts({ liveness: "working", liveAgentCount: 3, liveBackgroundCount: 2 }),
    ).toEqual([
      { label: "3 agents", target: "agents" },
      { label: "2 background tasks", target: "background" },
    ]);
    expect(
      liveWorkBannerParts({ liveness: "monitoring", liveAgentCount: 0, liveBackgroundCount: 1 }),
    ).toEqual([{ label: "1 background task", target: "background" }]);
    expect(
      liveWorkBannerParts({ liveness: "working", liveAgentCount: 1, liveBackgroundCount: 0 }),
    ).toEqual([{ label: "1 agent", target: "agents" }]);
  });

  it("falls back to one uncounted part when liveness has no count behind it", () => {
    expect(
      liveWorkBannerParts({ liveness: "working", liveAgentCount: 0, liveBackgroundCount: 0 }),
    ).toEqual([{ label: "Background work", target: "agents" }]);
    expect(
      liveWorkBannerParts({ liveness: "monitoring", liveAgentCount: 0, liveBackgroundCount: 0 }),
    ).toEqual([{ label: "Background tasks", target: "background" }]);
  });
});
