import { FileTextIcon, PanelRightCloseIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { cn } from "~/lib/utils";
import { sidebarStatusIcon } from "./SidebarSection";
import type { SidebarItem } from "../sidebarSections";
import { useFileViewerStore } from "../fileViewerStore";

// Strip ANSI escape sequences (CSI colors/cursor, OSC titles, and two-char Fe
// escapes) so a terminal buffer reads as plain text. ESC/BEL are built via char
// code so the source carries no control-character literal, and plain bracketed
// text like "arr[0]" is left untouched (sequences require a leading ESC).
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(
  [
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, // OSC … (BEL | ST)
    `${ESC}\\[[0-?]*[ -/]*[@-~]`, // CSI
    `${ESC}[@-Z\\\\-_]`, // two-char Fe escapes
  ].join("|"),
  "g",
);
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function statusLabel(status: SidebarItem["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return "Pending";
  }
}

export function SidebarDetailPanel({
  item,
  environmentId,
  markdownCwd,
  mode = "sidebar",
  onClose,
}: {
  item: SidebarItem | null;
  environmentId: EnvironmentId;
  markdownCwd: string | undefined;
  mode?: "sheet" | "sidebar";
  onClose: () => void;
}) {
  const openFileViewer = useFileViewerStore((state) => state.openFileViewer);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar" ? "h-full w-[360px] shrink-0 border-l border-border/70" : "h-full w-full",
      )}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          {item ? sidebarStatusIcon(item.status) : null}
          <span className="truncate text-[13px] font-medium text-foreground/90">
            {item?.label ?? "Detail"}
          </span>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={onClose}
          aria-label="Close detail panel"
          className="text-muted-foreground/50 hover:text-foreground/70"
        >
          <PanelRightCloseIcon className="size-3.5" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {item === null ? (
            <p className="py-8 text-center text-[13px] text-muted-foreground/40">
              This item is no longer available.
            </p>
          ) : item.kind === "agent" ? (
            <>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60">
                <span>{statusLabel(item.status)}</span>
              </div>
              {item.finalSummary ? (
                <p className="text-[13px] leading-relaxed text-foreground/80">{item.finalSummary}</p>
              ) : null}
              {item.outputFile ? (
                <button
                  type="button"
                  onClick={() =>
                    openFileViewer({
                      path: item.outputFile!,
                      cwd: markdownCwd,
                      environmentId,
                      kind: "markdown",
                    })
                  }
                  className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-[12px] text-foreground/80 hover:bg-accent/60"
                >
                  <FileTextIcon className="size-3.5" />
                  <span className="truncate">{item.outputFile}</span>
                </button>
              ) : null}
              <div className="space-y-1">
                <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
                  Log
                </p>
                {item.log.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground/40">No progress reported.</p>
                ) : (
                  item.log.map((entry) => (
                    <div key={entry.id} className="rounded-md bg-muted/20 px-2.5 py-1.5">
                      {entry.lastToolName ? (
                        <span className="mr-1.5 rounded bg-muted/50 px-1 text-[10px] text-muted-foreground/70">
                          {entry.lastToolName}
                        </span>
                      ) : null}
                      <span className="text-[12px] text-foreground/75">{entry.text}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <>
              <div className="space-y-0.5 text-[11px] text-muted-foreground/60">
                <div>{statusLabel(item.status)}</div>
                {item.cwd ? <div className="truncate">cwd: {item.cwd}</div> : null}
                {item.exitCode !== null ? <div>exit code: {item.exitCode}</div> : null}
              </div>
              <div className="space-y-1">
                <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
                  Output
                </p>
                {item.buffer.trim().length === 0 ? (
                  <p className="text-[12px] text-muted-foreground/40">No output captured.</p>
                ) : (
                  <pre className="max-h-none overflow-x-auto rounded-md bg-background/60 p-2.5 text-[11px] leading-relaxed text-foreground/75">
                    {stripAnsi(item.buffer)}
                  </pre>
                )}
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
