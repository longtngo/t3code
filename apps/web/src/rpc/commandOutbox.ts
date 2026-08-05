import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import type { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { type StateStorage, createJSONStorage, persist } from "zustand/middleware";

import { isTransportConnectionErrorMessage } from "./transportError";

/**
 * A turn-start queued while the environment was disconnected.
 *
 * `commandId` is minted once at enqueue time and reused on every replay. The
 * server upserts command receipts by `commandId` and returns the original result
 * for an already-accepted command instead of re-executing it, so re-sending a
 * queued turn is exactly-once even when we cannot tell whether an earlier attempt
 * reached the server.
 */
export interface QueuedTurn {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  /** Stable across replays — the server dedupes on it. */
  readonly commandId: CommandId;
  /**
   * The `startThreadTurn` input, carrying `commandId`. The flusher supplies a
   * fresh `createdAt` at send time because the field is required on the command
   * (the server canonicalizes it to its own receive time regardless).
   *
   * Typed against the real command input rather than a bag of unknowns: this
   * payload is written now and sent hours later, so a field renamed in between
   * would otherwise be a runtime rejection at replay, when the user is no longer
   * looking.
   */
  readonly input: StartThreadTurnInput;
  readonly enqueuedAt: string;
}

/**
 * A turn that reached the server but whose echo has not arrived yet.
 *
 * Deliberately NOT part of the persisted queue: the queue's contract is "not
 * yet delivered", and giving it a second lifecycle state would put a durable,
 * cross-tab, replayed structure in charge of a one-round-trip rendering
 * detail. These are ephemeral, capped, and dropped on reload — the worst case
 * is the blink they exist to remove.
 */
export interface DeliveredTurn {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly enqueuedAt: string;
}

interface OutboxState {
  readonly queue: readonly QueuedTurn[];
}

/** Cap the queue so a long offline stretch cannot grow it without bound. */
export const MAX_QUEUED_TURNS = 20;

/**
 * A queued turn older than this is discarded instead of replayed. Sending a
 * day-old message into a thread whose context has moved on is worse than losing
 * it, and the age check also stands in for pruning turns whose environment is
 * gone — the catalog exposes no "reconciliation complete" signal, so absence
 * cannot be distinguished from "not loaded yet" without deleting live messages.
 */
export const MAX_QUEUED_TURN_AGE_MS = 12 * 60 * 60 * 1000;

/** Fallback so non-browser contexts (unit tests, SSR) still work, unpersisted. */
const memoryStorage: StateStorage = (() => {
  const entries = new Map<string, string>();
  return {
    getItem: (name) => entries.get(name) ?? null,
    setItem: (name, value) => void entries.set(name, value),
    removeItem: (name) => void entries.delete(name),
  };
})();

/**
 * `localStorage` is not merely absent outside a browser — in storage-blocked
 * contexts (Safari private mode, blocked cookies) the getter itself THROWS, so
 * a bare `typeof` check is not enough to fall back safely.
 */
function resolveStorage(): StateStorage {
  try {
    return typeof localStorage === "undefined" ? memoryStorage : localStorage;
  } catch {
    return memoryStorage;
  }
}

/** Structural check — persisted JSON is untrusted input by the time it is read back. */
function isQueuedTurn(value: unknown): value is QueuedTurn {
  if (typeof value !== "object" || value === null) return false;
  const turn = value as Record<string, unknown>;
  return (
    typeof turn.environmentId === "string" &&
    typeof turn.threadId === "string" &&
    typeof turn.messageId === "string" &&
    typeof turn.commandId === "string" &&
    typeof turn.enqueuedAt === "string" &&
    typeof turn.input === "object" &&
    turn.input !== null
  );
}

/**
 * Drop structurally invalid entries on the way back in from storage.
 *
 * Deliberately does NOT drop aged-out entries: rehydrate happens before any UI
 * exists, so a silent drop here would destroy the user's message with no toast
 * and no draft to fall back on (enqueueing already cleared it). Expiry is left
 * to {@link expireQueuedTurns}, which reports what it discarded.
 */
export function sanitizeRehydratedQueue(value: unknown): readonly QueuedTurn[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is QueuedTurn => {
    if (!isQueuedTurn(entry)) return false;
    return Number.isFinite(Date.parse(entry.enqueuedAt));
  });
}

