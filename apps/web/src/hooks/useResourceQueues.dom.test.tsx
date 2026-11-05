import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, ResourceQueueSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { createElement, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Each env's query atom is a derived atom over a writable source the test sets, so a refresh
// re-reads the source instead of resetting it. Refreshes are counted on the real registry.
const fixture = vi.hoisted(() => ({
  source: null as unknown as (id: string) => unknown,
  query: null as unknown as (id: string) => unknown,
}));

vi.mock("../state/resourceQueue", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const source = Atom.family((_id: string) =>
    Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial()),
  );
  const query = Atom.family((id: string) => Atom.make((get) => get(source(id))));
  fixture.source = source;
  fixture.query = query;
  return {
    resourceQueueEnvironment: {
      get: ({ environmentId }: { environmentId: string }) => query(environmentId),
    },
  };
});

import type { QueueView } from "../components/sidebar/sidebarResourceQueue.logic";
import { useResourceQueues } from "./useResourceQueues";
import { act, renderDom } from "../testing/renderDom";

type Result = AsyncResult.AsyncResult<ResourceQueueSnapshot, unknown>;
const env = (id: string) => id as EnvironmentId;
const sourceOf = (id: string) => fixture.source(id) as Atom.Writable<Result>;
const queryOf = (id: string) => fixture.query(id) as Atom.Atom<Result>;

const snapshot = (label: string) =>
  ({ available: true, label, running: [], waiting: [] }) as unknown as ResourceQueueSnapshot;
const unsupportedDie = Cause.die("Unknown request tag: resourceQueue.get");

let registry: AtomRegistry.AtomRegistry;
let refreshed: Atom.Atom<unknown>[];
const seen = { value: null as ReadonlyArray<QueueView> | null };

function Probe(props: {
  envs: ReadonlyArray<{ environmentId: EnvironmentId; connected: boolean }>;
  fast: boolean;
}) {
  const value = useResourceQueues(props.envs, props.fast);
  useEffect(() => {
    seen.value = value;
  });
  return null;
}

type Envs = ReadonlyArray<{ environmentId: EnvironmentId; connected: boolean }>;

function mount(envs: Envs, fast = false) {
  let current = { envs, fast };
  const node = () =>
    createElement(RegistryContext.Provider, { value: registry }, createElement(Probe, current));
  return renderDom(node()).then((view) => ({
    ...view,
    setFast: (nextFast: boolean) => {
      current = { ...current, fast: nextFast };
      return view.rerender(node());
    },
    setEnvs: (nextEnvs: Envs) => {
      current = { ...current, envs: nextEnvs };
      return view.rerender(node());
    },
  }));
}

/** A settled first result, so the poller has something to refresh. */
const ready = (...ids: string[]) => {
  for (const id of ids) registry.set(sourceOf(id), AsyncResult.success(snapshot(id)));
};

