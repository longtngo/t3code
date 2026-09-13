import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed, hasQueuedTurnStart } from "@t3tools/client-runtime/state/thread-settled";

import type { QueuedSendOutcome } from "../lib/threadSend/executeQueuedSend";
import type { QueuedSendSnapshot } from "../lib/threadSend/queuedSend";
import {
  threadQueueEntryKey,
  useThreadQueueStore,
  type ThreadQueueEntry,
  type ThreadQueueInFlight,
} from "../threadQueueStore";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";

export type SidebarRestingSection = "snoozed" | "settled" | "pinned" | "active";

export interface SidebarSectionCapabilities {
  readonly threadSettlement?: boolean;
  readonly threadSnooze?: boolean;
}

/**
 * The section a thread sits in when nothing is being dragged. Servers without
 * the settlement or snooze capability never classify a thread there: the user
 * could not bring it back.
 */
export function sidebarRestingSection(
  thread: EnvironmentThreadShell,
  capabilities: SidebarSectionCapabilities | undefined,
  now: string,
): SidebarRestingSection {
  // Snooze outranks settlement and pinning until the thread wakes.
  if (capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now })) return "snoozed";
  if (capabilities?.threadSettlement === true && thread.settledOverride === "settled") {
    return "settled";
  }
  return thread.pinnedAt != null ? "pinned" : "active";
}

/** A claim whose tab never reported the send settling is abandoned after this long. */
export const QUEUE_CLAIM_ABANDON_MS = 5 * 60_000;
/** After a send is accepted, the landed message normally shows within seconds. */
export const QUEUE_SENT_LANDING_CAP_MS = 2 * 60_000;

export type ThreadQueueAction =
  | { readonly kind: "wait" }
  | { readonly kind: "claim" }
  | { readonly kind: "clear-in-flight"; readonly claimId: string };

/**
 * What the queue coordinator does next. The head sends only when every thread
 * in Pinned or Active is done: not working, not monitoring, and not holding an
 * accepted message no session has picked up yet.
 */
export function nextThreadQueueAction(input: {
  readonly entries: ReadonlyArray<ThreadQueueEntry>;
  readonly paused: boolean;
  readonly inFlight: ThreadQueueInFlight | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly capabilitiesFor: (
    environmentId: EnvironmentThreadShell["environmentId"],
  ) => SidebarSectionCapabilities | undefined;
  readonly nowMs: number;
}): ThreadQueueAction {
  const { inFlight, nowMs } = input;
  if (inFlight !== null) {
    if (inFlight.sentAt === null) {
      return nowMs - inFlight.claimedAt > QUEUE_CLAIM_ABANDON_MS
        ? { kind: "clear-in-flight", claimId: inFlight.claimId }
        : { kind: "wait" };
    }
    const sentKey = threadQueueEntryKey(inFlight.entry);
    const sentThread = input.threads.find(
      (thread) =>
        scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id }) === sentKey,
    );
    const landed =
      sentThread !== undefined &&
      (sentThread.latestUserMessageAt ?? null) !== inFlight.priorUserMessageAt;
    return landed || nowMs - inFlight.sentAt > QUEUE_SENT_LANDING_CAP_MS
      ? { kind: "clear-in-flight", claimId: inFlight.claimId }
      : { kind: "wait" };
  }
  if (input.paused || input.entries.length === 0) return { kind: "wait" };

  const queuedKeys = new Set(input.entries.map(threadQueueEntryKey));
  const headKey = threadQueueEntryKey(input.entries[0]!);
  const now = new Date(nowMs).toISOString();
  const isBusy = (thread: EnvironmentThreadShell) => {
    const status = resolveSidebarThreadStatus(thread);
    return status === "working" || status === "monitoring" || hasQueuedTurnStart(thread, { now });
  };
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    const key = scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
    // A head still finishing its own turn waits too, rather than sending into it.
    if (key === headKey && isBusy(thread)) return { kind: "wait" };
    if (queuedKeys.has(key)) continue;
    const section = sidebarRestingSection(thread, input.capabilitiesFor(thread.environmentId), now);
    if (section !== "pinned" && section !== "active") continue;
    if (isBusy(thread)) return { kind: "wait" };
  }
  return { kind: "claim" };
}

/**
 * One queued send: claim the head, let a competing tab's claim land, then send
 * and record the outcome. Every store read and effect is injected except the
 * queue store itself, so the ordering can be tested.
 */
export async function claimAndSendQueueHead(deps: {
  readonly claimId: string;
  /** The head's checkout branch as last watched; keyed by the entry it belongs to. */
  readonly headGitBranch: () => { key: string; branch: string | null } | null;
  readonly resolveEntry: (entry: ThreadQueueEntry) => ThreadQueueEntry;
  readonly priorUserMessageAt: (entry: ThreadQueueEntry) => string | null;
  readonly settle: () => Promise<void>;
  readonly readSnapshot: (
    entry: ThreadQueueEntry,
    currentGitBranch: string | null,
  ) => QueuedSendSnapshot;
  readonly send: (snapshot: QueuedSendSnapshot) => Promise<QueuedSendOutcome>;
  readonly reportFailure: (entry: ThreadQueueEntry, title: string, message: string) => void;
}): Promise<void> {
  // Read before claiming: the claim removes the head, and the watch moves on to
  // the next entry as soon as the queue re-renders.
  const headGitBranch = deps.headGitBranch();
  const claim = useThreadQueueStore.getState().claimHead({
    claimId: deps.claimId,
    now: Date.now(),
    resolve: (head) => {
      const entry = deps.resolveEntry(head);
      return { entry, priorUserMessageAt: deps.priorUserMessageAt(entry) };
    },
  });
  if (claim === null) return;
  // Last writer wins across tabs: keep going only if the stored claim is still this one.
  await deps.settle();
  if (useThreadQueueStore.getState().inFlight?.claimId !== deps.claimId) return;

  const { entry } = claim;
  const snapshot = deps.readSnapshot(
    entry,
    headGitBranch?.key === threadQueueEntryKey(entry) ? headGitBranch.branch : null,
  );
  const title =
    snapshot.shell?.title ?? (snapshot.draft?.prompt.trim().slice(0, 40) || "New thread");
  let outcome: QueuedSendOutcome;
  try {
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
      queue.markSent(deps.claimId, Date.now());
      return;
    case "empty":
      queue.clearInFlight(deps.claimId);
      return;
    case "refused":
    case "failed": {
      const message = outcome.kind === "refused" ? outcome.reason : outcome.message;
      queue.fail(deps.claimId, { threadKey: threadQueueEntryKey(entry), title, message });
      deps.reportFailure(entry, title, message);
    }
  }
}
