/**
 * Tells the user when a title regeneration they asked for failed. It runs in a server reactor,
 * so the click cannot learn the outcome; this watches every shell's `titleRegenerationFailedAt`
 * (shells, because regeneration is reachable for threads that are not open). Mount once at root.
 */
import { useEffect, useRef } from "react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useThreadShells } from "../state/entities";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { shouldReportTitleRegenerationFailure } from "@t3tools/client-runtime/state/title-regeneration-failures";

export function useTitleRegenerationFailureToasts(): void {
  // Last value seen per thread; absence means never observed, which keeps hydration silent.
  // Never pruned: dropping a thread that left the shell list (an environment dropping out)
  // would swallow a failure landing then. Growth is one string per thread ever seen.
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