const refreshCount = (id: string) => refreshed.filter((atom) => atom === queryOf(id)).length;
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  registry = AtomRegistry.make();
  refreshed = [];
  const refresh = registry.refresh.bind(registry);
  vi.spyOn(registry, "refresh").mockImplementation((atom) => {
    refreshed.push(atom);
    refresh(atom);
  });
  seen.value = null;
  setHidden(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useResourceQueues", () => {
  it("I4 does not refresh a non-connected env", async () => {
    ready("on", "off");
    await using _view = await mount([
      { environmentId: env("on"), connected: true },
      { environmentId: env("off"), connected: false },
    ]);
    await advance(3 * 60_000);
    expect(refreshCount("on")).toBe(4);
    expect(refreshCount("off")).toBe(0);
    expect(refreshed).toHaveLength(4);
    // The non-connected env is still reported, in `envs` order, so the panel can render it.
    expect(seen.value!.map((view) => view.data)).toEqual([snapshot("on"), snapshot("off")]);
  });

  it("refreshes nothing when no env is connected", async () => {
    await using _view = await mount([{ environmentId: env("off"), connected: false }], true);
    await advance(60_000);
    expect(refreshed).toHaveLength(0);
  });

  it("refreshes each connected env once per interval (60 s closed, 5 s when fast)", async () => {
    ready("a", "b");
    await using view = await mount([
      { environmentId: env("a"), connected: true },
      { environmentId: env("b"), connected: true },
    ]);
    // Mounting refreshes at once; the closed cadence then waits the full 60 s.
    expect([refreshCount("a"), refreshCount("b")]).toEqual([1, 1]);
    await advance(59_999);
    expect([refreshCount("a"), refreshCount("b")]).toEqual([1, 1]);
    await advance(1);
    expect([refreshCount("a"), refreshCount("b")]).toEqual([2, 2]);

    // Opening the panel refreshes at once, then every 5 s.
    await view.setFast(true);
    expect([refreshCount("a"), refreshCount("b")]).toEqual([3, 3]);
    await advance(4_999);
    expect(refreshCount("a")).toBe(3);
    await advance(1);
    expect([refreshCount("a"), refreshCount("b")]).toEqual([4, 4]);
    await advance(10_000);
    expect([refreshCount("a"), refreshCount("b")]).toEqual([6, 6]);
  });

  it("closing the panel does not refresh at once; the slow cadence resumes", async () => {
    ready("a");
    await using view = await mount([{ environmentId: env("a"), connected: true }], true);
    expect(refreshCount("a")).toBe(1);
    await view.setFast(false);
    expect(refreshCount("a")).toBe(1);
    await advance(59_999);
    expect(refreshCount("a")).toBe(1);
    await advance(1);
    expect(refreshCount("a")).toBe(2);
  });

  it("a change in the connected set refreshes at once", async () => {
    ready("a", "b");
    await using view = await mount([
      { environmentId: env("a"), connected: true },
      { environmentId: env("b"), connected: false },
    ]);
    expect([refreshCount("a"), refreshCount("b")]).toEqual([1, 0]);
    await view.setEnvs([
      { environmentId: env("a"), connected: true },
      { environmentId: env("b"), connected: true },
    ]);
    expect([refreshCount("a"), refreshCount("b")]).toEqual([2, 1]);
    // The same set again (a new array, same members) is not a change.
    await view.setEnvs([
      { environmentId: env("a"), connected: true },
      { environmentId: env("b"), connected: true },
    ]);
    expect([refreshCount("a"), refreshCount("b")]).toEqual([2, 1]);
  });

  it("never refreshes a query that has not settled or is already fetching", async () => {
    // "first" never got a result; "busy" has one but is fetching again.
    registry.set(sourceOf("busy"), AsyncResult.success(snapshot("busy"), { waiting: true }));
    ready("idle");
    await using _view = await mount(
      [
        { environmentId: env("first"), connected: true },
        { environmentId: env("busy"), connected: true },
        { environmentId: env("idle"), connected: true },
      ],
      true,
    );
    await advance(3 * 5_000);
    expect([refreshCount("first"), refreshCount("busy"), refreshCount("idle")]).toEqual([0, 0, 4]);
    // Once the fetch lands it is polled again from the next tick.
    await act(() => registry.set(sourceOf("busy"), AsyncResult.success(snapshot("busy"))));
    await advance(5_000);
    expect([refreshCount("first"), refreshCount("busy"), refreshCount("idle")]).toEqual([0, 1, 5]);
  });

  it("I10 never refreshes an env whose result is unsupported", async () => {
    registry.set(sourceOf("old"), AsyncResult.failure(unsupportedDie));
    // A Die for a different tag is a real failure and keeps being polled.
    registry.set(sourceOf("other"), AsyncResult.failure(Cause.die("Unknown request tag: x.y")));
    registry.set(sourceOf("new"), AsyncResult.success(snapshot("new")));
    await using _view = await mount(
      [
        { environmentId: env("old"), connected: true },
        { environmentId: env("other"), connected: true },
        { environmentId: env("new"), connected: true },
      ],
      true,
    );
    await advance(5 * 5_000);
    expect(refreshCount("old")).toBe(0);
    expect(refreshCount("other")).toBe(6);
    expect(refreshCount("new")).toBe(6);
    expect(seen.value![0]).toEqual({
      data: null,
      status: "unsupported",
      message: "Unknown request tag: resourceQueue.get",
      receivedAt: 0,
    });

    // An env that turns unsupported mid-run stops being polled from the next tick.
    await act(() => registry.set(sourceOf("new"), AsyncResult.failure(unsupportedDie)));
    await advance(3 * 5_000);
    expect(refreshCount("new")).toBe(6);
  });

  it("keeps last data and receivedAt after a failure", async () => {
    const last = snapshot("last");
    registry.set(sourceOf("a"), AsyncResult.success(last, { timestamp: 1_000 }));
    await using _view = await mount([{ environmentId: env("a"), connected: true }]);
    expect(seen.value![0]).toEqual({
      data: last,
      status: "ok",
      message: null,
      receivedAt: 1_000,
    });

    await act(() =>
      registry.set(
        sourceOf("a"),
        AsyncResult.failure(Cause.fail(new Error("socket closed")), {
          previousSuccess: Option.some(AsyncResult.success(last, { timestamp: 1_000 })),
        }),
      ),
    );
    expect(seen.value![0]).toEqual({
      data: last,
      status: "failed",
      message: "socket closed",
      receivedAt: 1_000,
    });

    // A failure with nothing before it has no data and no receipt time.
    await act(() => registry.set(sourceOf("a"), AsyncResult.failure(Cause.fail(new Error("no")))));
    expect(seen.value![0]).toMatchObject({
      data: null,
      status: "failed",
      receivedAt: 0,
    });
  });

  it("reports nothing received before the first result", async () => {
    await using _view = await mount([{ environmentId: env("a"), connected: true }]);
    expect(seen.value![0]).toEqual({
      data: null,
      status: "ok",
      message: null,
      receivedAt: 0,
    });
  });

  it("pauses while the document is hidden", async () => {
    ready("a");
    await using _view = await mount([{ environmentId: env("a"), connected: true }], true);
    expect(refreshCount("a")).toBe(1);
    await act(() => setHidden(true));
    await advance(10 * 60_000);
    expect(refreshCount("a")).toBe(1);
    // Coming back refreshes at once and resumes the cadence.
    await act(() => setHidden(false));
    expect(refreshCount("a")).toBe(2);
    await advance(5_000);
    expect(refreshCount("a")).toBe(3);
  });

  it("stops polling on unmount", async () => {
    ready("a");
    const view = await mount([{ environmentId: env("a"), connected: true }], true);
    await view.unmount();
    await advance(60_000);
    expect(refreshCount("a")).toBe(1);
  });
});
