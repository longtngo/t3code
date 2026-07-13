import type { WorkLogEntry } from "../../session-logic";
import { cn } from "~/lib/utils";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { formatWorkEntryDetail } from "./workEntryDetail.logic";

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

/**
 * Detail modal for a single work-log entry. Shows the entry's heading, tone, any changed files,
 * and its full content — pretty-printed JSON when the entry carries a structured payload,
 * otherwise plain text.
 */
export function WorkEntryDetailDialog({
  entry,
  onOpenChange,
}: {
  entry: WorkLogEntry | null;
  onOpenChange: (open: boolean) => void;
}) {
  const body = entry ? formatWorkEntryDetail(entry) : { kind: "empty" as const };
  const heading = entry?.toolTitle ?? entry?.label ?? "";

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
          {entry?.command ? (
            <DialogDescription className="font-mono text-xs break-all">
              {entry.rawCommand ?? entry.command}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {entry && entry.changedFiles && entry.changedFiles.length > 0 ? (
            <div>
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Changed files
              </p>
              <ul className="space-y-0.5">
                {entry.changedFiles.map((file) => (
                  <li key={file} className="font-mono text-xs text-muted-foreground break-all">
                    {file}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <p className="mb-1.5 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
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
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
