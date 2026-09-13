import { useState } from "react";

import type { EnvironmentId, OrchestrationBackgroundTask, ThreadId } from "@t3tools/contracts";

import type { BackgroundTasksReadStatus } from "../components/BackgroundTasksPanel.logic";
import { taskListHistoryStatus } from "../components/TaskListPanel.logic";
import { useEnvironmentSupportsThreadBackgroundTasks } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { threadBackgroundTasksEnvironment } from "../state/threadBackgroundTasks";

interface LandedRead {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationBackgroundTask>;
}

/**
 * The Background panel's data. `enabled` requests the read: pass whether the Background panel is
 * showing, so a thread view alone never fires it. `refreshKey` changes on every task transition
 * (see `backgroundTasksRefreshKey`); the last landed list for the same thread stays on screen
 * while the next read runs.
 */
export function useBackgroundTasks(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  refreshKey: string,
  enabled: boolean,
  serverThread: boolean,
): {
  readonly tasks: ReadonlyArray<OrchestrationBackgroundTask> | null;
  readonly status: BackgroundTasksReadStatus;
  readonly retry: () => void;
} {
  const supported = useEnvironmentSupportsThreadBackgroundTasks(environmentId);
  // Nulled unless the panel shows: subscribing is what fires the fetch. Also nulled when
  // unsupported, since an older server answers an unknown method with a defect.
  const queryAtom =
    environmentId === null || threadId === null || supported !== true || !enabled || !serverThread
      ? null
      : threadBackgroundTasksEnvironment.list({ environmentId, input: { threadId, refreshKey } });
  const { data, error, isPending, refresh } = useEnvironmentQuery(queryAtom);
  const current = queryAtom === null ? null : data;

  const [landed, setLanded] = useState<LandedRead | null>(null);
  if (
    current !== null &&
    environmentId !== null &&
    threadId !== null &&
    landed?.tasks !== current
  ) {
    setLanded({ environmentId, threadId, tasks: current });
  }
  const tasks =
    current ??
    (landed !== null && landed.environmentId === environmentId && landed.threadId === threadId
      ? landed.tasks
      : null);

  const [previousStatus, setPreviousStatus] = useState<BackgroundTasksReadStatus>("pending");
  const status = taskListHistoryStatus({
    supported,
    enabled,
    serverThread,
    error,
    current,
    isPending,
    previousStatus,
  });
  if (enabled && status !== previousStatus) setPreviousStatus(status);
  return { tasks: serverThread ? tasks : [], status, retry: refresh };
}
