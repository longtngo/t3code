/**
 * Tells the user when a title regeneration they asked for failed.
 *
 * The mobile counterpart of the web toast hook. Regeneration runs in a server
 * reactor, so the request is accepted long before the work happens and the
 * calling screen cannot learn the outcome; the server records
 * `titleRegenerationFailedAt` on the thread and this hook watches it change.
 *
 * An alert matches what this action already does for a dispatch failure
 * (`useThreadListActions`), so the two failure modes read the same way rather
 * than one being loud and the other silent.
 *
 * Mount once at the app root.
 */
import { useEffect, useRef } from "react";
import { Alert } from "react-native";
import { shouldReportTitleRegenerationFailure } from "@t3tools/client-runtime/state/title-regeneration-failures";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { useThreadShells } from "../../state/entities";

export function useTitleRegenerationFailureAlerts(): void {
  // A thread missing from this map has never been observed, which is what
  // keeps a persisted failure from alerting on first load.
  const seenFailedAt = useRef(new Map<string, string | null>());
  const threads = useThreadShells();

  useEffect(() => {
    for (const thread of threads) {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      const failedAt = thread.titleRegenerationFailedAt ?? null;
      const observedBefore = seenFailedAt.current.has(key);
      const previousFailedAt = seenFailedAt.current.get(key) ?? null;
      seenFailedAt.current.set(key, failedAt);

      if (!shouldReportTitleRegenerationFailure({ observedBefore, previousFailedAt, failedAt })) {
        continue;
      }

      Alert.alert(
        "Could not regenerate title",
        `"${thread.title}" kept its existing title. Try again.`,
      );
    }
  }, [threads]);
}
