/**
 * Background section of the thread details card: provider work still running (shells, monitors,
 * subagents), answering "what is it waiting on?". No start time or duration: the v2 background
 * roster carries no timestamps.
 */
import type { PendingBackgroundWorkTask } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { T, useGT, useMessages, Var } from "gt-react";
import { memo } from "react";

import { ThreadDetailsRowGroup } from "./chat/ThreadDetailsRowGroup";
import { ThreadDetailsSection } from "./chat/ThreadDetailsSection";
import { backgroundTaskKindMessage } from "./BackgroundTasksPanel.logic";

function BackgroundTaskRow({ task }: { task: PendingBackgroundWorkTask }) {
  const gt = useGT();
  const messages = useMessages();
  const title = task.description ?? task.taskId;
  const kind = messages(backgroundTaskKindMessage(task.kind));
  return (
    <li
      className="flex min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2"
      aria-label={gt("{title}, {kind}, running", { title, kind })}
    >
      <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-info" />
      <span className="min-w-0 flex-1">
        {/* Wraps rather than truncates: the title is the answer to "what is running?". */}
        <span className="block break-words text-sm leading-snug text-foreground/90">{title}</span>
        <span className="block truncate text-2xs text-muted-foreground/60">
          <T>
            <Var>{kind}</Var> · running
          </T>
        </span>
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
  const gt = useGT();
  if (tasks.length === 0) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-background-heading"
      collapseKey="background"
      title={gt("Background · {count} running", { count: tasks.length })}
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
