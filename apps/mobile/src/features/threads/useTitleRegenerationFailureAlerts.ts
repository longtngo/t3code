/**
 * Alerts when a requested title regeneration failed. The server runs it in a reactor, so
 * the caller cannot see the outcome; this watches `titleRegenerationFailedAt` instead.
 * Mount once at the app root.
 */
import { useEffect, useRef } from "react";
import { Alert } from "react-native";
import { shouldReportTitleRegenerationFailure } from "@t3tools/client-runtime/state/title-regeneration-failures";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { useThreadShells } from "../../state/entities";

export function useTitleRegenerationFailureAlerts(): void {
  // Absence means "never observed" and suppresses the alert, so a persisted failure does
  // not alert on first load. Never pruned (same on web): dropping a thread that left the
  // list, e.g. when an environment leaves the catalog, would swallow a failure landing in
  // that window. One string per thread is cheaper than an unrecoverable missed alert.
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
