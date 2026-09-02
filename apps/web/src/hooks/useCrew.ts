import { useEffect, useRef, useState } from "react";

import type { CrewTaskView, EnvironmentId } from "@t3tools/contracts";

import { useDocumentVisible } from "./useDocumentVisible";
import { crewEnvironment } from "../state/crew";
import { useEnvironmentQuery } from "../state/query";

/** Background cadence: crew state changes on a 60s sweep, so match it. */
const IDLE_INTERVAL_MS = 60_000;
/** Active cadence: while the panel is open, keep up with operator actions. */
const ACTIVE_INTERVAL_MS = 5_000;

export interface CrewState {
  /** Latest task list, or null before the first poll resolves. */
  readonly tasks: ReadonlyArray<CrewTaskView> | null;
}

/**
 * Poll the environment's crew via its query atom, on the `useResourceQueue`
 * cadence: slow in the background, faster while the panel is open, re-polling
 * immediately when the cadence changes so opening the panel refreshes at once.
 *
 * Polling pauses while the tab is hidden, and a transient failure keeps the last
 * list rather than blanking the panel — a crew task that vanishes and returns
 * reads as a task that was torn down, which is a different and alarming thing.
 */
export function useCrew(environmentId: EnvironmentId | null, fast: boolean): CrewState {
  const visible = useDocumentVisible();
  const active = environmentId != null && visible;
  const intervalMs = fast ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;

  const queryAtom =
    environmentId == null ? null : crewEnvironment.list({ environmentId, input: {} });
  const { data, refresh } = useEnvironmentQuery(queryAtom);

  const [tasks, setTasks] = useState<ReadonlyArray<CrewTaskView> | null>(null);
  useEffect(() => {
    if (data != null) setTasks(data.tasks);
  }, [data]);
  useEffect(() => {
    if (environmentId == null) setTasks(null);
  }, [environmentId]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!active) return;
    refreshRef.current();
    const id = setInterval(() => refreshRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);

  return { tasks };
}
