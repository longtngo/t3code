import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import type { WorkLogEntry } from "../../session-logic";
import { useTheme } from "../../hooks/useTheme";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { cn } from "~/lib/utils";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { formatWorkEntryDetail, type WorkEntryQuestion } from "./workEntryDetail.logic";

const TONE_LABEL: Record<WorkLogEntry["tone"], string> = {
  thinking: "Thinking",
  tool: "Tool call",
  info: "Info",
  error: "Error",
};

const TONE_CLASS: Record<WorkLogEntry["tone"], string> = {
  thinking: "text-violet-300 border-violet-400/30 bg-violet-400/10",
  tool: "text-primary border-primary/30 bg-primary/10",
  info: "text-sky-300 border-sky-400/30 bg-sky-400/10",
  error: "text-destructive border-destructive/30 bg-destructive/10",
};

const SECTION_LABEL_CLASS =
  "mb-1.5 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground";
const CODE_BLOCK_CLASS =
  "overflow-auto rounded-lg border bg-background p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words";

/** Questions + the answer the user picked, rendered from an AskUserQuestion tool call. */
export function QuestionsDetail({ questions }: { questions: ReadonlyArray<WorkEntryQuestion> }) {
  return (
    <div className="space-y-4">
      {questions.map((question) => (
        <div key={question.question} className="space-y-2">
          {question.header ? (
            <span className="inline-block rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-primary">
              {question.header}
            </span>
          ) : null}
          <p className="text-sm font-medium">{question.question}</p>
          {question.options.length > 0 ? (
            <ul className="space-y-1">
              {question.options.map((option) => {
                const selected = question.answer !== null && option.label === question.answer;
                return (
                  <li
                    key={option.label}
                    className={cn(
                      "rounded border px-2 py-1 text-xs",
                      selected
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border/60 text-muted-foreground",
                    )}
                  >
                    <span className="font-medium">{option.label}</span>
                    {selected ? <span className="ml-1.5 text-[10px] text-primary">✓ chosen</span> : null}
                    {option.description ? (
                      <span className="mt-0.5 block text-[11px] opacity-80">
                        {option.description}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <div>
            <p className={SECTION_LABEL_CLASS}>Answer</p>
            {question.answer !== null ? (
              <p className="text-sm whitespace-pre-wrap break-words">{question.answer}</p>
            ) : (
              <p className="text-sm text-muted-foreground">No recorded answer.</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Command + its output, rendered from a Bash tool call. */
export function CommandDetail({
  command,
  output,
  isError,
}: {
  command: string;
  output: string | null;
  isError: boolean;
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className={SECTION_LABEL_CLASS}>Command</p>
        <pre className={cn(CODE_BLOCK_CLASS, "max-h-[30vh]")}>{command}</pre>
      </div>
      <div>
        <p className={SECTION_LABEL_CLASS}>
          Output
          {isError ? (
            <span className="rounded border border-destructive/30 px-1.5 text-[9px] tracking-wide text-destructive">
              Error
            </span>
          ) : null}
        </p>
        {output === null ? (
          <p className="text-sm text-muted-foreground">No output.</p>
        ) : output.length === 0 ? (
          <p className="text-sm text-muted-foreground">(empty output)</p>
        ) : (
          <pre className={cn(CODE_BLOCK_CLASS, "max-h-[45vh]", isError ? "border-destructive/40" : "")}>
            {output}
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * The change from an Edit tool call, rendered as a diff with the app's git-diff component
 * (`FileDiff`). Rendered poolless — no `DiffWorkerPoolProvider` — matching how review-comment diffs
 * render elsewhere in the timeline; falls back to the raw patch text if it can't be parsed.
 */
function EditDetail({ patch }: { patch: string }) {
  const { resolvedTheme } = useTheme();
  const renderable = useMemo(
    () => getRenderablePatch(patch, `worklog-edit:${resolvedTheme}`),
    [patch, resolvedTheme],
  );

  if (!renderable) {
    return <p className="text-sm text-muted-foreground">No changes to display.</p>;
  }
  if (renderable.kind === "raw") {
    return <pre className={cn(CODE_BLOCK_CLASS, "max-h-[50vh]")}>{renderable.text}</pre>;
  }
  return (
    <div className="overflow-hidden rounded-lg border">
      {renderable.files.map((fileDiff) => (
        <FileDiff
          key={resolveFileDiffPath(fileDiff)}
          fileDiff={fileDiff}
          options={{
            collapsed: false,
            diffStyle: "unified",
            theme: resolveDiffThemeName(resolvedTheme),
          }}
        />
      ))}
    </div>
  );
}

/**
 * Detail modal for a single work-log entry. AskUserQuestion / Bash / Edit tool calls get a
 * purpose-built body (questions + answers, command + output, a diff); every other entry shows its
 * heading, tone, changed files, and full content — pretty-printed JSON when structured, else text.
 */
export function WorkEntryDetailDialog({
  entry,
  onOpenChange,
}: {
  entry: WorkLogEntry | null;
  onOpenChange: (open: boolean) => void;
}) {
  const body = useMemo(
    () => (entry ? formatWorkEntryDetail(entry) : { kind: "empty" as const }),
    [entry],
  );
  const heading = entry?.toolTitle ?? entry?.label ?? "";
  // The command body renders the command itself; the edit body's diff shows its file path — so skip
  // the redundant description line / changed-files list for those.
  const showCommandDescription = Boolean(entry?.command) && body.kind !== "command";
  const showChangedFiles =
    entry != null && entry.changedFiles != null && entry.changedFiles.length > 0 && body.kind !== "edit";

  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="min-w-0 truncate">{heading || "Work log entry"}</span>
            {entry ? (
              <span
                className={cn(
                  "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                  TONE_CLASS[entry.tone],
                )}
              >
                {TONE_LABEL[entry.tone]}
              </span>
            ) : null}
          </DialogTitle>
          {showCommandDescription ? (
            <DialogDescription className="font-mono text-xs break-all">
              {entry?.rawCommand ?? entry?.command}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {showChangedFiles ? (
            <div>
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Changed files
              </p>
              <ul className="space-y-0.5">
                {entry?.changedFiles?.map((file) => (
                  <li key={file} className="font-mono text-xs text-muted-foreground break-all">
                    {file}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {body.kind === "questions" ? (
            <QuestionsDetail questions={body.questions} />
          ) : body.kind === "command" ? (
            <CommandDetail command={body.command} output={body.output} isError={body.isError} />
          ) : body.kind === "edit" ? (
            <EditDetail patch={body.patch} />
          ) : (
            <div>
              <p className={SECTION_LABEL_CLASS}>
                {body.kind === "json" ? "Payload" : "Detail"}
                {body.kind === "json" ? (
                  <span className="rounded border border-primary/30 px-1.5 text-[9px] tracking-wide text-primary">
                    JSON
                  </span>
                ) : null}
              </p>
              {body.kind === "empty" ? (
                <p className="text-sm text-muted-foreground">No further detail for this entry.</p>
              ) : (
                <pre
                  className={cn(
                    "max-h-[50vh] overflow-auto rounded-lg border bg-background p-3 font-mono text-xs leading-relaxed",
                    body.kind === "text" ? "whitespace-pre-wrap break-words" : "",
                  )}
                >
                  {body.kind === "json" ? body.json : body.text}
                </pre>
              )}
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
