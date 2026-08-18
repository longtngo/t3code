/**
 * Decides when an armed thread should compact itself and then carry on.
 *
 * A long thread fills its context window, and the user's manual remedy is always the same
 * two messages: `/compact`, wait for it to finish, `continue`. This module holds the whole
 * decision as one pure function so both clients share identical rules and every branch is
 * testable without React, a clock, or a socket.
 *
 * The caller owns all I/O: it supplies a snapshot of the thread, receives an action, and
 * performs it. Nothing here reads state or measures time.
 */

import {
  DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
  MAX_AUTO_COMPACT_THRESHOLD_PERCENT,
  MIN_AUTO_COMPACT_THRESHOLD_PERCENT,
} from "@t3tools/contracts/settings";

/** Text sent to compact the thread. Providers take slash commands as ordinary message text. */
export const AUTO_COMPACT_COMMAND = "/compact";
/** Text sent once compaction has settled, to resume the work that was interrupted. */
export const AUTO_COMPACT_CONTINUE = "continue";

/**
 * The threshold band lives in the settings contract, since that is what validates a stored
 * value; re-exported here so callers need only one import to use the feature.
 */
export {
  DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT as DEFAULT_AUTO_COMPACT_THRESHOLD,
  MAX_AUTO_COMPACT_THRESHOLD_PERCENT as MAX_AUTO_COMPACT_THRESHOLD,
  MIN_AUTO_COMPACT_THRESHOLD_PERCENT as MIN_AUTO_COMPACT_THRESHOLD,
} from "@t3tools/contracts/settings";

/**
 * Consecutive compact→continue rounds allowed without a message from the user.
 *
 * Continuing refills the window, which re-crosses the threshold, which compacts again: left
 * unbounded the pair is a loop that spends tokens for as long as the client stays open. The
 * cap turns that into a bounded burst that stops and asks for a human.
 */
export const DEFAULT_AUTO_COMPACT_MAX_CYCLES = 3;

/**
 * Smallest drop in used percentage that counts as "the compaction did something".
 *
 * Compaction that returns a window no emptier than it found means compacting again would
 * achieve as little, so the sequence stops instead of spending another round on it.
 */
export const AUTO_COMPACT_MIN_EFFECTIVE_DROP = 5;

export type AutoCompactPhase = "idle" | "compacting" | "continuing";

export type AutoCompactHoldReason =
  | "disarmed"
  | "unsupported-provider"
  | "unknown-usage"
  | "below-threshold"
  | "thread-busy"
  | "session-not-ready"
  | "archived"
  | "needs-user"
  | "draft-pending"
  | "cap-reached"
  | "compaction-ineffective"
  | "in-flight";

export type AutoCompactInput = {
  readonly armed: boolean;
  readonly phase: AutoCompactPhase;
  /** Percent of the context window in use, or null when no snapshot has arrived yet. */
  readonly usedPercentage: number | null;
  readonly thresholdPercent: number;
  /** True while a turn is running, connecting, or otherwise not settled. */
  readonly threadBusy: boolean;
  readonly sessionReady: boolean;
  readonly archived: boolean;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
  /** True when the composer holds unsent text: the user is mid-sentence. */
  readonly hasComposerDraft: boolean;
  /** True when the connected provider advertises a `compact` command. */
  readonly providerSupportsCompact: boolean;
  readonly cyclesUsed: number;
  readonly maxCycles: number;
  /**
   * Used percentage captured just before `/compact` was sent, or null outside a sequence.
   * Compared against `usedPercentage` once the compaction turn settles.
   */
  readonly usedPercentageBeforeCompact: number | null;
};

export type AutoCompactAction =
  | { readonly kind: "hold"; readonly reason: AutoCompactHoldReason }
  | { readonly kind: "compact" }
  | { readonly kind: "continue" }
  | { readonly kind: "abandon"; readonly reason: AutoCompactHoldReason };

const hold = (reason: AutoCompactHoldReason): AutoCompactAction => ({ kind: "hold", reason });

