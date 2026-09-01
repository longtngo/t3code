// @effect-diagnostics globalDate:off -- UI snooze presets use local calendar boundaries and Intl labels.
import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { isQueuedTurnStart, latestTurnTimestampMs } from "@t3tools/shared/queuedTurnStart";

/**
 * A queued turn start lives for at most this long: session adoption takes
 * seconds, so a user message still unadopted after the grace window is a
 * failed start (or stale data — shells from older servers can carry user
 * messages with no latestTurn at all), not pending work. Without this bound
 * such threads would be permanently unsettleable.
 */
// Re-exported, not redefined: the fork made `@t3tools/shared/queuedTurnStart` the
// single source of this rule so the decider and the clients cannot drift apart.
export { QUEUED_TURN_START_GRACE_MS } from "@t3tools/shared/queuedTurnStart";
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * A user message no turn has picked up yet: the turn.start command was
 * dispatched (message-sent + turn-start-requested) but no session has
 * adopted it, so `session` is still null and the pending work is invisible
 * to the session-status checks. Detectable as a user message strictly newer
 * than every timestamp on the latest turn — on adoption the new turn's
 * requestedAt equals the message time, clearing the condition — and only
 * within the adoption grace window.
 */
export function hasQueuedTurnStart(
  shell: Pick<OrchestrationThreadShell, "latestUserMessageAt" | "latestTurn" | "session">,
  options: { readonly now: string },
): boolean {
  if (shell.latestUserMessageAt == null) return false;
  return isQueuedTurnStart({
    latestUserMessageAtMs: Date.parse(shell.latestUserMessageAt),
    latestTurnAtMs: latestTurnTimestampMs(shell.latestTurn),
    sessionStatus: shell.session?.status,
    nowMs: Date.parse(options.now),
  });
}

/**
 * Providers that open a DISTINCT turn for a message held during a running
 * turn, so the shell changes shape when the agent picks it up.
 *
 * Per-adapter decision, required because the label must stop being true:
 * - `claudeAgent` — holds in `pendingTurns` and drains via `startTurnNow`,
 *   which emits a fresh `turn.started`. The label clears. Included.
 * - `codex` — its app-server queues and reports a real per-turn
 *   `turn/started`, mapped straight through. The label clears. Included.
 * - `cursor`, `grok`, `opencode` — reuse the running turn's id and gate
 *   `turn.started` behind `steeringTurnId === undefined`, so no new turn is
 *   ever announced. Nothing would clear the label until the whole merged turn
 *   ended, leaving it lying while the agent was already working on the
 *   message. Excluded until those adapters open a turn of their own.
 */
const PROVIDERS_THAT_OPEN_A_HELD_TURN: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/**
 * A user message being held until the turn currently in flight finishes.
 *
 * The message is already in the transcript — the decider persists it before
 * the adapter is ever called — so without this it looks identical to one being
 * worked on.
 *
 * Deliberately unbounded, unlike {@link hasQueuedTurnStart}. That predicate
 * covers a message NO turn has adopted, where a failed start would read as
 * pending work forever, so it needs the adoption grace window. Here a turn is
 * demonstrably running and its completion is what clears this — real holds run
 * to a p90 of 36 minutes, far past any grace window, and are still waiting.
 */
export type WaitingMessageShell = Pick<
  OrchestrationThreadShell,
  "latestUserMessageAt" | "latestTurn" | "session"
>;

/** The slice of a message these rules need. */
export interface WaitingMessageLike {
  readonly id: string;
  readonly role: string;
  readonly createdAt: string;
}

/**
 * The instant the running turn last advanced. Any user message strictly newer
 * than this is being held behind that turn. `null` when nothing can be held —
 * no turn in flight, a provider that never opens a distinct turn, or a
 * `latestTurn` that has drifted off the active one.
 *
 * All-null turn timestamps yield -Infinity, so every message counts as newer,
 * and an unparseable one yields NaN, so none do. Both match the per-candidate
 * comparison this replaced.
 */
