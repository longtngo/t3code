/**
 * Tells the user when a title regeneration they asked for failed.
 *
 * Regeneration runs in a server reactor, so the click that starts it cannot
 * learn the outcome — the request is accepted long before the work happens.
 * The server records `titleRegenerationFailedAt` on the thread instead, and
 * this hook watches every thread shell for that value changing.
 *
 * Shells (not the open thread) are the right source: "Regenerate title" is
 * reachable from the sidebar for threads that are not open, which is the case
 * that most needs the feedback.
 *
 * Mount once near the app root, beside the other thread-wide observers.
 */
import { useEffect, useRef } from "react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useThreadShells } from "../state/entities";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { shouldReportTitleRegenerationFailure } from "@t3tools/client-runtime/state/title-regeneration-failures";

export function useTitleRegenerationFailureToasts(): void {
  // Last value seen per thread. A thread missing from this map has never been
  // observed, which is what keeps hydration silent.
  const seenFailedAt = useRef(new Map<string, string | null>());
  const threads = useThreadShells();

  useEffect(() => {
    for (const thread of threads) {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const failedAt = thread.titleRegenerationFailedAt ?? null;
      const observedBefore = seenFailedAt.current.has(key);
      const previousFailedAt = seenFailedAt.current.get(key) ?? null;
      seenFailedAt.current.set(key, failedAt);

      if (!shouldReportTitleRegenerationFailure({ observedBefore, previousFailedAt, failedAt })) {
        continue;
      }

      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn't regenerate the title",
          description: `"${thread.title}" kept its existing title. Try again.`,
        }),
      );
    }
  }, [threads]);
}
