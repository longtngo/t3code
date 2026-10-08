/**
 * The sidebar Queue's rules, as pure steps over the queue's data. The same step
 * runs on this device's copy (local mode) and on the server's document (server
 * mode, where a refused write re-runs it on the newer document), so every step
 * must be a no-op when the data already contains it.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  THREAD_QUEUE_LABEL_MAX_LENGTH,
  THREAD_QUEUE_MAX_ENTRIES,
  type ThreadQueueDocument as WireThreadQueueDocument,
  type ThreadQueueEntry as WireThreadQueueEntry,
  type ThreadQueueFailure,
  type ThreadQueueInFlight as WireThreadQueueInFlight,
} from "@t3tools/contracts";

import type { DraftId } from "./composerDraftStore";

export type { ThreadQueueFailure };

/** The wire carries draft ids as plain strings; this client reads them as its own `DraftId`. */
export type ThreadQueueEntry = Omit<WireThreadQueueEntry, "draftId"> & {
  readonly draftId: DraftId | null;
};
export type ThreadQueueInFlight = Omit<WireThreadQueueInFlight, "entry"> & {
  readonly entry: ThreadQueueEntry;
};

/** The sent thread's state at claim time, stored flat on the claim as its `prior*` fields. */
export interface ThreadQueuePrior {
  readonly userMessageAt: string | null;
  readonly turnId: string | null;
  readonly sessionUpdatedAt: string | null;
}

export interface ThreadQueueData {
  readonly entries: ReadonlyArray<ThreadQueueEntry>;
  readonly paused: boolean;
  readonly inFlight: ThreadQueueInFlight | null;
  readonly lastFailure: ThreadQueueFailure | null;
}
export type ThreadQueueDocument = Omit<WireThreadQueueDocument, keyof ThreadQueueData> &
  ThreadQueueData;

export const EMPTY_QUEUE_DATA: ThreadQueueData = {
  entries: [],
  paused: false,
  inFlight: null,
  lastFailure: null,
};

export function threadQueueEntryKey(entry: Pick<ThreadQueueEntry, "environmentId" | "threadId">) {
  return scopedThreadKey({ environmentId: entry.environmentId, threadId: entry.threadId });
}

export type QueueAction =
  /** Appends, or moves an existing entry to `index` when given; a move never adds one. */
  | {
      readonly kind: "enqueue";
      readonly entry: ThreadQueueEntry;
      readonly index?: number | undefined;
    }
  | { readonly kind: "remove"; readonly keys: ReadonlyArray<string> }
  /**
   * A hand-sent thread leaves the queue, matched by key or by its draft (a draft may have moved
   * machine). A claim on it whose send has not started is taken over: marked sent by hand, so no
   * tab sends it again and the slot stays held until that message lands.
   */
  | {
      readonly kind: "remove-sent";
      readonly threadKey: string;
      readonly draftId: DraftId | null;
      readonly now: number;
    }
  | { readonly kind: "set-paused"; readonly paused: true }
  /** A failure other than the one the user was shown keeps the queue paused, showing it. */
  | {
      readonly kind: "set-paused";
      readonly paused: false;
      readonly seenFailure: ThreadQueueFailure | null;
    }
  | {
      readonly kind: "claim";
      readonly key: string;
      readonly claimId: string;
      readonly now: number;
      /** The entry as it will be sent (a draft may have moved machine) and its thread's state now. */
      readonly resolve: (entry: ThreadQueueEntry) => {
        entry: ThreadQueueEntry;
        prior: ThreadQueuePrior;
      };
    }
  /** The send starts: from then on the draft is the queue's, and a hand send cannot take it over. */
  | { readonly kind: "mark-sending"; readonly claimId: string; readonly now: number }
  /** The queue's own send went out, even over a stale tab's hand-send take-over. */
  | { readonly kind: "mark-sent"; readonly claimId: string; readonly now: number }
  /** `ifUnsent`: an abandon, a no-op once the claim was marked sent (its owner's mark won). */
  | { readonly kind: "clear-in-flight"; readonly claimId: string; readonly ifUnsent?: true }
  /** A failed hand send frees the slot its taken-over claim still holds. */
  | { readonly kind: "release-hand-sent"; readonly claimId: string }
  /** Pauses the queue and records why; clears the claim if it is still this one. */
  | { readonly kind: "fail"; readonly claimId: string; readonly failure: ThreadQueueFailure };