/**
 * Persisted, because enqueueing CLEARS the composer draft — which is itself
 * persisted. Without this, queueing would move the user's text from durable
 * storage into memory, and a reload (or a PWA bundle swap) would lose it, making
 * the outbox worse than the no-op it replaces.
 */
/** Shared so the persist config and the cross-tab listener cannot drift apart. */
const OUTBOX_STORAGE_KEY = "t3code:command-outbox";

export const useCommandOutbox = create<OutboxState>()(
  persist(() => ({ queue: [] as readonly QueuedTurn[] }), {
    name: OUTBOX_STORAGE_KEY,
    version: 1,
    storage: createJSONStorage(resolveStorage),
    // A payload written by an older build may not match the current command
    // shape, and a rejected command is poisoned forever by its receipt — so
    // drop rather than attempt to migrate.
    migrate: () => ({ queue: [] as readonly QueuedTurn[] }),
    merge: (persisted, current) => ({
      ...current,
      queue: sanitizeRehydratedQueue((persisted as OutboxState | undefined)?.queue),
    }),
  }),
);

export function getQueuedTurns(): readonly QueuedTurn[] {
  return useCommandOutbox.getState().queue;
}

/**
 * Turns that have been accepted but not yet echoed back, newest last.
 *
 * Separate store so nothing here is persisted, replayed, or shared across tabs.
 */
export const useDeliveredTurns = create<{ readonly delivered: readonly DeliveredTurn[] }>()(() => ({
  delivered: [],
}));

/** Bound the buffer; a stuck echo must not accumulate bubbles without limit. */
const MAX_DELIVERED_TURNS = MAX_QUEUED_TURNS;

/** Remember a delivered turn so its bubble survives the wait for the echo. */
export function markTurnDelivered(turn: QueuedTurn): void {
  const text = typeof turn.input.message?.text === "string" ? turn.input.message.text : "";
  useDeliveredTurns.setState((state) => ({
    delivered: [
      ...state.delivered.filter((entry) => entry.messageId !== turn.messageId),
      { threadId: turn.threadId, messageId: turn.messageId, text, enqueuedAt: turn.enqueuedAt },
    ].slice(-MAX_DELIVERED_TURNS),
  }));
}

/** Retire delivered turns the server has now echoed. */
export function retireDeliveredTurns(echoedMessageIds: ReadonlySet<string>): void {
  useDeliveredTurns.setState((state) => {
    const remaining = state.delivered.filter((entry) => !echoedMessageIds.has(entry.messageId));
    return remaining.length === state.delivered.length ? state : { delivered: remaining };
  });
}

/**
 * zustand's persist middleware writes to storage synchronously inside
 * `setState`, so a quota or permission failure throws straight into the caller.
 * Losing durability is tolerable; losing the queue update — or rejecting a send
 * that already succeeded — is not.
 */
function setQueue(update: (queue: readonly QueuedTurn[]) => readonly QueuedTurn[]): void {
  try {
    useCommandOutbox.setState((state) => ({ queue: update(state.queue) }));
  } catch (error) {
    console.error("Failed to persist the offline outbox", error);
  }
}

/** Whether a turn is already waiting for this thread. */
export function hasQueuedTurnForThread(threadId: ThreadId): boolean {
  return getQueuedTurns().some((queued) => queued.threadId === threadId);
}

/**
 * Append a turn, up to {@link MAX_QUEUED_TURNS}. Returns false when the queue is
 * full so the caller can keep the user's text in the composer instead.
 */