/**
 * Conditions that must hold at every step of the sequence, not just at its start.
 *
 * They are re-checked between compact and continue because a thread can gain a pending
 * approval, lose its session, or be archived while the compaction turn runs.
 */
function blockingReason(input: AutoCompactInput): AutoCompactHoldReason | null {
  if (!input.armed) return "disarmed";
  if (!input.providerSupportsCompact) return "unsupported-provider";
  if (input.archived) return "archived";
  if (!input.sessionReady) return "session-not-ready";
  // Each of these means the thread is waiting on the person, and compacting would discard
  // the very context they are about to be asked about.
  if (input.hasPendingApprovals || input.hasPendingUserInput || input.hasActionableProposedPlan) {
    return "needs-user";
  }
  return null;
}

export function decideAutoCompact(input: AutoCompactInput): AutoCompactAction {
  const blocked = blockingReason(input);

  // Mid-sequence, a blocking condition abandons rather than holds: the thread has already
  // been compacted, so leaving the phase parked would strand it in "compacting" forever.
  if (input.phase !== "idle") {
    if (blocked !== null) return { kind: "abandon", reason: blocked };
    if (input.threadBusy) return hold("in-flight");
    if (input.phase === "continuing") return hold("in-flight");

    // The compaction turn has settled. Continue only if it actually freed room, so a
    // no-op compaction cannot become a loop that merely burns the cycle budget.
    const before = input.usedPercentageBeforeCompact;
    const after = input.usedPercentage;
    if (before === null || after === null) return { kind: "abandon", reason: "unknown-usage" };
    if (before - after < AUTO_COMPACT_MIN_EFFECTIVE_DROP) {
      return { kind: "abandon", reason: "compaction-ineffective" };
    }
    return { kind: "continue" };
  }

  if (blocked !== null) return hold(blocked);
  if (input.cyclesUsed >= input.maxCycles) return hold("cap-reached");
  if (input.hasComposerDraft) return hold("draft-pending");
  if (input.threadBusy) return hold("thread-busy");
  if (input.usedPercentage === null) return hold("unknown-usage");
  if (input.usedPercentage < input.thresholdPercent) return hold("below-threshold");
  return { kind: "compact" };
}

/** Name of the provider command that performs compaction. */
export const AUTO_COMPACT_COMMAND_NAME = "compact";

/**
 * Whether a provider can compact on request.
 *
 * Read from the commands the provider advertises rather than a hardcoded list of driver
 * kinds, so a provider that gains or loses the command is handled without a code change.
 * Claude advertises it today; a provider that does not simply never offers the switch.
 */
export function providerAdvertisesCompact(
  slashCommands: ReadonlyArray<{ readonly name: string }> | undefined,
): boolean {
  return (slashCommands ?? []).some((command) => command.name === AUTO_COMPACT_COMMAND_NAME);
}

/**
 * How the cycle budget tracks messages from the user.
 *
 * The obvious rule — "reset when `latestUserMessageAt` changes" — is wrong here, and wrong in
 * a way that silently disables the runaway-spend cap. The projector derives that column from
 * the max `createdAt` over messages with `role === "user"` and cannot tell a synthetic message
 * from a typed one, and the turns this feature sends are `role: "user"`. Every auto-compact
 * would therefore reset its own budget and the cap would never engage.
 *
 * So each send arms `awaitingSelfMessage`, and the next advance of the column is consumed
 * rather than treated as a human. One send produces exactly one user message, so the counting
 * stays exact without comparing timestamps the server is free to canonicalize.
 */
export type AutoCompactBudget = {
  readonly cyclesUsed: number;
  /** Set after this client sends, cleared by the message that send produces. */
  readonly awaitingSelfMessage: boolean;
  readonly lastSeenUserMessageAt: string | null;
};

export const initialAutoCompactBudget: AutoCompactBudget = {
  cyclesUsed: 0,
  awaitingSelfMessage: false,
  lastSeenUserMessageAt: null,
};

