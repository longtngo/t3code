import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { hasQueuedTurnStart } from "@t3tools/client-runtime/state/thread-settled";
import {
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import type { QueuedSendOutcome } from "../lib/threadSend/executeQueuedSend";
// Type-only: the send planner pulls in UI modules this pure logic must not load.
import type { QueuedSendSnapshot } from "../lib/threadSend/queuedSend";
import {
  threadQueueEntryKey,
  type ThreadQueueEntry,
  type ThreadQueueInFlight,
  type ThreadQueuePrior,
} from "../threadQueueRules";
import { useThreadQueueStore } from "../threadQueueStore";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerVisible,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { formatProviderDriverKindLabel } from "../providerModels";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";

/** A claim whose tab never reported the send settling is abandoned after this long. */
export const QUEUE_CLAIM_ABANDON_MS = 5 * 60_000;
/** After a send is accepted, the landed message normally shows within seconds. */
export const QUEUE_SENT_LANDING_CAP_MS = 2 * 60_000;
/** A branch read waits behind pulls on the same checkout; past this the send goes without one. */
export const QUEUE_BRANCH_READ_TIMEOUT_MS = 5_000;

export const QUEUE_EMPTY_DRAFT_MESSAGE =
  "There is nothing to send, so it left the queue. Open the thread to write the message.";

export type ThreadQueueAction =
  | { readonly kind: "wait" }
  | { readonly kind: "claim"; readonly key: string }
  | { readonly kind: "clear-in-flight"; readonly claimId: string; readonly ifUnsent?: true }
  /** A claim whose send never started, abandoned: its entry goes back to the queue. */
  | { readonly kind: "release-claim"; readonly claimId: string };

/** The provider instance a thread occupies: the running run's, else the one it is set to. */
function threadInstanceId(thread: EnvironmentThreadShell): string {
  const runtime = thread.runtime;
  return runtime?.status === "running"
    ? runtime.providerInstanceId
    : thread.modelSelection.instanceId;
}

/**
 * Working, waiting on post-settlement background work, or holding an accepted
 * message no run has picked up yet. v2's "waiting" status is what the fork's
 * V1 "monitoring" was: the runtime parks at idle while background tasks remain.
 */
export function isQueueBusy(thread: EnvironmentThreadShell, now: string): boolean {
  const status = resolveSidebarThreadStatus(thread);
  return status === "working" || status === "waiting" || hasQueuedTurnStart(thread, { now });
}

const shellKey = (thread: EnvironmentThreadShell) =>
  scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });

/**
 * What the queue coordinator does next. A queued entry sends while fewer threads
 * are busy (working, monitoring, or holding an accepted message) than there are
 * slots — counted per provider instance in per-provider mode. Busy entries are
 * skipped, not waited on.
 */
