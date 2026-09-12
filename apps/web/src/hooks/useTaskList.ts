import { useMemo, useRef, useState } from "react";

import type {
  EnvironmentId,
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";

import { useNowMinute } from "./useNowMinute";
import {
  derivePlanGroups,
  resolvePlanHistoryRows,
  selectTaskListView,
  unionPlanActivityRows,
  type LandedPlanHistoryRead,
  type TaskListView,
} from "../session-logic";
import { taskListHistoryStatus } from "../components/TaskListPanel.logic";
import { useEnvironmentSupportsThreadPlanHistory } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { threadPlanHistoryEnvironment } from "../state/threadPlanHistory";

export interface TaskListState extends TaskListView {
  /**
   * Why `primary` may be null on a thread that does have task lists. `unsupported`: the server
   * has no history read. `error`: the read failed or timed out. Either way live activities can
   * still supply the latest turn's plan, but an older promoted group has no source — the panel
   * must not render that as an empty thread.
   */
  readonly historyStatus: "unsupported" | "pending" | "ready" | "error";
  readonly retry: () => void;
}

/**
 * The Task list panel's data: the thread's plan-history read unioned with its live plan rows,
 * grouped per turn, then split into a primary group and history.
 *
 * Must be the only `derivePlanGroups` caller for a thread: its bucket cache has one slot per turn,
 * so a second caller over a different row list thrashes it.
 *
 * `enabled` requests the history read: pass whether the Task list panel is showing, so a thread
 * view alone never fires it. Everything else stays live, so the badge and pill work with the
 * panel closed and the retained read keeps history on screen across a tab switch.
 * `serverThread` is false for a draft the server does not know, which has no history to read.
 */
export function useTaskList(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  latestTurn: OrchestrationLatestTurn | null,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  enabled: boolean,
  serverThread: boolean,
): TaskListState {
  const supported = useEnvironmentSupportsThreadPlanHistory(environmentId);
  const latestTurnId = latestTurn?.turnId ?? null;

  // Nulled unless the panel shows: subscribing is what fires the fetch. Also nulled when
  // unsupported, since an older server answers an unknown method with a defect, not a typed error.
  const queryAtom =
    environmentId === null || threadId === null || supported !== true || !enabled || !serverThread
      ? null
      : threadPlanHistoryEnvironment.list({ environmentId, input: { threadId, latestTurnId } });
  const { data, error, isPending, refresh } = useEnvironmentQuery(queryAtom);
  const current = queryAtom === null ? null : data;

  // The query starts every new key empty; keep the last landed read so a turn change does not
  // drop cut turns back to truncated durations while the new read is in flight.
  const [retained, setRetained] = useState<LandedPlanHistoryRead | null>(null);
  if (
    current !== null &&
    environmentId !== null &&
    threadId !== null &&
    retained?.rows !== current
  ) {
    setRetained({ environmentId, threadId, rows: current });
  }

  const readRows = useMemo(
    () => resolvePlanHistoryRows(current, retained, environmentId, threadId, latestTurn),
    [current, retained, environmentId, threadId, latestTurn],
  );
  // Held in state so the union can be compared with the previous one: a non-plan append makes a
  // new `activities` array over the same plan rows, and must not bust the group memo.
  const [rows, setRows] = useState(() => unionPlanActivityRows(readRows, activities, null));
  const nextRows = useMemo(
    () => unionPlanActivityRows(readRows, activities, rows),
    [readRows, activities, rows],
  );
  if (nextRows !== rows) setRows(nextRows);
  const groups = useMemo(() => derivePlanGroups(nextRows), [nextRows]);

  const nowMinute = useNowMinute();
  const view = useMemo(
    () => selectTaskListView(groups, latestTurnId, Date.parse(`${nowMinute}:00.000Z`)),
    [groups, latestTurnId, nowMinute],
  );

  const historyStatusRef = useRef<TaskListState["historyStatus"] | null>(null);
  const historyStatus = taskListHistoryStatus({
    supported,
    enabled,
    serverThread,
    error,
    current,
    isPending,
    previousStatus: historyStatusRef.current ?? "pending",
  });
  if (enabled) historyStatusRef.current = historyStatus;
  return { ...view, historyStatus, retry: refresh };
}