export function reconcileAutoCompactBudget(
  budget: AutoCompactBudget,
  latestUserMessageAt: string | null,
): AutoCompactBudget {
  if (latestUserMessageAt === budget.lastSeenUserMessageAt) return budget;
  // First observation of a thread is not evidence of a new message: adopt it silently, or a
  // freshly opened thread would look like the user had just spoken.
  if (budget.lastSeenUserMessageAt === null) {
    return { ...budget, lastSeenUserMessageAt: latestUserMessageAt };
  }
  if (budget.awaitingSelfMessage) {
    return { ...budget, awaitingSelfMessage: false, lastSeenUserMessageAt: latestUserMessageAt };
  }
  return { cyclesUsed: 0, awaitingSelfMessage: false, lastSeenUserMessageAt: latestUserMessageAt };
}

/** Record that this client has just sent one of the sequence's two turns. */
export function noteAutoCompactSend(budget: AutoCompactBudget): AutoCompactBudget {
  return { ...budget, awaitingSelfMessage: true };
}

/**
 * A send that failed produced no message, so the pending self-message must be disarmed —
 * otherwise it would swallow the user's next real message and keep the budget spent.
 */
export function noteAutoCompactSendFailed(budget: AutoCompactBudget): AutoCompactBudget {
  return { ...budget, awaitingSelfMessage: false };
}

/** A completed compact→continue round. */
export function noteAutoCompactCycleComplete(budget: AutoCompactBudget): AutoCompactBudget {
  return { ...budget, cyclesUsed: budget.cyclesUsed + 1 };
}

/** Whether the status row should be visible at all, given how close the thread is. */
export const AUTO_COMPACT_STATUS_VISIBLE_WITHIN = 15;

export function shouldShowAutoCompactStatus(input: {
  readonly armed: boolean;
  readonly phase: AutoCompactPhase;
  readonly usedPercentage: number | null;
  readonly thresholdPercent: number;
  readonly cyclesUsed: number;
  readonly maxCycles: number;
}): boolean {
  if (!input.armed) return false;
  if (input.phase !== "idle") return true;
  // A thread parked at the cap has stopped acting and must say why, whatever its fullness.
  if (input.cyclesUsed >= input.maxCycles) return true;
  if (input.usedPercentage === null) return false;
  return input.usedPercentage >= input.thresholdPercent - AUTO_COMPACT_STATUS_VISIBLE_WITHIN;
}

/**
 * One line of status, in the same words on every surface.
 *
 * Deliberately silent about the mechanism: the reader wants to know whether the thread is
 * about to do something and whether it needs them, not which flag is set.
 */
export function autoCompactStatusText(input: {
  readonly phase: AutoCompactPhase;
  readonly usedPercentage: number | null;
  readonly thresholdPercent: number;
  readonly threadBusy: boolean;
  readonly cyclesUsed: number;
  readonly maxCycles: number;
  readonly lastHold: AutoCompactHoldReason | null;
}): string {
  if (input.phase === "compacting") return "Compacting this thread…";
  if (input.phase === "continuing") return "Compacted. Continuing where it left off.";
  if (input.cyclesUsed >= input.maxCycles) {
    return `Paused after ${input.maxCycles} rounds — send a message to resume`;
  }
  if (input.lastHold === "compaction-ineffective") {
    return "Compacting freed no room — paused until you send a message";
  }
  if (input.lastHold === "unsupported-provider") {
    return "This provider cannot compact on request";
  }
  const atThreshold =
    input.usedPercentage !== null && input.usedPercentage >= input.thresholdPercent;
  if (atThreshold && input.threadBusy) {
    return `At ${input.thresholdPercent}% — compacting when the thread goes idle`;
  }
  return `Will compact at ${input.thresholdPercent}%`;
}

/** Clamp a user-entered threshold into the supported band. */
export function clampAutoCompactThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT;
  return Math.min(
    MAX_AUTO_COMPACT_THRESHOLD_PERCENT,
    Math.max(MIN_AUTO_COMPACT_THRESHOLD_PERCENT, Math.round(value)),
  );
}
