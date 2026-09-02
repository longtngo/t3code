import { useCallback, useMemo, useState } from "react";

import type { CrewReport, CrewRendering, CrewTaskView } from "@t3tools/contracts";

import { useCrew } from "../hooks/useCrew";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { usePrimaryEnvironmentId } from "../state/environments";

/**
 * The Crew section, shared by both sidebars.
 *
 * Scoped to the environment rather than to a bridge thread, so a task whose
 * bridge was deleted is still visible and still tearable-down.
 *
 * Three things copied from the `useResourceQueue` precedent and one deliberately
 * not. Copied: the section mounts whether or not it is expanded, because putting
 * the poll inside the collapsed body means no cadence, no count and no header;
 * the latched list resets to null on an environment switch, or the panel shows
 * the previous environment's rows; and polling stops entirely while the tab is
 * hidden, so "no staler than the sweep" holds for a foreground tab and self-heals
 * on focus. Not copied: that precedent discards the query error because it
 * degrades in-band. `crew.list` has no such field, so a failing call needs an
 * explicit error state or the panel freezes with no explanation.
 */

const RENDERING_LABEL: Record<CrewRendering, string> = {
  closed: "Closed",
  "blocked-on-human": "Needs you",
  errored: "Error",
  interrupted: "Interrupted",
  working: "Working",
  "idle-no-report": "Idle",
  starting: "Starting",
  unknown: "Unknown",
};

