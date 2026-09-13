import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { MAX_THREADS_WITH_STACKS, closedTabFor, useClosedTabsStore } from "./closedTabsStore";

const refA = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-A"));
const refB = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-B"));
const files = closedTabFor({ id: "files", kind: "files" }, null);
const diff = closedTabFor({ id: "diff", kind: "diff" }, null);
const agents = closedTabFor({ id: "agents", kind: "agents" }, null);

describe("closedTabsStore", () => {
  beforeEach(() => {
    useClosedTabsStore.setState({ byThreadKey: {} });
  });

  it("reopens the most recently closed tab first, per thread", () => {
    const store = useClosedTabsStore.getState();
    store.push(refA, [files, diff], 10);
    store.push(refB, [agents], 10);

    expect(store.pop(refA)).toEqual(diff);
    expect(store.pop(refA)).toEqual(files);
    expect(store.pop(refA)).toBeNull();
    expect(store.pop(refB)).toEqual(agents);
  });

  it("keeps only the newest tabs up to the limit", () => {
    const store = useClosedTabsStore.getState();
    store.push(refA, [files, diff], 2);
    store.push(refA, [agents], 2);

    expect(useClosedTabsStore.getState().byThreadKey["env-1:thread-A"]).toEqual([diff, agents]);
  });

  it("keeps stacks only for the most recently closed-in threads", () => {
    const store = useClosedTabsStore.getState();
    for (let index = 0; index <= MAX_THREADS_WITH_STACKS; index += 1) {
      store.push(
        scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make(`t${index}`)),
        [files],
        10,
      );
    }
    store.push(scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("t1")), [diff], 10);

    const keys = Object.keys(useClosedTabsStore.getState().byThreadKey);
    expect(keys).toHaveLength(MAX_THREADS_WITH_STACKS);
    expect(keys).not.toContain("env-1:t0");
    expect(keys.at(-1)).toBe("env-1:t1");
    expect(useClosedTabsStore.getState().byThreadKey["env-1:t1"]).toEqual([files, diff]);
  });

  it("reopens a browser tab at its last page and a terminal as a new shell", () => {
    expect(
      closedTabFor({ id: "browser:t1", kind: "preview", resourceId: "t1" }, "https://example.com/"),
    ).toEqual({ kind: "browser", url: "https://example.com/" });
    expect(
      closedTabFor(
        {
          id: "terminal:x",
          kind: "terminal",
          resourceId: "x",
          terminalIds: ["x"],
          activeTerminalId: "x",
        },
        null,
      ),
    ).toEqual({ kind: "terminal" });
  });
});
