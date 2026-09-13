/**
 * "Undo closed tab" for the right panel: a per-thread stack of recently closed surfaces, kept on
 * this device only (local storage) so it survives a reload. Two clients viewing one server keep
 * separate stacks.
 *
 * Most surfaces are pointers and reopen exactly. Two own a live resource that closing destroys:
 * a browser tab reopens as a new tab at its last URL, and a terminal as a new shell in the
 * thread's folder.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import type { RightPanelSurface } from "./rightPanelStore";

export type ClosedTab =
  | {
      readonly kind: "surface";
      readonly surface: Exclude<RightPanelSurface, { kind: "preview" | "terminal" }>;
    }
  | { readonly kind: "browser"; readonly url: string | null }
  | { readonly kind: "terminal" };

/** Threads that keep an undo stack at once; the least recently closed-in thread's is dropped. */
export const MAX_THREADS_WITH_STACKS = 50;

interface ClosedTabsState {
  /** Newest last. */
  readonly byThreadKey: Record<string, ReadonlyArray<ClosedTab>>;
  /** Records tabs in the order they closed; the stack keeps the newest `limit`. */
  readonly push: (ref: ScopedThreadRef, tabs: ReadonlyArray<ClosedTab>, limit: number) => void;
  /** Removes and returns the most recently closed tab, or null when there is none. */
  readonly pop: (ref: ScopedThreadRef) => ClosedTab | null;
}

/** Snapshot of a surface as it closes. `browserUrl` is the tab's current page, if any. */
export function closedTabFor(surface: RightPanelSurface, browserUrl: string | null): ClosedTab {
  switch (surface.kind) {
    case "preview":
      return { kind: "browser", url: browserUrl };
    case "terminal":
      return { kind: "terminal" };
    default:
      return { kind: "surface", surface };
  }
}

export const useClosedTabsStore = create<ClosedTabsState>()(
  persist(
    (set, get) => ({
      byThreadKey: {},
      push: (ref, tabs, limit) => {
        if (tabs.length === 0) return;
        const key = scopedThreadKey(ref);
        set((state) => {
          const { [key]: previous = [], ...others } = state.byThreadKey;
          const next = [...previous, ...tabs].slice(-Math.max(1, limit));
          // Re-inserted last, so key order is least recently closed first; only the most recent
          // threads keep a stack, which bounds local storage however many threads come and go.
          const keys = Object.keys(others);
          const kept = keys.slice(Math.max(0, keys.length - (MAX_THREADS_WITH_STACKS - 1)));
          return {
            byThreadKey: {
              ...Object.fromEntries(kept.map((threadKey) => [threadKey, others[threadKey]!])),
              [key]: next,
            },
          };
        });
      },
      pop: (ref) => {
        const key = scopedThreadKey(ref);
        const stack = get().byThreadKey[key] ?? [];
        const tab = stack.at(-1) ?? null;
        if (tab === null) return null;
        set((state) => {
          const { [key]: _current, ...rest } = state.byThreadKey;
          const remaining = stack.slice(0, -1);
          return { byThreadKey: remaining.length > 0 ? { ...rest, [key]: remaining } : rest };
        });
        return tab;
      },
    }),
    {
      name: "t3code:closed-right-panel-tabs:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    },
  ),
);

/** How many tabs this thread can reopen. */
export function useClosedTabCount(ref: ScopedThreadRef | null): number {
  return useClosedTabsStore((state) =>
    ref === null ? 0 : (state.byThreadKey[scopedThreadKey(ref)]?.length ?? 0),
  );
}