function withEntries(
  state: ThreadQueueData,
  entries: ReadonlyArray<ThreadQueueEntry>,
): ThreadQueueData {
  return entries.length === state.entries.length && entries.every((e, i) => e === state.entries[i])
    ? state
    : { ...state, entries };
}

/** The queue's claim (from this device or a peer) holds this thread: being sent, or sent and not
    yet seen landing. */
export function isClaimedThread(state: Pick<ThreadQueueData, "inFlight">, key: string): boolean {
  const claim = state.inFlight;
  return claim !== null && threadQueueEntryKey(claim.entry) === key;
}

/**
 * The claim holding this thread has not been sent yet, so its draft is still the queue's: adding
 * the thread again would queue the same draft twice. Once sent, the composer holds a new message.
 */
export function isSendingThread(state: Pick<ThreadQueueData, "inFlight">, key: string): boolean {
  return isClaimedThread(state, key) && state.inFlight!.sentAt === null;
}

/** "Add to queue" on a snoozed thread is "Wake & queue": queue it, then wake it only once the
    Queue took it, or its send would find it snoozed. A refused add (already said why) wakes
    nothing. */
export async function queueAndWake(input: {
  readonly snoozed: boolean;
  readonly enqueue: () => boolean;
  readonly wake: () => Promise<unknown>;
}): Promise<void> {
  if (input.enqueue() && input.snoozed) await input.wake();
}

const sameFailure = (a: ThreadQueueFailure | null, b: ThreadQueueFailure | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.threadKey === b.threadKey &&
    a.title === b.title &&
    a.message === b.message);

