import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
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
import { toastManager } from "./ui/toast";
import { RIGHT_PANEL_SHEET_EXPANDED_CLASS_NAME } from "../rightPanelLayout";
import {
  useFileViewerStore,
  type FileViewerKind,
  type FileViewerRequest,
} from "../fileViewerStore";

function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

function dirnameOf(path: string): string | undefined {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex > 0 ? path.slice(0, separatorIndex) : undefined;
}

/** Infer how to render a path from its extension (used for intra-report links). */
export function inferFileViewerKind(path: string): FileViewerKind | null {
  const lower = (path.split(/[?#]/)[0] ?? path).toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  return null;
}

const EMPTY_HTML_PLACEHOLDER =
  "<!doctype html><body style='margin:0;font:13px system-ui,sans-serif;color:#888;padding:2rem'>This file is empty.</body>";

/**
 * Script prepended to untrusted report HTML before it is rendered in the
 * sandboxed iframe. It captures clicks on relative links to other openable
 * files and hands the href up to the parent panel via postMessage, since the
 * iframe's opaque origin can't resolve them itself (and the files live on the
 * server in remote sessions). Other links keep their default behaviour.
 */
const LINK_INTERCEPTOR_SCRIPT =
  "<script>(function(){document.addEventListener('click',function(e){" +
  "var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;" +
  "var href=a.getAttribute('href');if(!href)return;" +
  "if(/^[a-z][a-z0-9+.-]*:/i.test(href))return;" + // scheme (http:, mailto:, data:…)
  "if(href.charAt(0)==='#')return;" + // in-page anchor
  "if(!/\\.(html?|markdown|md)([?#]|$)/i.test(href))return;" + // only viewer-openable
  "e.preventDefault();parent.postMessage({__t3FileViewerNav:true,href:href},'*');" +
  "},true);})();</scr" +
  "ipt>";

interface NavMessage {
  __t3FileViewerNav: true;
  href: string;
}

function isNavMessage(data: unknown): data is NavMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { __t3FileViewerNav?: unknown }).__t3FileViewerNav === true &&
    typeof (data as { href?: unknown }).href === "string"
  );
}

/** One entry in the in-sidebar navigation history. */
interface ViewerEntry {
  path: string;
  cwd: string | undefined;
  kind: FileViewerKind;
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

const KIND_BADGE: Record<FileViewerKind, { label: string; className: string }> = {
  markdown: {
    label: "Markdown",
    className: "bg-blue-500/10 text-blue-400",
  },
  html: {
    label: "HTML",
    className: "bg-orange-500/10 text-orange-400",
  },
};

function FileViewerContent({
  request,
  onClose,
  expanded,
  onToggleExpand,
}: {
  request: FileViewerRequest;
  onClose: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  // Navigation history within the sidebar; seeded from the opening request and
  // grown when a link inside an HTML report is followed. Remounts per open
  // (parent keys on requestId), so this initializer is the single seed.
  const [history, setHistory] = useState<ViewerEntry[]>(() => [
    { path: request.path, cwd: request.cwd, kind: request.kind },
  ]);
  const [state, setState] = useState<LoadState>(INITIAL_LOAD_STATE);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Directory of the currently-loaded file, used to resolve the next relative
  // link. Kept in a ref so the (subscribe-once) message listener reads it fresh.
  const navBaseCwdRef = useRef<string | undefined>(request.cwd);

  const current: ViewerEntry = history[history.length - 1] ?? {
    path: request.path,
    cwd: request.cwd,
    kind: request.kind,
  };
  const canGoBack = history.length > 1;

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
      .readFile({ cwd: current.cwd ?? ".", path: current.path })
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
  }, [request.environmentId, current.path, current.cwd]);

  useEffect(() => {
    navBaseCwdRef.current = state.resolvedPath ? dirnameOf(state.resolvedPath) : current.cwd;
  }, [state.resolvedPath, current.cwd]);