export function nextThreadQueueAction(input: {
  readonly entries: ReadonlyArray<ThreadQueueEntry>;
  readonly paused: boolean;
  readonly inFlight: ThreadQueueInFlight | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly nowMs: number;
  readonly slots: number;
  readonly perProvider: boolean;
  readonly providerSlots: Readonly<Record<string, number>>;
  readonly visibleInstanceIds: ReadonlyArray<string>;
  readonly targetInstanceOf: (entry: ThreadQueueEntry) => string | null;
  /** This device's id in server mode, so only its own entries are claimed; null in local mode. */
  readonly ownerId: string | null;
  /** Entries this tab is taking out of the Queue (`useThreadQueueLeavingStore`): skipped. */
  readonly leaving: { has(key: string): boolean };
}): ThreadQueueAction {
  const { inFlight, nowMs } = input;
  const now = new Date(nowMs).toISOString();
  if (inFlight !== null) {
    if (inFlight.sentAt === null) {
      // A started send is aged from its start: the claim before it can retry a lost reply for
      // most of the cap, and the send itself takes seconds.
      if (nowMs - (inFlight.sendingAt ?? inFlight.claimedAt) <= QUEUE_CLAIM_ABANDON_MS) {
        return { kind: "wait" };
      }
      // An unstarted send left its draft untouched, so the entry is queued again rather than
      // dropped unseen. A started one may have gone out; it only frees the slot.
      return inFlight.sendingAt === undefined
        ? { kind: "release-claim", claimId: inFlight.claimId }
        : { kind: "clear-in-flight", claimId: inFlight.claimId, ifUnsent: true };
    }
    const sentKey = threadQueueEntryKey(inFlight.entry);
    const sentThread = input.threads.find((thread) => shellKey(thread) === sentKey);
    // The message showing up is not enough: until the thread reads busy, failed, or on
    // a new run, the busy count has not caught up and a second send would overshoot.
    // A failure only counts once the runtime changed: a thread whose previous run failed
    // still reads failed when the re-sent message lands, before the server starts it.
    // (`priorTurnId` / `priorSessionUpdatedAt` keep their V1 names because the claim is
    // persisted; they now hold the latest run id and the runtime's `updatedAt`.)
    const landed =
      sentThread !== undefined &&
      (sentThread.latestUserMessageAt ?? null) !== inFlight.priorUserMessageAt &&
      (isQueueBusy(sentThread, now) ||
        (resolveSidebarThreadStatus(sentThread) === "failed" &&
          (sentThread.runtime?.updatedAt ?? null) !== inFlight.priorSessionUpdatedAt) ||
        (sentThread.latestRun?.runId ?? null) !== inFlight.priorTurnId);
    return landed || nowMs - inFlight.sentAt > QUEUE_SENT_LANDING_CAP_MS
      ? { kind: "clear-in-flight", claimId: inFlight.claimId }
      : { kind: "wait" };
  }
  if (input.paused || input.entries.length === 0) return { kind: "wait" };

  const busy = input.threads.filter(
    (thread) => thread.archivedAt === null && isQueueBusy(thread, now),
  );
  const busyKeys = new Set(busy.map(shellKey));
  let fits: (entry: ThreadQueueEntry) => boolean = () => true;
  if (!input.perProvider) {
    if (busy.length >= input.slots) return { kind: "wait" };
  } else {
    const busyBy = new Map<string, number>();
    for (const thread of busy) {
      const id = threadInstanceId(thread);
      busyBy.set(id, (busyBy.get(id) ?? 0) + 1);
    }
    // An instance no longer listed (its provider was disabled) has no slots, as in the header.
    const capBy = new Map(
      input.visibleInstanceIds.map((id) => [id, providerSlotCap(input.providerSlots, id)]),
    );
    const cap = (id: string) => capBy.get(id) ?? 0;
    let free = 0;
    for (const [id, slots] of capBy) free += Math.max(0, slots - (busyBy.get(id) ?? 0));
    if (free === 0) return { kind: "wait" };
    fits = (entry) => {
      const target = input.targetInstanceOf(entry);
      return target === null || (busyBy.get(target) ?? 0) < cap(target);
    };
  }
  // Another device's entry is skipped, never waited on: only its owner holds the draft.
  const pick = input.entries.find(
    (entry) =>
      (input.ownerId === null || entry.ownerId === input.ownerId) &&
      !busyKeys.has(threadQueueEntryKey(entry)) &&
      !input.leaving.has(threadQueueEntryKey(entry)) &&
      fits(entry),
  );
  return pick ? { kind: "claim", key: threadQueueEntryKey(pick) } : { kind: "wait" };
}

/**
 * Entries to drop: an archived thread whoever queued it, and this device's own entries whose
 * thread and draft are both gone. Another device's draft, or a thread in an environment this
 * device cannot see, is never pruned here: only the owner can tell it is gone.
 */
export function queueEntriesToPrune(input: {
  readonly entries: ReadonlyArray<ThreadQueueEntry>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly draftSessions: Readonly<Record<string, unknown>>;
  /** As in `nextThreadQueueAction`: null in local mode, where every entry is this device's. */
  readonly ownerId: string | null;
}): string[] {
  const live = new Map(input.threads.map((thread) => [shellKey(thread), thread]));
  const keys: string[] = [];
  for (const entry of input.entries) {
    const key = threadQueueEntryKey(entry);
    const thread = live.get(key);
    if (thread !== undefined) {
      if (thread.archivedAt !== null) keys.push(key);
      continue;
    }
    if (input.ownerId !== null && entry.ownerId !== input.ownerId) continue;
    if (entry.draftId === null || input.draftSessions[entry.draftId] === undefined) keys.push(key);
  }
  return keys;
}

