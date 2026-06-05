import { describe, expect, it } from "vite-plus/test";
import { priorityToToast } from "./notificationToast";

describe("priorityToToast", () => {
  it("escalates high and immediate to a high-priority warning toast", () => {
    expect(priorityToToast("high")).toEqual({ type: "warning", priority: "high" });
    expect(priorityToToast("immediate")).toEqual({ type: "warning", priority: "high" });
  });

  it("keeps low and medium as a low-priority info toast", () => {
    expect(priorityToToast("low")).toEqual({ type: "info", priority: "low" });
    expect(priorityToToast("medium")).toEqual({ type: "info", priority: "low" });
  });

  it("falls back to info/low for unknown or missing priority", () => {
    expect(priorityToToast(undefined)).toEqual({ type: "info", priority: "low" });
    expect(priorityToToast("bogus")).toEqual({ type: "info", priority: "low" });
  });
});