function runningTurnAdvancedAtMs(shell: WaitingMessageShell): number | null {
  const session = shell.session;
  // A turn must actually be in flight: without an active turn the message is
  // either being worked on or is hasQueuedTurnStart's case, not this one.
  if (session == null || session.activeTurnId == null) return null;
  if (session.status !== "running" && session.status !== "starting") return null;
  if (session.providerName == null || !PROVIDERS_THAT_OPEN_A_HELD_TURN.has(session.providerName)) {
    return null;
  }
  const turn = shell.latestTurn;
  // `latestTurn` and the session's active turn can genuinely diverge: a
  // `thread.turn-diff-completed` for the PREVIOUS turn lands asynchronously
  // behind a git diff and rewrites `latestTurnId` unconditionally, regressing
  // it to that older, completed turn. Comparing against it would then label the
  // message the agent is working on right now as "waiting", for the whole turn.
  if (turn === null || turn.turnId !== session.activeTurnId) return null;
  // The message that STARTED the turn shares its requestedAt, so the comparison
  // against this is strict and that message never flags itself.
  return Math.max(
    ...[turn.requestedAt, turn.startedAt, turn.completedAt].map((candidate) =>
      candidate == null ? Number.NEGATIVE_INFINITY : Date.parse(candidate),
    ),
  );
}

export function hasWaitingUserMessage(shell: WaitingMessageShell): boolean {
  if (shell.latestUserMessageAt == null) return false;
  const advancedAt = runningTurnAdvancedAtMs(shell);
  if (advancedAt === null) return false;
  const messageAt = Date.parse(shell.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  return messageAt > advancedAt;
}

const NO_WAITING_MESSAGES: ReadonlySet<string> = new Set();

/**
 * Every user message the running turn is holding, not just the newest — two
 * messages sent during one turn are both waiting, and labelling only the last
 * leaves the earlier one looking delivered.
 */
export function waitingUserMessageIds(
  shell: WaitingMessageShell,
  messages: ReadonlyArray<WaitingMessageLike>,
): ReadonlySet<string> {
  const advancedAt = runningTurnAdvancedAtMs(shell);
  if (advancedAt === null) return NO_WAITING_MESSAGES;
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    const createdAt = Date.parse(message.createdAt);
    if (!Number.isNaN(createdAt) && createdAt > advancedAt) ids.add(message.id);
  }
  return ids.size === 0 ? NO_WAITING_MESSAGES : ids;
}

/**
 * The snooze lifecycle fields plus everything needed to detect a raised
 * hand. Snooze is an overlay on the active state: a snoozed thread stays
 * "active" in the data model and is only suppressed from the inbox until
 * its wake time passes or the thread demands attention.
 */
export type ThreadSnoozeShell = Pick<
  OrchestrationThreadShell,
  | "snoozedUntil"
  | "snoozedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "session"
  | "latestTurn"
>;

/**
 * A snoozed thread "raises its hand" when something happens that outranks
 * the user's snooze: the agent is blocked on them (approval / user input),
 * the session failed, or a run completed after the snooze was set — the
 * v1 taste of event-based snooze ("something happened" wakes early).
 * Raising a hand never clears the server-side snooze fields; it only stops
 * the thread from classifying as snoozed.
 */
export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return true;
  // Only a FRESH failure raises the hand: a thread snoozed while already
  // failed stays snoozed — that snooze was the user saying "I saw it, not
  // now". session.updatedAt stamps the status edge, so an error newer than
  // the snooze is new information.
  if (
    shell.session?.status === "error" &&
    (shell.snoozedAt == null || Date.parse(shell.session.updatedAt) > Date.parse(shell.snoozedAt))
  ) {
    return true;
  }
  if (
    shell.snoozedAt != null &&
    shell.latestTurn?.state === "completed" &&
    shell.latestTurn.completedAt != null &&
    Date.parse(shell.latestTurn.completedAt) > Date.parse(shell.snoozedAt)
  ) {
    return true;
  }
  return false;
}

/**
 * A thread may be snoozed unless the agent is blocked on the user: hiding a
 * pending approval or user-input request defeats the request, and a queued
 * turn start (a message no turn has adopted yet) is invisible pending work
 * the same way it is for settle. A running session IS snoozable — snooze
 * only affects visibility, never the agent. Client-side twin of the server
 * invariants so the UI can reject before a round trip.
 */
export function canSnooze(
  shell: Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "latestUserMessageAt" | "latestTurn" | "session"
  >,
  options: { readonly now: string },
): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  if (hasQueuedTurnStart(shell, options)) return false;
  return true;
}

/**
 * Snoozed resolution: hidden from the inbox while the wake time is in the
 * future and the thread has not raised its hand. Timer wakes are derived —
 * no server event fires when snoozedUntil passes; the stale fields simply
 * stop classifying as snoozed (and feed the woke indicator until the user
 * visits or re-engages).
 */