export function applyQueueAction(state: ThreadQueueData, action: QueueAction): ThreadQueueData {
  switch (action.kind) {
    case "enqueue": {
      const key = threadQueueEntryKey(action.entry);
      const existing = state.entries.find((candidate) => threadQueueEntryKey(candidate) === key);
      if (existing && action.index === undefined) return state;
      // A move re-run after another device claimed or removed the entry must not bring it back.
      if (!existing && action.index !== undefined) return state;
      if (!existing && isSendingThread(state, key)) return state;
      // The server refuses a longer document, so a full queue takes nothing new.
      if (!existing && state.entries.length >= THREAD_QUEUE_MAX_ENTRIES) return state;
      const others = state.entries.filter((candidate) => threadQueueEntryKey(candidate) !== key);
      const next: ThreadQueueEntry = existing
        ? { ...existing, draftId: action.entry.draftId }
        : action.entry;
      const at =
        action.index === undefined
          ? others.length
          : Math.max(0, Math.min(action.index, others.length));
      return { ...state, entries: [...others.slice(0, at), next, ...others.slice(at)] };
    }
    case "remove":
      return withEntries(
        state,
        state.entries.filter((entry) => !action.keys.includes(threadQueueEntryKey(entry))),
      );
    case "remove-sent": {
      const matches = (entry: ThreadQueueEntry) =>
        threadQueueEntryKey(entry) === action.threadKey ||
        (action.draftId !== null && entry.draftId === action.draftId);
      const next = withEntries(
        state,
        state.entries.filter((entry) => !matches(entry)),
      );
      const claim = state.inFlight;
      return claim !== null &&
        claim.sendingAt === undefined &&
        claim.sentAt === null &&
        matches(claim.entry)
        ? { ...next, inFlight: { ...claim, sentAt: action.now, handSent: true } }
        : next;
    }
    case "set-paused":
      if (action.paused) return state.paused ? state : { ...state, paused: true };
      if (state.lastFailure !== null && !sameFailure(state.lastFailure, action.seenFailure)) {
        return state;
      }
      return !state.paused && state.lastFailure === null
        ? state
        : { ...state, paused: false, lastFailure: null };
    case "claim": {
      // Covers "already holds this claim" too: one claim at a time, never replaced. A pause that
      // lands first wins over a claim decided before it.
      if (state.inFlight !== null || state.paused) return state;
      const target = state.entries.find((entry) => threadQueueEntryKey(entry) === action.key);
      if (target === undefined) return state;
      const { entry, prior } = action.resolve(target);
      return {
        ...state,
        entries: state.entries.filter((candidate) => candidate !== target),
        inFlight: {
          entry,
          claimId: action.claimId,
          claimedAt: action.now,
          priorUserMessageAt: prior.userMessageAt,
          priorTurnId: prior.turnId,
          priorSessionUpdatedAt: prior.sessionUpdatedAt,
          sentAt: null,
        },
      };
    }
    case "mark-sending": {
      const claim = state.inFlight;
      return claim?.claimId === action.claimId &&
        claim.sendingAt === undefined &&
        claim.sentAt === null
        ? { ...state, inFlight: { ...claim, sendingAt: action.now } }
        : state;
    }
    case "mark-sent": {
      const claim = state.inFlight;
      if (claim?.claimId !== action.claimId || (claim.sentAt !== null && claim.handSent !== true)) {
        return state;
      }
      const { handSent: _handSent, ...rest } = claim;
      return { ...state, inFlight: { ...rest, sentAt: action.now } };
    }
    case "clear-in-flight":
      return state.inFlight?.claimId === action.claimId &&
        !(action.ifUnsent === true && state.inFlight.sentAt !== null)
        ? { ...state, inFlight: null }
        : state;
    case "release-hand-sent":
      return state.inFlight?.claimId === action.claimId && state.inFlight.handSent === true
        ? { ...state, inFlight: null }
        : state;
    case "fail":
      return {
        ...state,
        inFlight: state.inFlight?.claimId === action.claimId ? null : state.inFlight,
        paused: true,
        lastFailure: action.failure,
      };
  }
}

/**
 * Value equality of two queue states. Key order can differ between a decoded
 * document and a reducer-built one, which only costs a write the server then
 * recognises as unchanged; it can never hide a real difference.
 */
export function sameQueueData(a: ThreadQueueData, b: ThreadQueueData): boolean {
  return (
    JSON.stringify([a.entries, a.paused, a.inFlight, a.lastFailure]) ===
    JSON.stringify([b.entries, b.paused, b.inFlight, b.lastFailure])
  );
}

/** The row title other devices show for an entry they cannot open. */
export function queueEntryLabel(text: string | null | undefined): string | null {
  const firstLine = (text ?? "").trim().split("\n")[0]!.trim();
  return firstLine.length === 0 ? null : firstLine.slice(0, THREAD_QUEUE_LABEL_MAX_LENGTH);
}

export type ThreadQueueMode = "local" | "pending" | "server";

interface ThreadQueueModeInput {
  /** A positive "no primary": the hosted app, or desktop with its local environment off. */
  readonly noPrimary: boolean;
  /** Where the primary's config came from; null when there is none (including a failed discovery). */
  readonly configSource: "live" | "cache" | null;
  readonly capability: boolean;
  readonly connected: boolean;
  /** A document arrived on the live subscription since the primary last connected. */
  readonly liveDocument: boolean;
}

export function resolveThreadQueueMode(input: ThreadQueueModeInput): ThreadQueueMode {
  if (input.noPrimary) return "local";
  // A cached config may predate an upgrade or a downgrade: only a live one decides.
  if (input.configSource !== "live") return "pending";
  if (!input.capability) return "local";
  return input.connected && input.liveDocument ? "server" : "pending";
}
