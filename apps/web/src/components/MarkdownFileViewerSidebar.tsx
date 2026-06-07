import { useEffect, useState } from "react";
import {
  FileTextIcon,
  LoaderIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelRightCloseIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { RightPanelSheet } from "./RightPanelSheet";
import ChatMarkdown from "./ChatMarkdown";
import { readEnvironmentApi } from "~/environmentApi";
import { RIGHT_PANEL_SHEET_EXPANDED_CLASS_NAME } from "../rightPanelLayout";
import { useMarkdownViewerStore, type MarkdownViewerRequest } from "../markdownViewerStore";

function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

function dirnameOf(path: string): string | undefined {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex > 0 ? path.slice(0, separatorIndex) : undefined;
}

interface LoadState {
  status: "loading" | "loaded" | "error";
  contents: string;
  resolvedPath: string | null;
  error: string | null;
}

const INITIAL_LOAD_STATE: LoadState = {
  status: "loading",
  contents: "",
  resolvedPath: null,
  error: null,
};

function MarkdownFileViewerContent({
  request,
  onClose,
  expanded,
  onToggleExpand,
}: {
  request: MarkdownViewerRequest;
  onClose: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const [state, setState] = useState<LoadState>(INITIAL_LOAD_STATE);

  useEffect(() => {
    let cancelled = false;
    setState(INITIAL_LOAD_STATE);

    const api = readEnvironmentApi(request.environmentId);
    if (!api) {
      setState({
        status: "error",
        contents: "",
        resolvedPath: null,
        error: "This environment is not connected.",
      });
      return;
    }

    void api.projects
      .readFile({ cwd: request.cwd ?? ".", path: request.path })
      .then((result) => {
        if (cancelled) return;
        setState({
          status: "loaded",
          contents: result.contents,
          resolvedPath: result.resolvedPath,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          contents: "",
          resolvedPath: null,
          error: error instanceof Error ? error.message : "Failed to read file.",
        });
      });

    return () => {
      cancelled = true;
    };
    // requestId changes whenever the user re-opens, forcing a fresh read.
  }, [request.environmentId, request.cwd, request.path, request.requestId]);

  const markdownCwd = state.resolvedPath ? dirnameOf(state.resolvedPath) : request.cwd;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-card/50">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant="secondary"
            className="shrink-0 rounded-md bg-blue-500/10 px-1.5 py-0 text-[10px] font-semibold tracking-wide text-blue-400 uppercase"
          >
            Markdown
          </Badge>
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground/80">
            <FileTextIcon className="size-3.5 shrink-0" />
            <span className="truncate" title={state.resolvedPath ?? request.path}>
              {basenameOf(request.path)}
            </span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onToggleExpand}
            aria-label={expanded ? "Collapse markdown viewer" : "Expand markdown viewer to full width"}
            aria-pressed={expanded}
            className="text-muted-foreground/50 hover:text-foreground/70"
          >
            {expanded ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label="Close markdown viewer"
            className="text-muted-foreground/50 hover:text-foreground/70"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {state.status === "loading" ? (
            <div className="flex items-center gap-2 py-12 text-[13px] text-muted-foreground/50">
              <LoaderIcon className="size-3.5 animate-spin" />
              Loading…
            </div>
          ) : null}
          {state.status === "error" ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <TriangleAlertIcon className="size-5 text-amber-500/70" />
              <p className="text-[13px] text-muted-foreground/70">Could not open file</p>
              <p className="max-w-full text-[11px] break-words text-muted-foreground/40">
                {state.error}
              </p>
            </div>
          ) : null}
          {state.status === "loaded" ? (
            state.contents.trim().length > 0 ? (
              <ChatMarkdown text={state.contents} cwd={markdownCwd} isStreaming={false} />
            ) : (
              <p className="py-12 text-center text-[13px] text-muted-foreground/40">
                This file is empty.
              </p>
            )
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * Global, single-instance markdown file viewer rendered as a right-side sheet.
 * Opened from inline-code path affordances via {@link useMarkdownViewerStore}.
 */
export function MarkdownFileViewerSidebar() {
  const open = useMarkdownViewerStore((state) => state.open);
  const request = useMarkdownViewerStore((state) => state.request);
  const closeMarkdownViewer = useMarkdownViewerStore((state) => state.closeMarkdownViewer);
  const [expanded, setExpanded] = useState(false);

  const handleClose = () => {
    setExpanded(false);
    closeMarkdownViewer();
  };

  return (
    <RightPanelSheet
      open={open && request != null}
      onClose={handleClose}
      className={expanded ? RIGHT_PANEL_SHEET_EXPANDED_CLASS_NAME : undefined}
    >
      {request ? (
        <MarkdownFileViewerContent
          request={request}
          onClose={handleClose}
          expanded={expanded}
          onToggleExpand={() => setExpanded((value) => !value)}
        />
      ) : null}
    </RightPanelSheet>
  );
}

export default MarkdownFileViewerSidebar;
