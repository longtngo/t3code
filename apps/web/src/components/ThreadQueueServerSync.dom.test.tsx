import { RegistryContext } from "@effect/atom-react";
import { ThreadQueueWriteError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The primary, its config support and the queue subscription are writable atoms; the outgoing
// command is the network boundary and answers only when a test says so.
const fixture = vi.hoisted(() => ({
  writes: [] as Array<{
    environmentId: string;
    input: unknown;
    reply: (value: unknown) => void;
    fail: (error: unknown) => void;
    die: (defect: unknown) => void;
  }>,
  subscribed: [] as string[],
  toasts: [] as string[],
}));

vi.mock("./ui/toast", () => ({
  toastManager: { add: (toast: { title: string }) => fixture.toasts.push(toast.title) },
}));
vi.mock("../state/environments", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  const { Atom } = await import("effect/reactivity");
  const primaryAtom = Atom.make<{
    environmentId: string;
    label: string;
    connection: { phase: string };
  } | null>(null);
  return { primaryAtom, usePrimaryEnvironment: () => useAtomValue(primaryAtom) };
});
vi.mock("../state/server", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const original = await importOriginal<typeof import("../state/server")>();
  // Kept alive: a fresh subscription's first document is the server's current one.
  const documents = Atom.family((_environmentId: string) =>
    Atom.keepAlive(Atom.make<AsyncResult.AsyncResult<unknown, never>>(AsyncResult.initial())),
  );
  return {
    ...original,
    documents,
    primaryThreadQueueSupportAtom: Atom.make<{
      configSource: "live" | "cache" | null;
      capability: boolean;
    }>({ configSource: null, capability: false }),
    serverEnvironment: {
      ...original.serverEnvironment,
      threadQueue: (target: { environmentId: string }) => {
        fixture.subscribed.push(target.environmentId);
        return documents(target.environmentId);
      },
      setThreadQueue: {
        ...original.serverEnvironment.setThreadQueue,
        permissionAtom: () => Atom.make(true),
      },
    },
  };
});
// One function for every render, as the real hook's `useCallback` gives.
const setThreadQueue = (value: { environmentId: string; input: unknown }) =>
  new Promise((resolve) => {
    fixture.writes.push({
      ...value,
      reply: (reply) => resolve(AsyncResult.success(reply)),
      fail: (error) => resolve(AsyncResult.failure(Cause.fail(error))),
      die: (defect) => resolve(AsyncResult.failure(Cause.die(defect))),
    });
  });
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => setThreadQueue }));

import * as environments from "../state/environments";
import * as server from "../state/server";
import { renderDom } from "../testing/renderDom";
import { THREAD_QUEUE_STORAGE_KEY, useThreadQueueStore } from "../threadQueueStore";
import { ThreadQueueServerSync } from "./ThreadQueueServerSync";

const mocked = {
  primaryAtom: (environments as unknown as { primaryAtom: never }).primaryAtom,
  documents: (server as unknown as { documents: (id: string) => never }).documents,
};
const primary = (environmentId: string, label: string, phase = "connected") => ({
  environmentId,
  label,
  connection: { phase },
});
const document = (bootId: string, revision: number) => ({
  bootId,
  revision,
  entries: [],
  paused: false,
  inFlight: null,
  lastFailure: null,
});

let registry: AtomRegistry.AtomRegistry;
const set = (atom: never, value: unknown) => act(async () => registry.set(atom, value as never));

beforeEach(async () => {
  localStorage.clear();
  fixture.writes.length = 0;
  fixture.subscribed.length = 0;
  fixture.toasts.length = 0;
  registry = AtomRegistry.make();
  await renderDom(
    <RegistryContext.Provider value={registry}>
      <ThreadQueueServerSync />
    </RegistryContext.Provider>,
  );
});

afterEach(() => {
  localStorage.clear();
  useThreadQueueStore.getState().setWriter(null);
});

