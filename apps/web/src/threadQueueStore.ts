/**
 * The sidebar Queue: threads (started or still drafts) waiting to send their composer draft while
 * fewer threads are busy than the queue's slots. Kept on this device only (local storage), shared by its tabs.
 *
 * A send is claimed before it starts: the claiming tab moves the chosen entry into `inFlight` in
 * one write, then re-reads storage and proceeds only if the claim is still its own. The entry is gone
 * from `entries` from that moment, so a tab that dies mid-send can never cause a second send.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { DraftId } from "./composerDraftStore";
import { resolveStorage } from "./lib/storage";
import {
  QUEUE_SLOT_SETTINGS_STORAGE_KEY,
  useQueueSlotSettingsStore,
} from "./queueSlotSettingsStore";

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
  /** The thread's latest turn id at claim time; a different one means the send started a turn. */
  readonly priorTurnId: string | null;
  /** The session's `updatedAt` at claim time; an error status only counts once it changes. */
  readonly priorSessionUpdatedAt: string | null;
  /** Set once the send settled as sent; the wait for the landed message starts here. */
  readonly sentAt: number | null;
  /** Set when the send starts: from then on the draft is the queue's, and a hand send cannot release it. */
  readonly sendingAt?: number;
  /** A hand send took this claim over; the composer releases it if that send fails. */
  readonly handSent?: true;
}

/** The sent thread's state at claim time, stored flat on the claim as its `prior*` fields. */
export interface ThreadQueuePrior {
  readonly userMessageAt: string | null;
  readonly turnId: string | null;
  readonly sessionUpdatedAt: string | null;
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
  /** Moves the named entry into `inFlight`; null when it is gone or a claim is already in flight. */
  readonly claimEntry: (input: {
    key: string;
    claimId: string;
    now: number;
    /** The entry as it will be sent (a draft may have moved machine) and its thread's state now. */
    resolve: (entry: ThreadQueueEntry) => { entry: ThreadQueueEntry; prior: ThreadQueuePrior };
  }) => ThreadQueueInFlight | null;
  readonly markSending: (claimId: string, now: number) => void;
  readonly markSent: (claimId: string, now: number) => void;
  readonly clearInFlight: (claimId: string) => void;
  /** Pauses the queue and records why; clears the claim if it is still this one. */
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
      claimEntry: ({ key, claimId, now, resolve }) => {
        const state = get();
        if (state.inFlight !== null) return null;
        const target = state.entries.find((entry) => threadQueueEntryKey(entry) === key);
        if (!target) return null;
        const { entry, prior } = resolve(target);
        const inFlight: ThreadQueueInFlight = {
          entry,
          claimId,
          claimedAt: now,
          priorUserMessageAt: prior.userMessageAt,
          priorTurnId: prior.turnId,
          priorSessionUpdatedAt: prior.sessionUpdatedAt,
          sentAt: null,
        };
        set({ entries: state.entries.filter((entry) => entry !== target), inFlight });
        return inFlight;
      },
      markSending: (claimId, now) =>
        set((state) =>
          state.inFlight?.claimId === claimId
            ? { inFlight: { ...state.inFlight, sendingAt: now } }
            : state,
        ),
      markSent: (claimId, now) =>
        set((state) => {
          if (state.inFlight?.claimId !== claimId) return state;
          // The queue's own send went out, whatever a stale tab wrote meanwhile.
          const { handSent: _handSent, ...claim } = state.inFlight;
          return { inFlight: { ...claim, sentAt: now } };
        }),
      clearInFlight: (claimId) =>
        set((state) => (state.inFlight?.claimId === claimId ? { inFlight: null } : state)),
      fail: (claimId, failure) =>
        set((state) => ({
          inFlight: state.inFlight?.claimId === claimId ? null : state.inFlight,
          paused: true,
          lastFailure: failure,
        })),
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

/**
 * A thread the user sent by hand leaves the queue (a draft may have moved machine since it joined).
 * A claim on it whose send has not started is taken over: marked sent by hand, so no tab sends it
 * again and every tab holds the slot until that message lands. Call the returned function when
 * the hand send fails: it frees the slot that claim still holds.
 */
export function removeSentThreadFromQueue(threadKey: string, draftId: DraftId | null): () => void {
  const store = useThreadQueueStore.getState();
  let takenClaimId: string | null = null;
  const claim = store.inFlight;
  if (
    claim !== null &&
    claim.sendingAt === undefined &&
    claim.sentAt === null &&
    (threadQueueEntryKey(claim.entry) === threadKey ||
      (draftId !== null && claim.entry.draftId === draftId))
  ) {
    takenClaimId = claim.claimId;
    useThreadQueueStore.setState({
      inFlight: { ...claim, sentAt: Date.now(), handSent: true },
    });
  }
  for (const entry of store.entries) {
    if (
      threadQueueEntryKey(entry) === threadKey ||
      (draftId !== null && entry.draftId === draftId)
    ) {
      store.remove(threadQueueEntryKey(entry));
    }
  }
  return () => {
    // clearInFlight only clears this claim; a queue send that went out has dropped handSent.
    const queue = useThreadQueueStore.getState();
    if (takenClaimId !== null && queue.inFlight?.handSent === true) {
      queue.clearInFlight(takenClaimId);
    }
  };
}

/**
 * Keeps every tab's copy of the queue and its slot settings current, so no tab writes a stale
 * queue back over another's claim. A null key means storage was cleared.
 */
export function subscribeToCrossTabThreadQueueUpdates(): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === THREAD_QUEUE_STORAGE_KEY) {
      void useThreadQueueStore.persist.rehydrate();
    }
    if (event.key === null || event.key === QUEUE_SLOT_SETTINGS_STORAGE_KEY) {
      void useQueueSlotSettingsStore.persist.rehydrate();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
