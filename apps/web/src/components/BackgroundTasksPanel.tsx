/**
 * Background right-panel surface: the provider work still running for this thread (background
 * shells, monitors, subagents). Answers "what is it waiting on?" when the thread reads Waiting.
 *
 * Rows come from `backgroundPanelTasks`; nothing here animates.
 */
import type { PendingBackgroundWorkTask } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { ActivityIcon } from "lucide-react";
import { memo } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";
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
  tasks,
}: {
  tasks: ReadonlyArray<PendingBackgroundWorkTask>;
}) {
  if (tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <ActivityIcon aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No background tasks</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          Nothing is running in the background for this thread.
        </p>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <ActivityIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Background</span>
        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
          {tasks.length} running
        </span>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-0.5 p-2">
          {tasks.map((task) => (
            <BackgroundTaskRow key={task.taskId} task={task} />
          ))}
        </ul>
      </ScrollArea>
    </div>
  );
});
