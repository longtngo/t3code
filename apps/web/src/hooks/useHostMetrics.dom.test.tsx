import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, HostMetricsSample } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { createElement, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The samples atom is a derived atom over a writable source; `live` counts how many are mounted,
// so a test sees whether the hook holds the subscription open.
const fixture = vi.hoisted(() => ({
  source: null as unknown as (id: string) => unknown,
  live: 0,
}));

vi.mock("~/state/hostMetrics", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const source = Atom.family((_id: string) =>
    Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial()),
  );
  const samples = Atom.family((id: string) =>
    Atom.make((get) => {
      fixture.live++;
      get.addFinalizer(() => fixture.live--);
      return get(source(id));
    }),
  );
  fixture.source = source;
  return {
    hostMetricsEnvironment: {
      samples: ({ environmentId }: { environmentId: string }) => samples(environmentId),
    },
  };
});

import { type HostMetricsState, useHostMetrics } from "./useHostMetrics";
import { act, renderDom } from "../testing/renderDom";

const envId = "env-a" as EnvironmentId;
const sourceOf = () =>
  fixture.source(envId) as Atom.Writable<AsyncResult.AsyncResult<HostMetricsSample, unknown>>;
const sample = { ts: 5 } as unknown as HostMetricsSample;

let registry: AtomRegistry.AtomRegistry;
const seen = { value: null as HostMetricsState | null };

function Probe(props: { active: boolean }) {
  const value = useHostMetrics(envId, props.active);
  useEffect(() => {
    seen.value = value;
  });
  return null;
}

const node = (active: boolean) =>
  createElement(RegistryContext.Provider, { value: registry }, createElement(Probe, { active }));

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Atom disposal is scheduled after the last unsubscribe, so wait for the count to drop. */
const unsubscribed = () => vi.waitFor(() => expect(fixture.live).toBe(0));

beforeEach(() => {
  registry = AtomRegistry.make();
  seen.value = null;
  setHidden(false);
});

describe("useHostMetrics", () => {
  it("subscribes only while active, and reports nothing when inactive", async () => {
    await using view = await renderDom(node(false));
    expect(fixture.live).toBe(0);
    expect(seen.value).toEqual({ sample: null, status: "ok", message: null, receivedAt: 0 });

    await view.rerender(node(true));
    expect(fixture.live).toBe(1);
    await act(() => registry.set(sourceOf(), AsyncResult.success(sample, { timestamp: 7 })));
    expect(seen.value).toEqual({ sample, status: "ok", message: null, receivedAt: 7 });

    await view.rerender(node(false));
    await unsubscribed();
  });

  it("drops the subscription while the document is hidden", async () => {
    await using _view = await renderDom(node(true));
    expect(fixture.live).toBe(1);
    await act(() => setHidden(true));
    await unsubscribed();
    await act(() => setHidden(false));
    expect(fixture.live).toBe(1);
  });

  it("classifies an unknown subscribeHostMetrics tag as unsupported, other failures as failed", async () => {
    await using _view = await renderDom(node(true));
    await act(() =>
      registry.set(
        sourceOf(),
        AsyncResult.failure(Cause.die("Unknown request tag: subscribeHostMetrics")),
      ),
    );
    expect(seen.value).toMatchObject({ sample: null, status: "unsupported", receivedAt: 0 });

    await act(() =>
      registry.set(
        sourceOf(),
        AsyncResult.failure(Cause.die("Unknown request tag: resourceQueue.get"), {
          previousSuccess: Option.some(AsyncResult.success(sample, { timestamp: 9 })),
        }),
      ),
    );
    expect(seen.value).toEqual({
      sample,
      status: "failed",
      message: "Unknown request tag: resourceQueue.get",
      receivedAt: 9,
    });
  });
});
