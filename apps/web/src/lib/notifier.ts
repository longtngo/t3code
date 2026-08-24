/**
 * Thread-completion OS notifications (web).
 *
 * Raised when a thread's turn transitions running -> terminal while the user is
 * not actively viewing that thread. Uses the W3C `Notification` API and
 * `document.visibilityState`/`document.hasFocus()` to decide whether the user
 * is actually looking at the completing thread.
 *
 * This module is intentionally free of React/router imports so the detection
 * and gating logic stays unit-testable. The app registers a host (navigation +
 * active-thread lookup) via `registerThreadNotificationHost`.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  NotificationCategorySettings,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

import { isElectron } from "../env";

export type TerminalTurnOutcome = "completed" | "error" | "interrupted";

export interface ThreadCompletion {
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly title: string;
  readonly outcome: TerminalTurnOutcome;
  /**
   * Whether other work was still running when this turn settled. An agent that
   * fans out to subagents settles its turn once per wake-up; those interim
   * finishes are a separate category from the one that means "it is all done".
   */
  readonly backgroundActive: boolean;
}

/** Mirrors the server-side mapping in `WebPushRelay.filterEdgesByCategory`. */
function categoryForCompletion(completion: ThreadCompletion): keyof NotificationCategorySettings {
  if (completion.outcome === "error") {
    return "failed";
  }
  return completion.backgroundActive ? "finishedBackground" : "finished";
}

const TERMINAL_OUTCOMES = new Set<TerminalTurnOutcome>(["completed", "error", "interrupted"]);

function isTerminalOutcome(state: string | undefined): state is TerminalTurnOutcome {
  return state !== undefined && TERMINAL_OUTCOMES.has(state as TerminalTurnOutcome);
}

/**
 * Decide whether a thread's latest-turn change represents a turn that just
 * finished — it was `running` and is now terminal. Returns the completion
 * descriptor, or `null` when this is not a running -> terminal edge (so a
 * re-applied/stale shell event or an already-terminal turn yields nothing).
 */
export function classifyThreadCompletion(input: {
  readonly threadId: ThreadId;
  readonly previousState: string | null | undefined;
  readonly nextTurnId: string | null | undefined;
  readonly nextState: string | null | undefined;
  readonly title: string;
  // `backgroundActive` is not decided here: this classifies the turn EDGE, while
  // background liveness is thread state the caller reads from the same shell.
}): Omit<ThreadCompletion, "backgroundActive"> | null {
  if (input.previousState !== "running") {
    return null;
  }
  const nextState = input.nextState ?? undefined;
  if (!input.nextTurnId || !isTerminalOutcome(nextState)) {
    return null;
  }
  return {
    threadId: input.threadId,
    turnId: input.nextTurnId,
    title: input.title,
    outcome: nextState,
  };
}

export interface ThreadNotificationHost {
  readonly navigateToThread: (ref: ScopedThreadRef) => void;
  readonly getActiveThreadRef: () => ScopedThreadRef | null;
}

let host: ThreadNotificationHost | null = null;

/** Register navigation + active-thread lookup. Returns an unregister fn. */
export function registerThreadNotificationHost(next: ThreadNotificationHost): () => void {
  host = next;
  return () => {
    if (host === next) {
      host = null;
    }
  };
}

const MAX_NOTIFIED_KEYS = 500;
const notifiedTurnKeys = new Set<string>();

function rememberNotified(key: string): void {
  notifiedTurnKeys.add(key);
  if (notifiedTurnKeys.size > MAX_NOTIFIED_KEYS) {
    const oldest = notifiedTurnKeys.values().next().value;
    if (oldest !== undefined) {
      notifiedTurnKeys.delete(oldest);
    }
  }
}

/** Suppress when the user is focused on the very thread that completed. */
function isViewingThread(ref: ScopedThreadRef): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  if (document.visibilityState !== "visible" || !document.hasFocus()) {
    return false;
  }
  const active = host?.getActiveThreadRef() ?? null;
  return (
    active !== null &&
    active.environmentId === ref.environmentId &&
    active.threadId === ref.threadId
  );
}

function outcomeBody(outcome: TerminalTurnOutcome): string {
  switch (outcome) {
    case "completed":
      return "The agent finished this task.";
    case "error":
      return "The agent stopped with an error.";
    case "interrupted":
      return "The turn was interrupted.";
  }
}

function dispatchNotification(ref: ScopedThreadRef, completion: ThreadCompletion): void {
  const title = completion.title || "Task finished";
  const body = outcomeBody(completion.outcome);

  if (isElectron) {
    // Feature-detect so a new web bundle served to an older desktop shell that
    // predates showNotification degrades to a no-op instead of throwing. The
    // main process owns presentation + reveal-on-click and pushes the thread
    // ref back over onNotificationActivated (wired in the React host).
    const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
    if (bridge && typeof bridge.showNotification === "function") {
      void bridge.showNotification({
        title,
        body,
        threadRef: { environmentId: ref.environmentId, threadId: ref.threadId },
      });
    }
    return;
  }

  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }
  try {
    // tag coalesces repeat notifications for the same thread.
    const notification = new Notification(title, { body, tag: ref.threadId });
    notification.addEventListener("click", () => {
      try {
        window.focus();
      } catch {
        // focus is best-effort
      }
      host?.navigateToThread(ref);
      notification.close();
    });
  } catch {
    // Some environments throw on construction; treat as unsupported.
  }
}

/**
 * Raise OS notifications for the given completions, honoring the user setting,
 * dedup (per thread+turn), and "don't notify the thread you're actively
 * viewing" suppression. Suppressed completions are still recorded so they do
 * not fire later if the window loses focus.
 */
export function notifyThreadCompletions(input: {
  readonly environmentId: EnvironmentId;
  readonly completions: ReadonlyArray<ThreadCompletion>;
  readonly enabled: boolean;
  readonly categories: NotificationCategorySettings;
}): void {
  if (!input.enabled || input.completions.length === 0) {
    return;
  }
  for (const completion of input.completions) {
    const key = `${completion.threadId}:${completion.turnId}`;
    if (notifiedTurnKeys.has(key)) {
      continue;
    }
    // Recorded before the category check, like the "already viewing" skip below:
    // this completion has happened, so turning the category back on later must
    // not replay it.
    rememberNotified(key);
    if (!input.categories[categoryForCompletion(completion)]) {
      continue;
    }
    const ref = scopeThreadRef(input.environmentId, completion.threadId);
    if (isViewingThread(ref)) {
      continue;
    }
    dispatchNotification(ref, completion);
  }
}

/**
 * Request OS notification permission. Must be called from a user gesture (the
 * settings toggle).
 */
export async function ensureWebNotificationPermission(): Promise<
  "granted" | "denied" | "unsupported"
> {
  // Desktop presents native notifications via the Electron main process, which
  // needs no web Notification permission — treat as granted so the toggle works.
  if (isElectron) {
    return "granted";
  }
  if (typeof Notification === "undefined") {
    return "unsupported";
  }
  if (Notification.permission === "granted") {
    return "granted";
  }
  if (Notification.permission === "denied") {
    return "denied";
  }
  try {
    const result = await Notification.requestPermission();
    return result === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

/** Test seam: clear module-level dedup + host registration. */
export function __resetThreadNotificationStateForTest(): void {
  notifiedTurnKeys.clear();
  host = null;
}