  // Follow a relative link clicked inside the HTML iframe: resolve it against
  // the current file's directory (the server expands `..`) and push a new
  // history entry. Subscribed once; reads fresh values via refs / updaters.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Opaque-origin srcdoc frames report origin "null", so identify the
      // sender by window reference rather than origin.
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
      if (!isNavMessage(event.data)) return;
      const cleanHref = event.data.href.split(/[?#]/)[0] ?? event.data.href;
      const kind = inferFileViewerKind(cleanHref);
      if (!kind) return;
      setHistory((entries) => [...entries, { path: cleanHref, cwd: navBaseCwdRef.current, kind }]);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const handleBack = useCallback(() => {
    setHistory((entries) => (entries.length > 1 ? entries.slice(0, -1) : entries));
  }, []);

  // Open the currently-loaded HTML in a new browser tab — the "full view"
  // escape hatch. Reuses the loaded contents; runs in the user-gesture context
  // so window.open isn't blocked.
  const handlePopOut = useCallback(() => {
    const win = window.open("", "_blank");
    if (!win) {
      toastManager.add({
        type: "error",
        title: "Pop-up blocked",
        description: "Allow pop-ups for this site to open the file in a new tab.",
      });
      return;
    }
    win.opener = null;
    win.document.write(
      '<!doctype html><html><head><meta charset="utf-8"><title>' +
        basenameOf(current.path) +
        "</title>" +
        "<style>html,body{margin:0;height:100%}iframe{border:0;display:block;width:100%;height:100%}</style>" +
        "</head><body></body></html>",
    );
    win.document.close();
    // oxlint-disable-next-line iframe-missing-sandbox -- sandbox set below via setAttribute
    const iframe = win.document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts allow-popups");
    iframe.srcdoc = state.contents.trim().length > 0 ? state.contents : EMPTY_HTML_PLACEHOLDER;
    win.document.title = current.path;
    win.document.body.appendChild(iframe);
  }, [current.path, state.contents]);

  const badge = KIND_BADGE[current.kind];
  const markdownCwd = state.resolvedPath ? dirnameOf(state.resolvedPath) : current.cwd;
  const isEmpty = state.status === "loaded" && state.contents.trim().length === 0;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-card/50">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          {canGoBack ? (
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={handleBack}
              aria-label="Back"
              className="shrink-0 text-muted-foreground/50 hover:text-foreground/70"
            >
              <ArrowLeftIcon className="size-3.5" />
            </Button>
          ) : null}
          <Badge
            variant="secondary"
            className={`shrink-0 rounded-md px-1.5 py-0 text-[10px] font-semibold tracking-wide uppercase ${badge.className}`}
          >
            {badge.label}
          </Badge>
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground/80">
            <FileTextIcon className="size-3.5 shrink-0" />
            <span className="truncate" title={state.resolvedPath ?? current.path}>
              {basenameOf(current.path)}
            </span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {current.kind === "html" && state.status === "loaded" ? (
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={handlePopOut}
              aria-label="Open in new tab"
              className="text-muted-foreground/50 hover:text-foreground/70"
            >
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onToggleExpand}
            aria-label={expanded ? "Collapse file viewer" : "Expand file viewer to full width"}
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
            aria-label="Close file viewer"
            className="text-muted-foreground/50 hover:text-foreground/70"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {canGoBack ? (
        <div className="flex shrink-0 items-center gap-1 overflow-hidden border-b border-border/60 px-3 py-1 font-mono text-[10px] text-muted-foreground/60">
          {history.map((entry, index) => (
            <span
              key={history
                .slice(0, index + 1)
                .map((e) => e.path)
                .join(">")}
              className="flex min-w-0 items-center gap-1"
            >
              {index > 0 ? <span className="opacity-40">/</span> : null}
              <span
                className={`truncate ${index === history.length - 1 ? "text-foreground/80" : ""}`}
              >
                {basenameOf(entry.path)}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {state.status === "loading" ? (
          <div className="flex items-center gap-2 p-4 py-12 text-[13px] text-muted-foreground/50">
            <LoaderIcon className="size-3.5 animate-spin" />
            Loading…
          </div>
        ) : null}
        {state.status === "error" ? (
          <div className="flex flex-col items-center justify-center gap-2 p-4 py-12 text-center">
            <TriangleAlertIcon className="size-5 text-amber-500/70" />
            <p className="text-[13px] text-muted-foreground/70">Could not open file</p>
            <p className="max-w-full text-[11px] break-words text-muted-foreground/40">
              {state.error}
            </p>
          </div>
        ) : null}
        {state.status === "loaded" && isEmpty ? (
          <p className="p-4 py-12 text-center text-[13px] text-muted-foreground/40">
            This file is empty.
          </p>
        ) : null}
        {state.status === "loaded" && !isEmpty && current.kind === "html" ? (
          // Render untrusted report HTML in a sandboxed iframe: scripts may run
          // (charts etc.) but `allow-same-origin` is withheld, so the document
          // gets an opaque origin and cannot reach this app's session/storage.
          <iframe
            ref={iframeRef}
            title={basenameOf(current.path)}
            sandbox="allow-scripts allow-popups"
            srcDoc={LINK_INTERCEPTOR_SCRIPT + state.contents}
            className="h-full w-full border-0 bg-white"
          />
        ) : null}
        {state.status === "loaded" && !isEmpty && current.kind === "markdown" ? (
          <ScrollArea className="h-full">
            <div className="p-4">
              <ChatMarkdown text={state.contents} cwd={markdownCwd} isStreaming={false} />
            </div>
          </ScrollArea>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Global, single-instance file viewer rendered as a right-side sheet. Opened
 * from inline-code path affordances via {@link useFileViewerStore}; renders
 * markdown inline and HTML reports in a sandboxed iframe with intra-report
 * link navigation.
 */
export function FileViewerSidebar() {
  const open = useFileViewerStore((state) => state.open);
  const request = useFileViewerStore((state) => state.request);
  const closeFileViewer = useFileViewerStore((state) => state.closeFileViewer);
  const [expanded, setExpanded] = useState(false);

  const handleClose = () => {
    setExpanded(false);
    closeFileViewer();
  };

  return (
    <RightPanelSheet
      open={open && request != null}
      onClose={handleClose}
      className={expanded ? RIGHT_PANEL_SHEET_EXPANDED_CLASS_NAME : undefined}
    >
      {request ? (
        <FileViewerContent
          key={request.requestId}
          request={request}
          onClose={handleClose}
          expanded={expanded}
          onToggleExpand={() => setExpanded((value) => !value)}
        />
      ) : null}
    </RightPanelSheet>
  );
}

export default FileViewerSidebar;
