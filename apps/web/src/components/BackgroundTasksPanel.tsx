/**
 * Background section of the thread details card: the provider work still running for this
 * thread (background shells, monitors, subagents). Answers "what is it waiting on?" when the
 * thread reads Waiting.
 *
 * Rows come from `backgroundPanelTasks`; nothing here animates. The fork's "started X ago" and
 * duration are not shown: the v2 background roster carries no timestamps.
 */
import type { PendingBackgroundWorkTask } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { memo } from "react";

import { ThreadDetailsRowGroup } from "./chat/ThreadDetailsRowGroup";
import { ThreadDetailsSection } from "./chat/ThreadDetailsSection";
import { backgroundTaskKindLabel } from "./BackgroundTasksPanel.logic";

function BackgroundTaskRow({ task }: { task: PendingBackgroundWorkTask }) {
  const title = task.description ?? task.taskId;
  const kind = backgroundTaskKindLabel(task.kind);
  return (
    <li
      className="flex min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2"
      aria-label={`${title}, ${kind}, running`}
    >
      <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-info" />
      <span className="min-w-0 flex-1">
        {/* Wraps rather than truncates: the title is the answer to "what is running?". */}
        <span className="block break-words text-sm leading-snug text-foreground/90">{title}</span>
        <span className="block truncate text-2xs text-muted-foreground/60">{kind} · running</span>
      </span>
    </li>
  );
}

export const BackgroundTasksPanel = memo(function BackgroundTasksPanel({
  threadKey,
  tasks,
}: {
  threadKey: string;
  tasks: ReadonlyArray<PendingBackgroundWorkTask>;
}) {
  if (tasks.length === 0) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-background-heading"
      title={`Background · ${tasks.length} running`}
      data-thread-details-activity
    >
      <ThreadDetailsRowGroup key={`${threadKey}:background`} rows={tasks}>
        {(visible) => (
          <ul className="flex flex-col gap-0.5">
            {visible.map((task) => (
              <BackgroundTaskRow key={task.taskId} task={task} />
            ))}
          </ul>
        )}
      </ThreadDetailsRowGroup>
    </ThreadDetailsSection>
  );
});