describe("ThreadQueueServerSync", () => {
  it.each([
    ["a cached config", { configSource: "cache", capability: true }],
    ["a server without the queue", { configSource: "live", capability: false }],
  ] as const)("never subscribes on %s", async (_, support) => {
    await set(mocked.primaryAtom, primary("env-a", "Server A"));
    await set(server.primaryThreadQueueSupportAtom as never, support);
    useThreadQueueStore.getState().setPaused(true);

    expect(fixture.subscribed).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });

  // A primary switch leaves the old server's socket open, so nothing else ends its write.
  it("drops a write still in flight when the primary changes, and never adopts its reply", async () => {
    await set(mocked.primaryAtom, primary("env-a", "Server A"));
    await set(server.primaryThreadQueueSupportAtom as never, {
      configSource: "live",
      capability: true,
    });
    await set(
      mocked.documents("env-a"),
      AsyncResult.success({ document: document("boot-a", 1), serverTime: Date.now() }),
    );
    expect(useThreadQueueStore.getState().mode).toBe("server");

    await act(async () => useThreadQueueStore.getState().setPaused(true));
    expect(fixture.writes.map((write) => write.environmentId)).toEqual(["env-a"]);

    await set(mocked.primaryAtom, primary("env-b", "Server B"));
    expect(fixture.toasts).toEqual(["Queue change didn't reach Server A"]);

    await act(async () =>
      fixture.writes[0]?.reply({
        ok: true,
        document: document("boot-a", 2),
        serverTime: Date.now(),
      }),
    );
    expect(useThreadQueueStore.getState().server?.bootId).not.toBe("boot-a");
    expect(fixture.writes.map((write) => write.environmentId)).toEqual(["env-a"]);
  });

  it("returns to the server's queue after a reconnect, even when a document beat the disconnect", async () => {
    const live = { configSource: "live", capability: true };
    await set(mocked.primaryAtom, primary("env-a", "Server A"));
    await set(server.primaryThreadQueueSupportAtom as never, live);
    await set(
      mocked.documents("env-a"),
      AsyncResult.success({ document: document("boot-a", 1), serverTime: Date.now() }),
    );
    expect(useThreadQueueStore.getState()).toMatchObject({ mode: "server", readOnly: false });

    // The new session's first document lands in the same commit that records the disconnect.
    await act(async () => {
      registry.set(mocked.primaryAtom, primary("env-a", "Server A", "disconnected") as never);
      registry.set(
        mocked.documents("env-a"),
        AsyncResult.success({ document: document("boot-a", 2), serverTime: Date.now() }) as never,
      );
    });
    expect(useThreadQueueStore.getState()).toMatchObject({ mode: "pending", readOnly: true });

    await set(mocked.primaryAtom, primary("env-a", "Server A"));
    expect(useThreadQueueStore.getState()).toMatchObject({
      mode: "server",
      readOnly: false,
      server: { bootId: "boot-a", revision: 2 },
    });

    await set(
      mocked.documents("env-a"),
      AsyncResult.success({ document: document("boot-a", 3), serverTime: Date.now() }),
    );
    expect(useThreadQueueStore.getState().server?.revision).toBe(3);
    await act(async () => useThreadQueueStore.getState().setPaused(true));
    expect(fixture.writes.map((write) => write.environmentId)).toEqual(["env-a"]);
  });

  it("renaming the primary keeps its write in flight", async () => {
    await set(mocked.primaryAtom, primary("env-a", "Server A"));
    await set(server.primaryThreadQueueSupportAtom as never, {
      configSource: "live",
      capability: true,
    });
    await set(
      mocked.documents("env-a"),
      AsyncResult.success({ document: document("boot-a", 1), serverTime: Date.now() }),
    );
    await act(async () => useThreadQueueStore.getState().setPaused(true));
    await set(mocked.primaryAtom, primary("env-a", "Renamed A"));
    expect(fixture.toasts).toEqual([]);

    await act(async () =>
      fixture.writes[0]?.reply({
        ok: true,
        document: { ...document("boot-a", 2), paused: true },
        serverTime: Date.now(),
      }),
    );
    expect(useThreadQueueStore.getState()).toMatchObject({
      pending: [],
      server: { revision: 2, paused: true },
    });
    expect(fixture.toasts).toEqual([]);
  });

  const enterServer = async () => {
    await set(mocked.primaryAtom, primary("env-a", "Server A"));
    await set(server.primaryThreadQueueSupportAtom as never, {
      configSource: "live",
      capability: true,
    });
    await set(
      mocked.documents("env-a"),
      AsyncResult.success({ document: document("boot-a", 1), serverTime: Date.now() }),
    );
    expect(useThreadQueueStore.getState().mode).toBe("server");
  };

  // A server that was reached but could not save is told apart from one never reached.
  it("toasts a write the server could not save apart from one that never reached it, and logs both", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await enterServer();
      await act(async () => useThreadQueueStore.getState().setPaused(true));
      await act(async () => fixture.writes[0]?.fail(new ThreadQueueWriteError({})));
      expect(fixture.toasts).toEqual(["Queue change couldn't be saved on Server A"]);

      await act(async () => useThreadQueueStore.getState().setPaused(true));
      await act(async () => fixture.writes[1]?.fail(new Error("socket closed")));
      expect(fixture.toasts).toEqual([
        "Queue change couldn't be saved on Server A",
        "Queue change didn't reach Server A",
      ]);

      // A system write toasts nothing, but its failure is still logged.
      await act(async () =>
        useThreadQueueStore.setState({
          server: {
            ...document("boot-a", 1),
            entries: [
              {
                environmentId: "env-1",
                threadId: "gone",
                draftId: null,
                addedAt: 1,
                ownerId: "d",
                label: null,
              },
            ],
          } as never,
        }),
      );
      await act(async () => useThreadQueueStore.getState().prune(["env-1:gone"]));
      await act(async () => fixture.writes[2]?.fail(new ThreadQueueWriteError({})));
      expect(fixture.toasts).toHaveLength(2);
      expect(logged.mock.calls.filter(([message]) => message === "Queue change failed")).toEqual([
        ["Queue change failed", expect.any(ThreadQueueWriteError)],
        ["Queue change failed", new Error("socket closed")],
        ["Queue change failed", expect.any(ThreadQueueWriteError)],
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  // The RPC client encodes the payload before sending and dies on one it cannot encode: the
  // write never left this device, so it is not reported as a server that could not be reached.
  it("toasts a write this device could not encode as rejected, not as unreached", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await enterServer();
      await act(async () => useThreadQueueStore.getState().setPaused(true));
      const encodeError = new Schema.SchemaError(new SchemaIssue.InvalidValue());
      await act(async () => fixture.writes[0]?.die(encodeError));
      expect(fixture.toasts).toEqual(["Queue change was rejected"]);
      expect(logged).toHaveBeenCalledWith("Queue change failed", encodeError);
    } finally {
      logged.mockRestore();
    }
  });

  // A claim the RPC client cannot encode would fail the same way on every retry: its entry
  // leaves the queue, named once, and the removal is written.
  it("names a queued thread whose claim is too large to save, once, and writes its removal", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await enterServer();
      const queued = {
        environmentId: "env-1",
        threadId: "big",
        draftId: null,
        addedAt: 1,
        ownerId: "d",
        label: "Big thread",
      };
      await set(
        mocked.documents("env-a"),
        AsyncResult.success({
          document: { ...document("boot-a", 2), entries: [queued] },
          serverTime: Date.now(),
        }),
      );
      await act(async () => {
        useThreadQueueStore.getState().claimEntry({
          key: "env-1:big",
          claimId: "claim-1",
          now: 1,
          resolve: (entry) => ({
            entry,
            prior: { userMessageAt: null, turnId: null, sessionUpdatedAt: null },
          }),
        });
      });
      const encodeError = new Schema.SchemaError(new SchemaIssue.InvalidValue());
      await act(async () => fixture.writes[0]?.die(encodeError));
      expect(fixture.toasts).toEqual(["Big thread can't be queued: it is too large to save."]);
      expect(fixture.writes[1]?.input).toMatchObject({ state: { entries: [], inFlight: null } });
    } finally {
      logged.mockRestore();
    }
  });

  it("asks to add a single left-behind item again as one", async () => {
    localStorage.setItem(
      THREAD_QUEUE_STORAGE_KEY,
      JSON.stringify({
        state: {
          entries: [{ environmentId: "env-1", threadId: "t1", draftId: null, addedAt: 1 }],
          paused: false,
          inFlight: null,
          lastFailure: null,
        },
        version: 1,
      }),
    );
    await enterServer();
    expect(fixture.toasts).toEqual([
      "1 item queued before the queue was shared was not moved into it. Add it again.",
    ]);
  });

  // What this device queued before the queue was shared is not moved into it.
  it("tells once, on the first server run, how many items were not moved into the shared queue", async () => {
    const v1 = JSON.stringify({
      state: {
        entries: [
          { environmentId: "env-1", threadId: "t1", draftId: null, addedAt: 1 },
          { environmentId: "env-1", threadId: "t2", draftId: null, addedAt: 2 },
        ],
        paused: false,
        inFlight: null,
        lastFailure: null,
      },
      version: 1,
    });
    localStorage.setItem(THREAD_QUEUE_STORAGE_KEY, v1);
    await enterServer();
    const notice =
      "2 items queued before the queue was shared were not moved into it. Add them again.";
    expect(fixture.toasts).toEqual([notice]);

    await set(mocked.primaryAtom, primary("env-a", "Server A", "disconnected"));
    await set(mocked.primaryAtom, primary("env-a", "Server A"));
    await set(
      mocked.documents("env-a"),
      AsyncResult.success({ document: document("boot-a", 2), serverTime: Date.now() }),
    );
    expect(useThreadQueueStore.getState().mode).toBe("server");
    expect(fixture.toasts).toEqual([notice]);
    expect(localStorage.getItem(THREAD_QUEUE_STORAGE_KEY)).toBe(v1);
  });
});
