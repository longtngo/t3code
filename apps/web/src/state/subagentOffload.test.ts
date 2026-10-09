import { ThreadId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { makeOffloadedThreadCountAtom } from "./subagentOffload";

type Settings =
  Parameters<typeof makeOffloadedThreadCountAtom>[0] extends Atom.Atom<infer S> ? S : never;
type ThreadIndex =
  Parameters<typeof makeOffloadedThreadCountAtom>[1] extends Atom.Atom<infer I> ? I : never;

const A = ThreadId.make("thread-a");
const B = ThreadId.make("thread-b");

const SETTINGS = {
  subagentBackendEnabled: true,
  subagentBackendThreadModes: { [A]: "on" },
  providerInstances: { cursor: { driver: "cursor", enabled: true } },
} as unknown as Settings;

const shell = (archivedAt: string | null) => ({ archivedAt });

describe("makeOffloadedThreadCountAtom", () => {
  it("re-notifies only when the count changes", () => {
    const settingsAtom = Atom.make<Settings>(SETTINGS);
    const indexAtom = Atom.make<ThreadIndex>(
      new Map([
        [A, shell(null)],
        [B, shell(null)],
      ]),
    );
    const countAtom = makeOffloadedThreadCountAtom(settingsAtom, indexAtom);
    const registry = AtomRegistry.make();
    const seen: number[] = [];
    const unsubscribe = registry.subscribe(countAtom, (value) => seen.push(value));
    expect(registry.get(countAtom)).toBe(1);
    const baseline = seen.length;

    // A shell update rebuilds the index with the same threads: the count is unchanged.
    registry.set(
      indexAtom,
      new Map([
        [A, shell(null)],
        [B, shell(null)],
      ]),
    );
    expect(registry.get(countAtom)).toBe(1);
    expect(seen.length).toBe(baseline);

    registry.set(
      indexAtom,
      new Map([
        [A, shell("2026-10-08T00:00:00.000Z")],
        [B, shell(null)],
      ]),
    );
    expect(registry.get(countAtom)).toBe(0);
    expect(seen.slice(baseline)).toEqual([0]);

    unsubscribe();
    registry.dispose();
  });
});
