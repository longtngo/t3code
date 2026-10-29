import { useEffect, useRef, useState } from "react";

import { useDocumentVisible } from "./useDocumentVisible";
import type { EnvironmentId, ResourceQueueSnapshot } from "@t3tools/contracts";

import { resourceQueueEnvironment } from "../state/resourceQueue";
import { useEnvironmentQuery } from "../state/query";

/** Background cadence: a glanceable count that does not need to be live. */
const IDLE_INTERVAL_MS = 60_000;
/** Active cadence: while the popover is open, refresh the list + count every few seconds. */
const ACTIVE_INTERVAL_MS = 5_000;

export interface ResourceQueueState {
  /** Latest snapshot, or null before the first poll resolves. */
  readonly snapshot: ResourceQueueSnapshot | null;
}

/**
 * Poll the environment's resource-broker queue via its query atom. The cadence is `fast`
 * (popover open) vs slow (background); it re-polls immediately when the cadence changes so
 * opening the popover refreshes at once. Polling pauses while the tab is hidden, and a
 * transient failure keeps the last snapshot rather than clearing it.
 */
export function useResourceQueue(
  environmentId: EnvironmentId | null,
  fast: boolean,
): ResourceQueueState {
  const visible = useDocumentVisible();
  const active = environmentId != null && visible;
  const intervalMs = fast ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;

  const queryAtom =
    environmentId == null ? null : resourceQueueEnvironment.get({ environmentId, input: {} });
  const { data, refresh } = useEnvironmentQuery(queryAtom);

  // The query atom keeps its previous value while revalidating and drops it only on a hard
  // failure; latch the last non-null snapshot so a transient error never blanks the UI.
  const [snapshot, setSnapshot] = useState<ResourceQueueSnapshot | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- latches the last non-null query snapshot so a transient error never blanks it
  useEffect(() => {
    if (data != null) setSnapshot(data);
  }, [data]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the latched snapshot when no environment is selected
  useEffect(() => {
    if (environmentId == null) setSnapshot(null);
  }, [environmentId]);

  // Drive the poll cadence by refreshing the atom. Refreshing on the cadence change forces an
  // immediate revalidation (e.g. when the popover opens and `fast` flips true).
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polling interval that refreshes the resource queue atom while active
  useEffect(() => {
    if (!active) return;
    refreshRef.current();
    const id = setInterval(() => refreshRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);

  return { snapshot };
}
