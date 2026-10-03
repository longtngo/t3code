import { useEffect, useRef, useState } from "react";

import type { CrewTaskView, EnvironmentId } from "@t3tools/contracts";

import { useDocumentVisible } from "./useDocumentVisible";
import { crewEnvironment } from "../state/crew";
import { useEnvironmentSupportsCrew } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";

/** Active cadence: while the panel is open, keep up with operator actions. */
const ACTIVE_INTERVAL_MS = 5_000;

export interface CrewState {
  /** Latest task list, or null before the first poll resolves. */
  readonly tasks: ReadonlyArray<CrewTaskView> | null;
  /**
   * Whether this environment's server serves crew at all.
   *
   * Surfaced because `tasks` cannot distinguish "not answered yet" from "never
   * will be": both are null, so a panel keyed on `tasks` alone shows a loading
   * line forever against a server that has no `crew.list`.
   */
  readonly supported: boolean;
}

/**
 * Read the environment's crew list. The background refresh belongs to the shared atom
 * (`CREW_LIST_REFRESH_MS`), so every caller shares one poller; `fast` adds a 5s refresh
 * while the panel is open and the tab visible, and refreshes at once when it opens.
 *
 * A transient failure keeps the last list rather than blanking the panel — a crew task
 * that vanishes and returns reads as a task that was torn down, which is a different and
 * alarming thing.
 */
export function useCrew(environmentId: EnvironmentId | null, fast: boolean): CrewState {
  const visible = useDocumentVisible();
  // `supportsCrew` is false for a null environment too, so it subsumes the
  // id check the `queryAtom` ternary below still needs for type narrowing.
  const supportsCrew = useEnvironmentSupportsCrew(environmentId);
  const active = visible && supportsCrew && fast;

  // Nulled when unsupported, not merely left unpolled: `useEnvironmentQuery`
  // subscribes to the atom, and subscribing is what fires the first fetch. A
  // gate on the interval alone would still send one `crew.list` per mount.
  const queryAtom =
    environmentId == null || !supportsCrew
      ? null
      : crewEnvironment.list({ environmentId, input: {} });
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
    const id = setInterval(() => refreshRef.current(), ACTIVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active]);

  return { tasks, supported: supportsCrew };
}