export function enqueueTurn(turn: QueuedTurn): boolean {
  if (getQueuedTurns().length >= MAX_QUEUED_TURNS) return false;
  setQueue((queue) =>
    queue.some((queued) => queued.commandId === turn.commandId) ? queue : [...queue, turn],
  );
  return true;
}

/** Drop a single queued turn once it is delivered, undeliverable, or expired. */
export function removeQueuedTurn(commandId: string): void {
  setQueue((queue) => queue.filter((queued) => queued.commandId !== commandId));
}

/** Discard turns that have aged out, returning them so the caller can report the loss. */
export function expireQueuedTurns(nowMs: number = Date.now()): readonly QueuedTurn[] {
  const expired = getQueuedTurns().filter((turn) => {
    const enqueuedMs = Date.parse(turn.enqueuedAt);
    return !Number.isFinite(enqueuedMs) || nowMs - enqueuedMs > MAX_QUEUED_TURN_AGE_MS;
  });
  for (const turn of expired) removeQueuedTurn(turn.commandId);
  return expired;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" ? message : String(error);
}

/**
 * Send queued turns oldest-first.
 *
 * A transport failure blocks only the environment it happened on — its remaining
 * turns stay queued and in order, while turns for other (reachable) environments
 * still drain. Per-environment FIFO is preserved because messages to one thread
 * must arrive in the order they were composed. A terminal (non-transport) failure
 * drops its turn; otherwise one rejected command would wedge the queue forever.
 */
export async function flushOutbox(
  send: (turn: QueuedTurn) => Promise<unknown>,
  options?: {
    readonly onTerminalError?: (turn: QueuedTurn, error: unknown) => void;
    /**
     * Checked against freshly-synced thread state immediately before sending.
     * Return a reason to drop the turn instead.
     *
     * The enqueue-time check compared against a thread row that was stale by
     * definition — the environment was unreachable — so a mode changed from
     * another device, or changed here after queueing, was invisible. Sending a
     * turn into a thread whose modes have since moved runs it under settings
     * the user did not choose for it.
     */
    readonly rejectBeforeSend?: (turn: QueuedTurn) => string | null;
    /** Called when a turn is accepted, before it is removed from the queue. */
    readonly onDelivered?: (turn: QueuedTurn) => void;
  },
): Promise<void> {
  const blockedEnvironments = new Set<string>();
  for (const { commandId } of getQueuedTurns()) {
    // Re-read from the live queue: a concurrent clear/remove during an earlier
    // await may have retired this turn already.
    const turn = getQueuedTurns().find((queued) => queued.commandId === commandId);
    if (turn === undefined) continue;
    if (blockedEnvironments.has(turn.environmentId)) continue;
    const rejection = options?.rejectBeforeSend?.(turn) ?? null;
    if (rejection !== null) {
      options?.onTerminalError?.(turn, new Error(rejection));
      removeQueuedTurn(commandId);
      continue;
    }
    try {
      await send(turn);
      options?.onDelivered?.(turn);
      // Remove by identity, never by position: a concurrent clear/enqueue during
      // the await can shift index 0 onto a different, unsent turn.
      removeQueuedTurn(commandId);
    } catch (error) {
      if (isTransportConnectionErrorMessage(errorMessageOf(error))) {
        blockedEnvironments.add(turn.environmentId);
        continue;
      }
      options?.onTerminalError?.(turn, error);
      removeQueuedTurn(commandId);
    }
  }
}

/**
 * Keep tabs in step. Without this, a tab that did not perform the flush keeps its
 * stale in-memory copy, shows a pending bubble forever, and rewrites the delivered
 * turn back into storage on its next write — resurrecting it for the next reload.
 */
export function subscribeToCrossTabOutboxUpdates(): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== OUTBOX_STORAGE_KEY) return;
    void useCommandOutbox.persist.rehydrate();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
