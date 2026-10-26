/**
 * What each thread last reported per kind of checkpoint capture failure. Such failures are usually
 * a property of the workspace, so they repeat identically every turn (one thread logged 37 across
 * 37 turns); the first carries the message and the rest only bury it.
 */

/** The three failures a capture can report. The kind is the dedup key. */
export const CAPTURE_FAILED = "Checkpoint capture failed";
export const DIFF_SUMMARY_UNAVAILABLE = "Checkpoint captured without a diff summary";
export const UNREADABLE_MEMBERS = "Checkpoint captured with unreadable repositories";

export interface CaptureFailureLog {
  /**
   * Whether this failure says something the thread's last one of the same kind did not,
   * recording it when it does.
   */
  readonly shouldReport: (input: {
    readonly threadId: string;
    readonly summary: string;
    readonly detail: string;
  }) => boolean;
  /** Forget one kind for a thread, so its next occurrence is reported again. */
  readonly forget: (threadId: string, summary: string) => void;
}

export function makeCaptureFailureLog(): CaptureFailureLog {
  // Keyed per kind rather than per thread. A thread can stand in more than one of these
  // at once, and a single slot per thread lets two of them take turns evicting each
  // other - each then looks new every turn, and both are reported every turn, which is
  // the defect this exists to remove rather than a smaller version of it.
  const byThread = new Map<string, Map<string, string>>();

  return {
    shouldReport: (input) => {
      const byKind = byThread.get(input.threadId) ?? new Map<string, string>();
      if (byKind.get(input.summary) === input.detail) return false;
      byKind.set(input.summary, input.detail);
      byThread.set(input.threadId, byKind);
      return true;
    },
    forget: (threadId, summary) => {
      const byKind = byThread.get(threadId);
      if (!byKind) return;
      byKind.delete(summary);
      // Drop the thread once it stands in nothing, so a server that has seen many
      // threads fail transiently does not keep a row for each of them forever.
      if (byKind.size === 0) byThread.delete(threadId);
    },
  };
}