/**
 * One queued send: claim the named entry, wait for the queue to confirm the claim, then
 * send and record the outcome. Every store read and effect is injected except the
 * queue store itself, so the ordering can be tested. Resolves true once the send started,
 * whatever its outcome; false when it never did (nothing claimed, or the claim not confirmed).
 */
export async function claimAndSendQueueEntry(deps: {
  readonly key: string;
  readonly claimId: string;
  /** The claimed entry's current checkout branch, or null when not a local checkout. */
  readonly readGitBranch: (entry: ThreadQueueEntry) => Promise<string | null>;
  readonly resolveEntry: (entry: ThreadQueueEntry) => ThreadQueueEntry;
  readonly prior: (entry: ThreadQueueEntry) => ThreadQueuePrior;
  /** The server's clock (server mode) or this device's (local mode). */
  readonly now: () => number;
  /** Whether the queue now holds this claim as this tab's (another tab or device may have won). */
  readonly confirm: (claimId: string) => Promise<boolean>;
  readonly readSnapshot: (
    entry: ThreadQueueEntry,
    currentGitBranch: string | null,
  ) => QueuedSendSnapshot;
  readonly send: (snapshot: QueuedSendSnapshot) => Promise<QueuedSendOutcome>;
  /**
   * The name the notices give the send (`queuedSendTitle`): from its snapshot, or, for a failure
   * before the snapshot was read (the settle or a read threw), with `snapshot` null.
   */
  readonly title: (entry: ThreadQueueEntry, snapshot: QueuedSendSnapshot | null) => string;
  readonly reportFailure: (entry: ThreadQueueEntry, title: string, message: string) => void;
  /** An empty draft leaves the queue for Active without pausing it (the queue's original rule). */
  readonly reportEmpty: (entry: ThreadQueueEntry, title: string) => void;
}): Promise<boolean> {
  const claim = useThreadQueueStore.getState().claimEntry({
    key: deps.key,
    claimId: deps.claimId,
    now: deps.now(),
    resolve: (queued) => {
      const entry = deps.resolveEntry(queued);
      return { entry, prior: deps.prior(entry) };
    },
  });
  // Nothing was claimed: the entry left meanwhile.
  if (claim === null) return false;
  let { entry } = claim;
  // Set from the snapshot once read; a failure before that asks without one. That ask may fail
  // the way the read did, and runs outside the try below, so it never throws.
  let title: string | null = null;
  const titleWithoutSnapshot = () => {
    try {
      return deps.title(entry, null);
    } catch {
      return "New thread";
    }
  };
  // Once this tab starts the send, its outcome is this tab's to report, claim or no claim.
  let started = false;
  let outcome: QueuedSendOutcome;
  // Anything that throws once the claim is held fails it visibly: a held claim nobody runs
  // would otherwise leave the queue silently at the abandon cap.
  try {
    if (!(await deps.confirm(deps.claimId))) return false;
    // A hand send may have taken the confirmed claim over; send the entry as the queue holds it.
    const confirmed = useThreadQueueStore.getState().inFlight;
    if (confirmed?.claimId !== deps.claimId || confirmed.sentAt !== null) return false;
    entry = confirmed.entry;

    // A failed or slow read sends without a branch, so the thread keeps the one it has.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const branch = await Promise.race([
      deps.readGitBranch(entry).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), QUEUE_BRANCH_READ_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    // Locally, another tab may have released or taken the claim while this one waited (a
    // frozen tab resumes before its storage events): read storage, as `confirmClaim` does.
    if (useThreadQueueStore.getState().mode === "local") {
      await useThreadQueueStore.persist.rehydrate();
    }
    // A hand send during the branch read took the claim over; nothing is left to send.
    const current = useThreadQueueStore.getState().inFlight;
    if (current?.claimId !== deps.claimId || current.sentAt !== null) return false;
    // A pause that landed after the claim (while it settled or the branch was read) stops the
    // send before it starts; the entry goes back to the front of the queue.
    if (useThreadQueueStore.getState().paused) {
      useThreadQueueStore.getState().releaseClaim(deps.claimId);
      return false;
    }
    // False when the claim is no longer this send's (a hand send took it over) or the mark never
    // landed. Never cleared here: the take-over owns the slot, else the abandon cap frees it.
    if (!(await useThreadQueueStore.getState().markSending(deps.claimId, deps.now()))) return false;
    started = true;
    const snapshot = deps.readSnapshot(entry, branch);
    title = deps.title(entry, snapshot);
    outcome = await deps.send(snapshot);
  } catch (error) {
    outcome = {
      kind: "failed",
      message: error instanceof Error ? error.message : "Failed to send message.",
    };
  }
  const queue = useThreadQueueStore.getState();
  switch (outcome.kind) {
    case "sent":
      queue.markSent(deps.claimId, deps.now());
      return true;
    // Tell the user before writing the store, and write it even if telling throws: a refused
    // storage write must not swallow the notice, and a notice must not skip the write.
    case "empty":
      title ??= titleWithoutSnapshot();
      try {
        deps.reportEmpty(entry, title);
      } finally {
        queue.clearInFlight(deps.claimId);
      }
      return true;
    case "refused":
    case "failed": {
      // Before this send started, only a claim still ours and unsent is ours to fail: another
      // tab's, a hand send's take-over, or one already cleared is not.
      if (
        !started &&
        (queue.inFlight?.claimId !== deps.claimId || queue.inFlight.sentAt !== null)
      ) {
        return false;
      }
      const message = outcome.kind === "refused" ? outcome.reason : outcome.message;
      title ??= titleWithoutSnapshot();
      try {
        deps.reportFailure(entry, title, message);
      } finally {
        queue.fail(deps.claimId, { threadKey: threadQueueEntryKey(entry), title, message });
      }
      return started;
    }
  }
}

