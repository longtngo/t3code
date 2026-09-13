/**
 * Background right-panel surface: the thread's shells and monitors, running ones first, finished
 * ones kept for 3 hours. Answers "what is it monitoring?" when the thread shows Monitoring.
 *
 * Times follow the minute clock; the only animation is the shared running glyph.
 */
import type { OrchestrationBackgroundTask } from "@t3tools/contracts";
import { ActivityIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import { useNowMinute } from "../hooks/useNowMinute";
import {
  backgroundTaskDetail,
  backgroundTasksPanelState,
  type BackgroundTasksReadStatus,
} from "./BackgroundTasksPanel.logic";
import { statusGlyph, type StatusGlyphTone } from "./SidebarSection";

const GLYPH_TONE = {
  running: "running",
  completed: "completed",
  failed: "failed",
  stopped: "idle",
} satisfies Record<OrchestrationBackgroundTask["status"], StatusGlyphTone>;

const STATUS_LABEL = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
} satisfies Record<OrchestrationBackgroundTask["status"], string>;

function PanelMessage({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <ActivityIcon aria-hidden className="size-6 text-muted-foreground/60" />
      <p className="text-sm font-medium">{title}</p>
      {detail ? <p className="max-w-56 text-xs text-muted-foreground">{detail}</p> : null}
      {onRetry ? (
        <Button size="xs" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function BackgroundTaskRow({ task, nowMs }: { task: OrchestrationBackgroundTask; nowMs: number }) {
  const finished = task.status !== "running";
  return (
    <li
      className="flex min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2"
      aria-label={`${task.title}, ${STATUS_LABEL[task.status]}`}
    >
      <span className="shrink-0">{statusGlyph(GLYPH_TONE[task.status])}</span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            // Wraps rather than truncates: the title is the answer to "what is running?".
            "block break-words text-[13px] leading-snug",
            finished ? "text-muted-foreground/70" : "text-foreground/90",
          )}
        >
          {task.title}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground/60">
          {backgroundTaskDetail(task, nowMs)}
        </span>
        {task.status !== "completed" && task.summary ? (
          <span className="block break-words text-[11px] text-muted-foreground/60">
            {task.summary}
          </span>
        ) : null}
      </span>
    </li>
  );
}

export const BackgroundTasksPanel = memo(function BackgroundTasksPanel({
  tasks,
  status,
  onRetry,
}: {
  tasks: ReadonlyArray<OrchestrationBackgroundTask> | null;
  status: BackgroundTasksReadStatus;
  onRetry: () => void;
}) {
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const state = backgroundTasksPanelState(tasks, status);

  if (state.kind === "unavailable") {
    return (
      <PanelMessage
        title="Background tasks unavailable"
        detail={
          state.canRetry
            ? "This thread's background tasks could not be loaded."
            : "This server is too old to list background tasks."
        }
        onRetry={state.canRetry ? onRetry : undefined}
      />
    );
  }
  if (state.kind === "loading") {
    return <PanelMessage title="Loading background tasks…" />;
  }
  if (state.kind === "empty" || tasks === null) {
    return (
      <PanelMessage
        title="No background tasks"
        detail="Nothing has run in the background here in the last 3 hours."
      />
    );
  }

  const running = tasks.filter((task) => task.status === "running").length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <ActivityIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Background</span>
        <span className="shrink-0 font-mono text-[.7rem] tabular-nums text-muted-foreground">
          {running} running
        </span>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 p-2">
          <ul className="flex flex-col gap-0.5">
            {tasks.map((task) => (
              <BackgroundTaskRow key={task.taskId} task={task} nowMs={nowMs} />
            ))}
          </ul>
          <p className="px-2.5 pt-1 text-[.7rem] text-muted-foreground/70">
            Finished tasks are kept for 3 hours.
          </p>
          {state.failed ? (
            <div className="flex items-center gap-2 px-2.5 pt-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1">Couldn't refresh background tasks</span>
              <Button size="xs" variant="outline" onClick={onRetry}>
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});
