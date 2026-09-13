import { describe, expect, it } from "vite-plus/test";

import {
  arrangeComposerBannerStack,
  type ComposerBannerPriority,
} from "./ComposerBannerStack.logic";

const banner = (id: string, priority?: ComposerBannerPriority, variant = "default") => ({
  id,
  variant,
  ...(priority ? { priority } : {}),
});
const ids = (list: ReadonlyArray<{ id: string }>) => list.map((item) => item.id);

describe("arrangeComposerBannerStack", () => {
  it("keeps a reconnect notice on screen while background work holds the front", () => {
    const arranged = arrangeComposerBannerStack([
      banner("reconnecting", "status", "warning"),
      banner("background-work", "activity"),
    ]);
    expect(arranged.front?.id).toBe("background-work");
    expect(ids(arranged.status)).toEqual(["reconnecting"]);
    expect(arranged.folded).toEqual([]);
  });

  it("stacks connection and sync in their given order, and still folds ordinary notices", () => {
    const arranged = arrangeComposerBannerStack([
      banner("update-available", "notice"),
      banner("offline", "status", "error"),
      banner("background-work", "activity"),
      banner("branch-changed", undefined, "info"),
      banner("syncing", "status"),
    ]);
    expect(arranged.front?.id).toBe("background-work");
    expect(ids(arranged.status)).toEqual(["offline", "syncing"]);
    expect(ids(arranged.folded)).toEqual(["update-available", "branch-changed"]);
  });

  it("orders folded notices as before: urgent and warnings ahead of plain notices", () => {
    const arranged = arrangeComposerBannerStack([
      banner("plain"),
      banner("warning", undefined, "warning"),
      banner("activity", "activity"),
    ]);
    expect(arranged.front?.id).toBe("activity");
    expect(ids(arranged.folded)).toEqual(["warning", "plain"]);
  });

  it("a passive notice never takes the front from a status row, but an urgent one does", () => {
    const passive = arrangeComposerBannerStack([
      banner("update-available", "notice"),
      banner("offline", "status", "error"),
    ]);
    expect(passive.front?.id).toBe("offline");
    expect(passive.status).toEqual([]);
    expect(ids(passive.folded)).toEqual(["update-available"]);

    const urgent = arrangeComposerBannerStack([
      banner("contested-branch", "urgent"),
      banner("reconnecting", "status", "warning"),
    ]);
    expect(urgent.front?.id).toBe("contested-branch");
    expect(ids(urgent.status)).toEqual(["reconnecting"]);
  });

  it("with nothing else to show, the first status row becomes the front", () => {
    const arranged = arrangeComposerBannerStack([
      banner("offline", "status", "error"),
      banner("syncing", "status"),
    ]);
    expect(arranged.front?.id).toBe("offline");
    expect(ids(arranged.status)).toEqual(["syncing"]);
    expect(arrangeComposerBannerStack([]).front).toBeNull();
  });
});