export interface QueueSlotInstance {
  instanceId: string;
  label: string;
}

/** Picker-visible provider instances across all sources, first source wins on duplicates. */
export function listQueueSlotInstances(
  sources: ReadonlyArray<{
    providers: ReadonlyArray<ServerProvider>;
    settings: Pick<ServerSettings, "providerInstances">;
  }>,
): ReadonlyArray<QueueSlotInstance> {
  const slots = new Map<string, QueueSlotInstance>();
  for (const { providers, settings } of sources) {
    const entries = sortProviderInstanceEntries(
      applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
    ).filter(isProviderInstancePickerVisible);
    for (const entry of entries) {
      if (slots.has(entry.instanceId)) continue;
      const driverName =
        PROVIDER_DISPLAY_NAMES[entry.driverKind] ?? formatProviderDriverKindLabel(entry.driverKind);
      slots.set(entry.instanceId, {
        instanceId: entry.instanceId,
        label:
          entry.displayName === driverName
            ? driverName
            : `${driverName} \u00b7 ${entry.displayName}`,
      });
    }
  }
  return [...slots.values()];
}

/** How many threads the queue may run at once: the global count, or the sum over visible instances. */
export function queueSlotTotal(
  slots: number,
  perProvider: boolean,
  providerSlots: Readonly<Record<string, number>>,
  instanceIds: ReadonlyArray<string>,
): number {
  return perProvider
    ? instanceIds.reduce((sum, id) => sum + providerSlotCap(providerSlots, id), 0)
    : slots;
}

/** An instance's slot count, 1 when unset. Own keys only: an id may name an Object.prototype member. */
export function providerSlotCap(
  providerSlots: Readonly<Record<string, number>>,
  instanceId: string,
): number {
  return Object.hasOwn(providerSlots, instanceId) ? providerSlots[instanceId]! : 1;
}
