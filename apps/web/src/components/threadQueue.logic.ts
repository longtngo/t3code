import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed, hasQueuedTurnStart } from "@t3tools/client-runtime/state/thread-settled";
import {
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import type { QueuedSendOutcome } from "../lib/threadSend/executeQueuedSend";
import type { QueuedSendSnapshot } from "../lib/threadSend/queuedSend";
import {
  threadQueueEntryKey,
  useThreadQueueStore,
  type ThreadQueueEntry,
  type ThreadQueueInFlight,
  type ThreadQueuePrior,
} from "../threadQueueStore";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerVisible,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { formatProviderDriverKindLabel } from "../providerModels";
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
/** A branch read waits behind pulls on the same checkout; past this the send goes without one. */
export const QUEUE_BRANCH_READ_TIMEOUT_MS = 5_000;

export type ThreadQueueAction =
  | { readonly kind: "wait" }
  | { readonly kind: "claim"; readonly key: string }
  | { readonly kind: "clear-in-flight"; readonly claimId: string };

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
}): ThreadQueueAction {
  const { inFlight, nowMs } = input;
  const now = new Date(nowMs).toISOString();
  if (inFlight !== null) {
    if (inFlight.sentAt === null) {
      return nowMs - inFlight.claimedAt > QUEUE_CLAIM_ABANDON_MS
        ? { kind: "clear-in-flight", claimId: inFlight.claimId }
        : { kind: "wait" };
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
  const pick = input.entries.find(
    (entry) => !busyKeys.has(threadQueueEntryKey(entry)) && fits(entry),
  );
  return pick ? { kind: "claim", key: threadQueueEntryKey(pick) } : { kind: "wait" };
}

/**
 * One queued send: claim the named entry, let a competing tab's claim land, then
 * send and record the outcome. Every store read and effect is injected except the
 * queue store itself, so the ordering can be tested.
 */
export async function claimAndSendQueueEntry(deps: {
  readonly key: string;
  readonly claimId: string;
  /** The claimed entry's current checkout branch, or null when not a local checkout. */
  readonly readGitBranch: (entry: ThreadQueueEntry) => Promise<string | null>;
  readonly resolveEntry: (entry: ThreadQueueEntry) => ThreadQueueEntry;
  readonly prior: (entry: ThreadQueueEntry) => ThreadQueuePrior;
  readonly settle: () => Promise<void>;
  readonly readSnapshot: (
    entry: ThreadQueueEntry,
    currentGitBranch: string | null,
  ) => QueuedSendSnapshot;
  readonly send: (snapshot: QueuedSendSnapshot) => Promise<QueuedSendOutcome>;
  readonly reportFailure: (entry: ThreadQueueEntry, title: string, message: string) => void;
}): Promise<void> {
  const claim = useThreadQueueStore.getState().claimEntry({
    key: deps.key,
    claimId: deps.claimId,
    now: Date.now(),
    resolve: (queued) => {
      const entry = deps.resolveEntry(queued);
      return { entry, prior: deps.prior(entry) };
    },
  });
  if (claim === null) return;
  // Last writer wins across tabs: keep going only if the stored claim is still this one.
  await deps.settle();
  if (useThreadQueueStore.getState().inFlight?.claimId !== deps.claimId) return;

  const { entry } = claim;
  // A failed or slow read sends without a branch, so the thread keeps the one it has.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const branch = await Promise.race([
    deps.readGitBranch(entry).catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), QUEUE_BRANCH_READ_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  const snapshot = deps.readSnapshot(entry, branch);
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

export interface QueueSlotInstance {
  instanceId: string;
  label: string;
}

/** Picker-visible provider instances across all sources, first source wins on duplicates. */
export function listQueueSlotInstances(
  sources: ReadonlyArray<{
    providers: ReadonlyArray<ServerProvider>;
    settings: Pick<ServerSettings, "providerInstances" | "providers">;
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
