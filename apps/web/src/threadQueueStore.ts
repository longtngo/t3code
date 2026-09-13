/**
 * The sidebar Queue: threads (started or still drafts) waiting to send their composer draft once
 * every Active thread is done. Kept on this device only (local storage), shared by its tabs.
 *
 * A send is claimed before it starts: the claiming tab moves the head entry into `inFlight` in one
 * write, then re-reads storage and proceeds only if the claim is still its own. The entry is gone
 * from `entries` from that moment, so a tab that dies mid-send can never cause a second send.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { DraftId } from "./composerDraftStore";
import { resolveStorage } from "./lib/storage";

export const THREAD_QUEUE_STORAGE_KEY = "t3code:thread-queue:v1";

export interface ThreadQueueEntry {
  readonly environmentId: EnvironmentId;
  /** Drafts pre-allocate their thread id, so the key survives the draft becoming a thread. */
  readonly threadId: ThreadId;
  /** Set while the thread is still a local draft. */
  readonly draftId: DraftId | null;
  readonly addedAt: number;
}

export interface ThreadQueueInFlight {
  readonly entry: ThreadQueueEntry;
  readonly claimId: string;
  readonly claimedAt: number;
  /** The shell's `latestUserMessageAt` at claim time; a new value means the send landed. */
  readonly priorUserMessageAt: string | null;
  /** Set once the send settled as sent; the wait for the landed message starts here. */
  readonly sentAt: number | null;
}

export interface ThreadQueueFailure {
  readonly threadKey: string;
  readonly title: string;
  readonly message: string;
}

interface ThreadQueueState {
  readonly entries: ReadonlyArray<ThreadQueueEntry>;
  readonly paused: boolean;
  readonly inFlight: ThreadQueueInFlight | null;
  readonly lastFailure: ThreadQueueFailure | null;
  /** Appends, or moves an existing entry to `index` when given. */
  readonly enqueue: (entry: Omit<ThreadQueueEntry, "addedAt">, index?: number) => void;
  readonly remove: (threadKey: string) => void;
  readonly setPaused: (paused: boolean) => void;
  /** Moves the head into `inFlight`; returns the claim, or null when there is nothing to claim. */
  readonly claimHead: (input: {
    claimId: string;
    now: number;
    /** The entry as it will be sent (a draft may have moved machine) and its thread's
        `latestUserMessageAt` right now. */
    resolve: (entry: ThreadQueueEntry) => {
      entry: ThreadQueueEntry;
      priorUserMessageAt: string | null;
    };
  }) => ThreadQueueInFlight | null;
  readonly markSent: (claimId: string, now: number) => void;
  readonly clearInFlight: (claimId: string) => void;
  /** Clears the claim, pauses the queue, and records why. */
  readonly fail: (claimId: string, failure: ThreadQueueFailure) => void;
}

export function threadQueueEntryKey(entry: Pick<ThreadQueueEntry, "environmentId" | "threadId">) {
  return scopedThreadKey({ environmentId: entry.environmentId, threadId: entry.threadId });
}

export const useThreadQueueStore = create<ThreadQueueState>()(
  persist(
    (set, get) => ({
      entries: [],
      paused: false,
      inFlight: null,
      lastFailure: null,
      enqueue: (entry, index) =>
        set((state) => {
          const key = threadQueueEntryKey(entry);
          const existing = state.entries.find(
            (candidate) => threadQueueEntryKey(candidate) === key,
          );
          const others = state.entries.filter(
            (candidate) => threadQueueEntryKey(candidate) !== key,
          );
          const next: ThreadQueueEntry = existing
            ? { ...existing, draftId: entry.draftId }
            : { ...entry, addedAt: Date.now() };
          if (existing && index === undefined) return state;
          const at =
            index === undefined ? others.length : Math.max(0, Math.min(index, others.length));
          return { entries: [...others.slice(0, at), next, ...others.slice(at)] };
        }),
      remove: (threadKey) =>
        set((state) => {
          const entries = state.entries.filter((entry) => threadQueueEntryKey(entry) !== threadKey);
          return entries.length === state.entries.length ? state : { entries };
        }),
      setPaused: (paused) => set(paused ? { paused } : { paused, lastFailure: null }),
      claimHead: ({ claimId, now, resolve }) => {
        const state = get();
        const head = state.entries[0];
        if (!head || state.inFlight !== null) return null;
        const resolved = resolve(head);
        const inFlight: ThreadQueueInFlight = {
          entry: resolved.entry,
          claimId,
          claimedAt: now,
          priorUserMessageAt: resolved.priorUserMessageAt,
          sentAt: null,
        };
        set({ entries: state.entries.slice(1), inFlight });
        return inFlight;
      },
      markSent: (claimId, now) =>
        set((state) =>
          state.inFlight?.claimId === claimId
            ? { inFlight: { ...state.inFlight, sentAt: now } }
            : state,
        ),
      clearInFlight: (claimId) =>
        set((state) => (state.inFlight?.claimId === claimId ? { inFlight: null } : state)),
      fail: (claimId, failure) =>
        set((state) =>
          state.inFlight?.claimId === claimId
            ? { inFlight: null, paused: true, lastFailure: failure }
            : state,
        ),
    }),
    {
      name: THREAD_QUEUE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        entries: state.entries,
        paused: state.paused,
        inFlight: state.inFlight,
        lastFailure: state.lastFailure,
      }),
    },
  ),
);

/** A thread the user sent by hand leaves the queue (a draft may have moved machine since it joined). */
export function removeSentThreadFromQueue(threadKey: string, draftId: DraftId | null): void {
  const store = useThreadQueueStore.getState();
  for (const entry of store.entries) {
    if (
      threadQueueEntryKey(entry) === threadKey ||
      (draftId !== null && entry.draftId === draftId)
    ) {
      store.remove(threadQueueEntryKey(entry));
    }
  }
}

/** Keeps every tab's copy current, so no tab writes a stale queue back over another's claim. */
export function subscribeToCrossTabThreadQueueUpdates(): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== THREAD_QUEUE_STORAGE_KEY) return;
    void useThreadQueueStore.persist.rehydrate();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