export function effectiveSnoozed(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): boolean {
  if (shell.snoozedUntil == null) return false;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  // Malformed data never hides a thread.
  if (Number.isNaN(wakeAtMs)) return false;
  if (wakeAtMs <= Date.parse(options.now)) return false;
  return !threadRaisedHandWhileSnoozed(shell);
}

/**
 * When a previously-snoozed thread woke, or null if it never snoozed / is
 * still snoozed. Used for the "Woke" indicator: the thread reappears in its
 * original sort position (the inbox sort is deliberately static), so the
 * wake signal has to carry the weight. Compare against the client's
 * lastVisitedAt — visiting clears the indicator like it clears unread.
 *
 * Timer wakes report the wake time itself; raised-hand wakes report the
 * triggering timestamp so a visit BEFORE the early wake doesn't suppress
 * the indicator.
 */
export function threadWokeAt(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): string | null {
  if (shell.snoozedUntil == null) return null;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return null;
  // An early hand-raise wake stays authoritative even after the scheduled
  // wake time passes: reporting snoozedUntil then would resurface a Woke
  // indicator the user already cleared by visiting (snoozedUntil is newer
  // than that visit's lastVisitedAt).
  if (threadRaisedHandWhileSnoozed(shell)) {
    if (
      shell.snoozedAt != null &&
      shell.latestTurn?.state === "completed" &&
      shell.latestTurn.completedAt != null &&
      Date.parse(shell.latestTurn.completedAt) > Date.parse(shell.snoozedAt)
    ) {
      return shell.latestTurn.completedAt;
    }
    return shell.session?.updatedAt ?? shell.snoozedAt ?? null;
  }
  // No raised hand: woke iff the timer elapsed (still-snoozed → null).
  return wakeAtMs <= Date.parse(options.now) ? shell.snoozedUntil : null;
}

const HOUR_MS = 60 * 60 * 1_000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

export type SnoozePresetId = "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  /** Menu-row time column. Complements the label instead of repeating it:
      "Tomorrow" pairs with "9:00 AM", not "tomorrow 9:00 AM". */
  readonly whenLabel: string;
  /** ISO wake time. */
  readonly snoozedUntil: string;
}

function snoozeTimeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function snoozeAtHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day
// is 23 hours, so 23:30 + 24h skips the whole next day).
function addSnoozeDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Shared "snooze until" choices for every client. "This evening" only
 * appears while it is meaningfully before evening; after that the calendar
 * choices start at "Tomorrow". Calendar presets that land on the same
 * instant collapse: on Sundays "Tomorrow" and "Next week" are both Monday
 * morning, so only "Tomorrow" is offered.
 */
export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const inThreeHours = new Date(now.getTime() + 3 * HOUR_MS);
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: snoozeTimeOfDayLabel(inAnHour),
      snoozedUntil: inAnHour.toISOString(),
    },
    {
      id: "three-hours",
      label: "In 3 hours",
      whenLabel: snoozeTimeOfDayLabel(inThreeHours),
      snoozedUntil: inThreeHours.toISOString(),
    },
  ];

  const evening = snoozeAtHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: snoozeTimeOfDayLabel(evening),
      snoozedUntil: evening.toISOString(),
    });
  }

  const tomorrow = snoozeAtHour(addSnoozeDays(now, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: snoozeTimeOfDayLabel(tomorrow),
    snoozedUntil: tomorrow.toISOString(),
  });

  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = snoozeAtHour(addSnoozeDays(now, daysUntilMonday), MORNING_HOUR);
  if (nextWeek.getTime() !== tomorrow.getTime()) {
    presets.push({
      id: "next-week",
      label: "Next week",
      whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${snoozeTimeOfDayLabel(nextWeek)}`,
      snoozedUntil: nextWeek.toISOString(),
    });
  }

  return presets;
}

/**
 * Compact "wakes in" label for snoozed rows: "2h", "18h", "3d". Minutes
 * round up so a snooze never reads "0m" while still hidden. Shared by web
 * and mobile so the same wake time never reads differently per client.
 */
export function snoozeWakeLabel(snoozedUntil: string, options: { readonly now: string }): string {
  const wakeMs = Date.parse(snoozedUntil);
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(wakeMs) || Number.isNaN(nowMs)) return "now";
  const remainingMs = wakeMs - nowMs;
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}