const RENDERING_TONE: Record<CrewRendering, string> = {
  closed: "text-muted-foreground",
  "blocked-on-human": "text-amber-600 dark:text-amber-400",
  errored: "text-red-600 dark:text-red-400",
  interrupted: "text-red-600 dark:text-red-400",
  working: "text-blue-600 dark:text-blue-400",
  "idle-no-report": "text-muted-foreground",
  starting: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

/** Longest crewmate text the panel will render before clamping. */
const NOTE_CLAMP = 240;

/**
 * Crewmate text renders plain — no markdown, links or images.
 *
 * Not because of `dangerouslySetInnerHTML`: `ChatMarkdown` pairs `rehypeRaw` with
 * `rehypeSanitize`. It is that the sanitize schema extends `protocols` with
 * `"file"` for `href` and `src`, so a crewmate could render a link into the
 * operator's filesystem.
 */
export function plainNote(note: string): string {
  const collapsed = note.replace(/\s+/g, " ").trim();
  return collapsed.length > NOTE_CLAMP ? `${collapsed.slice(0, NOTE_CLAMP)}…` : collapsed;
}

export function unreadCount(task: CrewTaskView): number {
  return task.reports.filter((report) => report.notedAt === null).length;
}

/**
 * The report an `Answer` action would reply to: the oldest `needs-decision` with
 * no answer naming it.
 */
export function unansweredDecision(task: CrewTaskView): CrewReport | undefined {
  const answered = new Set(
    task.reports.flatMap((report) => (report.replyTo === null ? [] : [report.replyTo])),
  );
  return task.reports.find(
    (report) => report.state === "needs-decision" && !answered.has(report.reportId),
  );
}

export interface CrewActionAvailability {
  readonly answer: boolean;
  readonly teardown: boolean;
  readonly forgetWorktree: boolean;
  readonly rerunTeardown: boolean;
  readonly openThread: boolean;
}

/**
 * Which actions a row offers.
 *
 * `Forget worktree` is closed-only: on an `open` task, clearing the field
 * disables `ensureThreadWorktree`'s recreate while the session keeps resuming
 * into a cwd that is gone — every later turn then fails as "session not found",
 * the slot stays held, and no rendering explains why.
 *
 * `Re-run teardown` exists because `Teardown` is open-only, and without it the
 * zombie budget is the only thing that can stop a live `bypassPermissions` agent
 * whose first teardown left it running.
 *
 * There is no `Delete worktree`. Crew deletes nothing; reclaiming disk is
 * teardown and then `git worktree remove --force`, by hand, by someone who can
 * see the tree.
 */
export function crewActions(task: CrewTaskView): CrewActionAvailability {
  const open = task.status === "open";
  const closed = task.status === "closed";
  const stillRunning =
    task.rendering === "working" ||
    task.rendering === "starting" ||
    task.rendering === "blocked-on-human";
  return {
    answer: open && unansweredDecision(task) !== undefined,
    teardown: open,
    forgetWorktree: closed,
    rerunTeardown: closed && stillRunning,
    openThread: true,
  };
}

export interface CrewPanelProps {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly onTeardown: (taskId: string) => void;
  readonly onAnswer: (reportId: string, text: string) => void;
  readonly onForgetWorktree: (taskId: string) => void;
}

export function CrewPanel({
  expanded,
  onToggle,
  onOpenThread,
  onTeardown,
  onAnswer,
  onForgetWorktree,
}: CrewPanelProps) {
  const environmentId = usePrimaryEnvironmentId();
  const { tasks } = useCrew(environmentId, expanded);
  const [answerFor, setAnswerFor] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState("");

  const openTasks = useMemo(() => (tasks ?? []).filter((task) => task.status === "open"), [tasks]);

  const submitAnswer = useCallback(
    (reportId: string) => {
      const text = answerText.trim();
      if (text.length === 0) return;
      onAnswer(reportId, text);
      setAnswerFor(null);
      setAnswerText("");
    },
    [answerText, onAnswer],
  );

  // The section vanishes entirely when there is no crew, matching the snoozed
  // shelf beside it. It renders whenever the environment has ever had one.
  if (tasks !== null && tasks.length === 0) {
    return null;
  }

  return (
    <li data-thread-selection-safe className="list-none" data-testid="sidebar-crew-section">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid="sidebar-crew-toggle"
        className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
      >
        <span className="text-xs font-medium text-muted-foreground">
          {expanded ? "Crew" : `Crew (${openTasks.length})`}
        </span>
        <span className="h-px flex-1 bg-border/60" />
      </button>

      {expanded ? (
        tasks === null ? (
          <p className="px-2.5 py-1 text-xs text-muted-foreground">Loading crew…</p>
        ) : (
          <ul className="list-none">
            {tasks.map((task) => {
              const actions = crewActions(task);
              const decision = unansweredDecision(task);
              const unread = unreadCount(task);
              const last = task.reports.findLast?.((report) => report.state !== "answer");
              return (
                <li
                  key={task.taskId}
                  data-testid={`crew-row-${task.taskId}`}
                  className="px-2.5 py-1.5"
                >
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium ${RENDERING_TONE[task.rendering]}`}>
                      {RENDERING_LABEL[task.rendering]}
                    </span>
                    {unread > 0 ? (
                      <span
                        data-testid={`crew-unread-${task.taskId}`}
                        className="text-[11px] text-muted-foreground"
                      >
                        {unread} unread
                      </span>
                    ) : null}
                  </div>

                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <p className="truncate text-left text-[11px] text-muted-foreground">
                          {task.branch}
                        </p>
                      }
                    />
                    <TooltipPopup>{task.branch}</TooltipPopup>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <p className="truncate text-left text-[11px] text-muted-foreground">
                          {task.worktreePath}
                        </p>
                      }
                    />
                    <TooltipPopup>{task.worktreePath}</TooltipPopup>
                  </Tooltip>

                  {last !== undefined && last !== null ? (
                    <p className="mt-1 text-[11px] text-foreground/80">
                      {last.state}: {plainNote(last.note)}
                    </p>
                  ) : null}

                  <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
                    <button
                      type="button"
                      onClick={() => onOpenThread(task.crewThreadId)}
                      data-testid={`crew-open-${task.taskId}`}
                      className="cursor-pointer text-blue-600 dark:text-blue-400"
                    >
                      Open thread
                    </button>
                    {actions.answer && decision !== undefined ? (
                      <button
                        type="button"
                        onClick={() => setAnswerFor(decision.reportId)}
                        data-testid={`crew-answer-${task.taskId}`}
                        className="cursor-pointer text-amber-600 dark:text-amber-400"
                      >
                        Answer
                      </button>
                    ) : null}
                    {actions.teardown ? (
                      <button
                        type="button"
                        onClick={() => onTeardown(task.taskId)}
                        data-testid={`crew-teardown-${task.taskId}`}
                        className="cursor-pointer text-muted-foreground"
                      >
                        Teardown
                      </button>
                    ) : null}
                    {actions.rerunTeardown ? (
                      <button
                        type="button"
                        onClick={() => onTeardown(task.taskId)}
                        data-testid={`crew-rerun-teardown-${task.taskId}`}
                        className="cursor-pointer text-muted-foreground"
                      >
                        Re-run teardown
                      </button>
                    ) : null}
                    {actions.forgetWorktree ? (
                      <button
                        type="button"
                        onClick={() => onForgetWorktree(task.taskId)}
                        data-testid={`crew-forget-${task.taskId}`}
                        className="cursor-pointer text-muted-foreground"
                      >
                        Forget worktree
                      </button>
                    ) : null}
                  </div>

                  {answerFor !== null && decision?.reportId === answerFor ? (
                    <div className="mt-1 flex gap-1">
                      <input
                        value={answerText}
                        onChange={(event) => setAnswerText(event.target.value)}
                        data-testid={`crew-answer-input-${task.taskId}`}
                        className="min-w-0 flex-1 rounded border border-border bg-background px-1 text-[11px]"
                        placeholder="Answer…"
                      />
                      <button
                        type="button"
                        onClick={() => submitAnswer(answerFor)}
                        data-testid={`crew-answer-send-${task.taskId}`}
                        className="cursor-pointer text-[11px] text-blue-600 dark:text-blue-400"
                      >
                        Send
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </li>
  );
}
