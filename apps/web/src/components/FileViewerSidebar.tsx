import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import ChatMarkdown from "./ChatMarkdown";
import { type EnvironmentId } from "@t3tools/contracts";
import { readEnvironmentApi } from "~/environmentApi";
import { getEnvironmentHttpBaseUrl } from "~/environments/runtime/catalog";
import { toastManager } from "./ui/toast";
import {
  type FileViewerKind,
  type FileViewerRequest,
  type FileViewerView,
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
 * sandboxed iframe. A `srcdoc` iframe has no document URL of its own, so the
 * browser resolves every relative href (including a bare `#anchor`) against the
 * *embedder's* URL — letting any such click fall through navigates the frame to
 * this app and blanks the report. So we intercept clicks and handle each case
 * ourselves: same-page anchors scroll in-document; links to other openable
 * files post up to the parent panel (the files live on the server in remote
 * sessions); any other relative link is blocked rather than left to blank out.
 * Absolute-scheme links (http:, mailto:, …) keep their default behaviour.
 */
const LINK_INTERCEPTOR_SCRIPT =
  "<script>(function(){document.addEventListener('click',function(e){" +
  "var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;" +
  "var href=a.getAttribute('href');if(!href)return;" +
  "if(href.charAt(0)==='#'){e.preventDefault();" + // same-page anchor → scroll manually
  "var id=decodeURIComponent(href.slice(1));" +
  "if(!id){window.scrollTo(0,0);return;}" +
  "var t=document.getElementById(id)||document.getElementsByName(id)[0];" +
  "if(t&&t.scrollIntoView)t.scrollIntoView();return;}" +
  "if(/^[a-z][a-z0-9+.-]*:/i.test(href))return;" + // scheme (http:, mailto:, data:…)
  "if(/\\.(html?|markdown|md)([?#]|$)/i.test(href)){" + // openable → open in the panel
  "e.preventDefault();parent.postMessage({__t3FileViewerNav:true,href:href},'*');return;}" +
  "e.preventDefault();" + // other relative link: can't resolve in srcdoc, so block it
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
  /** Active view for a markdown entry; ignored when `kind === "html"`. */
  view: FileViewerView;
}

/** True when the entry is displayed as HTML (raw `.html` or md rendered to HTML). */
function isHtmlView(entry: ViewerEntry): boolean {
  return entry.kind === "html" || entry.view === "html";
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Build the absolute `/viewer/<abs-path>` URL the "Open in new tab" action opens,
 * or null when the environment isn't reachable as a real page from a new tab.
 *
 * The new tab is only authenticated when it can reach the server with a session:
 * a same-origin tab (web) carries the session cookie, and a loopback server
 * trusts the request (the desktop app opens an external browser). Remote, non-
 * loopback servers would reject the cookieless tab, so we return null there and
 * the caller falls back to the in-memory srcdoc pop-out.
 */
function buildViewerUrl(environmentId: EnvironmentId, absolutePath: string | null): string | null {
  if (!absolutePath || !absolutePath.startsWith("/")) return null;
  const base = getEnvironmentHttpBaseUrl(environmentId) ?? window.location.origin;
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return null;
  }
  const reachable =
    LOOPBACK_HOSTNAMES.has(baseUrl.hostname) || baseUrl.origin === window.location.origin;
  if (!reachable) return null;
  const encodedPath = absolutePath.split("/").map(encodeURIComponent).join("/");
  return new URL(`/viewer${encodedPath}`, baseUrl).toString();
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

/**
 * Editable, URI-like path field for the preview header. Shows the full resolved
 * path (the obscurity layer is gone — reads are instead sandboxed server-side to
 * the home dir, OS temp dir, and known project roots), and lets the user retype
 * any path to retarget the preview. Enter commits,
 * Escape reverts, blur commits. Resyncs to `value` whenever the loaded path
 * changes and the field isn't being edited.
 */
function AddressBar({
  value,
  onSubmit,
}: {
  value: string;
  onSubmit: (path: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  // Set by Escape so the blur it triggers reverts instead of submitting. A ref
  // (not state) because it must be read synchronously inside the blur handler.
  const revertOnBlurRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  // The single commit point: both Enter and focus-loss route through blur, so
  // the path is submitted at most once per edit. Escape sets revertOnBlurRef so
  // its blur reverts the draft instead.
  const commit = useCallback(() => {
    setEditing(false);
    const next = draft.trim();
    if (revertOnBlurRef.current || !next || next === value) {
      revertOnBlurRef.current = false;
      setDraft(value);
      return;
    }
    onSubmit(next);
  }, [draft, value, onSubmit]);

  return (
    <input
      type="text"
      value={draft}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => {
        setEditing(true);
        event.target.select();
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          // Blur drives the commit; Enter just relinquishes focus.
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          revertOnBlurRef.current = true;
          event.currentTarget.blur();
        }
      }}
      title={value}
      aria-label="File path"
      className="min-w-0 flex-1 truncate rounded-md border border-border/60 bg-muted/50 px-2 py-1 font-mono text-[12px] text-muted-foreground/90 outline-none hover:bg-muted/70 focus:border-ring/45 focus:bg-muted/80 focus:text-foreground/90"
    />
  );
}

/** A single segment of the MD/HTML view toggle. */
function ViewModeButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase transition-colors ${
        active
          ? "bg-muted text-foreground/80"
          : "text-muted-foreground/50 hover:text-foreground/70"
      }`}
    >
      {label}
    </button>
  );
}

export function FileViewerContent({
  request,
  onClose,
  expanded,
  onToggleExpand,
}: {
  request: FileViewerRequest;
  onClose: () => void;
  /** Full-width expand state; omit (with onToggleExpand) to hide the toggle. */
  expanded?: boolean;
  /** When provided, renders the expand/collapse button (sheet layout only). */
  onToggleExpand?: () => void;
}) {
  // Navigation history within the sidebar; seeded from the opening request and
  // grown when a link inside an HTML report is followed. Remounts per open
  // (parent keys on requestId), so this initializer is the single seed.
  const [history, setHistory] = useState<ViewerEntry[]>(() => [
    { path: request.path, cwd: request.cwd, kind: request.kind, view: request.view },
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
    view: request.view,
  };
  const canGoBack = history.length > 1;
  // Set the active view for the current (last) history entry. Only meaningful
  // for markdown files; switching re-runs the load below.
  const setCurrentView = useCallback((view: FileViewerView) => {
    setHistory((entries) =>
      entries.map((entry, index) =>
        index === entries.length - 1 ? { ...entry, view } : entry,
      ),
    );
  }, []);

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

    const onLoaded = (contents: string, resolvedPath: string) => {
      if (cancelled) return;
      setState({ status: "loaded", contents, resolvedPath, error: null });
    };
    const onError = (error: unknown) => {
      if (cancelled) return;
      setState({
        status: "error",
        contents: "",
        resolvedPath: null,
        error: error instanceof Error ? error.message : "Failed to read file.",
      });
    };

    const cwd = current.cwd ?? ".";
    // A markdown file viewed as HTML is converted by the backend (cached there);
    // every other case reads the raw file (markdown source, or a `.html` report).
    if (current.kind === "markdown" && current.view === "html") {
      void api.projects
        .renderMarkdownHtml({ cwd, path: current.path })
        .then((result) => onLoaded(result.html, result.resolvedPath))
        .catch(onError);
    } else {
      void api.projects
        .readFile({ cwd, path: current.path })
        .then((result) => onLoaded(result.contents, result.resolvedPath))
        .catch(onError);
    }

    return () => {
      cancelled = true;
    };
  }, [request.environmentId, current.path, current.cwd, current.kind, current.view]);

  useEffect(() => {
    navBaseCwdRef.current = state.resolvedPath ? dirnameOf(state.resolvedPath) : current.cwd;
  }, [state.resolvedPath, current.cwd]);

  // Follow a relative link clicked inside the HTML iframe: resolve it against
  // the current file's directory (the server expands `..`) and push a new
  // history entry. Subscribed once; reads fresh values via refs / updaters.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Opaque-origin srcdoc frames report origin "null", so identify the
      // sender by window reference rather than origin. Reject when no iframe is
      // mounted (markdown view) so only the live HTML frame can drive nav.
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      if (!isNavMessage(event.data)) return;
      const cleanHref = event.data.href.split(/[?#]/)[0] ?? event.data.href;
      const kind = inferFileViewerKind(cleanHref);
      if (!kind) return;
      setHistory((entries) => [
        ...entries,
        { path: cleanHref, cwd: navBaseCwdRef.current, kind, view: "markdown" },
      ]);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const handleBack = useCallback(() => {
    setHistory((entries) => (entries.length > 1 ? entries.slice(0, -1) : entries));
  }, []);

  // Retarget the preview to a path typed into the address bar. Relative paths
  // resolve (server-side) against the current file's directory; absolute / `~`
  // paths pass straight through. Pushes a history entry so Back still works.
  const navigateTo = useCallback((raw: string) => {
    const trimmed = raw.trim().replace(/^file:\/\//, "");
    if (!trimmed) return;
    const kind = inferFileViewerKind(trimmed) ?? "markdown";
    setHistory((entries) => {
      // Skip a no-op self-navigation so the same file isn't pushed twice.
      const last = entries[entries.length - 1];
      if (last && last.path === trimmed) return entries;
      return [...entries, { path: trimmed, cwd: navBaseCwdRef.current, kind, view: "markdown" }];
    });
  }, []);

  // The real `/viewer/<abs-path>` URL for this file, when a new tab can reach it
  // (see buildViewerUrl). Null ⇒ fall back to the in-memory srcdoc pop-out.
  const viewerUrl = useMemo(
    () => buildViewerUrl(request.environmentId, state.resolvedPath),
    [request.environmentId, state.resolvedPath],
  );

  // Open the file in a new browser tab — the "full view" escape hatch. Prefers a
  // real, refreshable `/viewer` URL (the server renders markdown / serves html on
  // each load, so reloading picks up file edits); falls back to writing the
  // loaded contents into a sandboxed iframe when no reachable URL exists. Runs in
  // the user-gesture context so window.open isn't blocked.
  const handlePopOut = useCallback(() => {
    if (viewerUrl) {
      const opened = window.open(viewerUrl, "_blank");
      if (!opened) {
        toastManager.add({
          type: "error",
          title: "Pop-up blocked",
          description: "Allow pop-ups for this site to open the file in a new tab.",
        });
      }
      return;
    }
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
    // Title is set safely via the `document.title` property assignment below;
    // never interpolate the path into the written HTML (it can carry attacker
    // markup from an intra-report link href and this popup is same-origin).
    win.document.write(
      '<!doctype html><html><head><meta charset="utf-8"><title></title>' +
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
  }, [current.path, state.contents, viewerUrl]);

  const badge = KIND_BADGE[current.kind];
  const markdownCwd = state.resolvedPath ? dirnameOf(state.resolvedPath) : current.cwd;
  const isEmpty = state.status === "loaded" && state.contents.trim().length === 0;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-card/50">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
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
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] text-muted-foreground/80">
            <FileTextIcon className="size-3.5 shrink-0" />
            <AddressBar value={state.resolvedPath ?? current.path} onSubmit={navigateTo} />
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {current.kind === "markdown" ? (
            <div
              role="group"
              aria-label="View mode"
              className="mr-1 flex items-center rounded-md border border-border/60 p-0.5"
            >
              <ViewModeButton
                label="MD"
                active={current.view === "markdown"}
                onClick={() => setCurrentView("markdown")}
              />
              <ViewModeButton
                label="HTML"
                active={current.view === "html"}
                onClick={() => setCurrentView("html")}
              />
            </div>
          ) : null}
          {/* Pop-out needs renderable output: a real /viewer URL (server renders
              markdown) or already-HTML contents for the srcdoc fallback. In raw
              markdown view without a reachable URL there's nothing good to show. */}
          {state.status === "loaded" && (viewerUrl !== null || isHtmlView(current)) ? (
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
          {onToggleExpand ? (
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
          ) : null}
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
        {state.status === "loaded" && !isEmpty && isHtmlView(current) ? (
          // Render report HTML (a raw `.html` file, or markdown converted to a
          // standalone document by the backend) in a sandboxed iframe: scripts
          // may run (charts etc.) but `allow-same-origin` is withheld, so the
          // document gets an opaque origin and cannot reach this app's session.
          // The interceptor keeps in-report relative links navigating the panel.
          <iframe
            ref={iframeRef}
            title={basenameOf(current.path)}
            sandbox="allow-scripts allow-popups"
            srcDoc={LINK_INTERCEPTOR_SCRIPT + state.contents}
            className="h-full w-full border-0 bg-white"
          />
        ) : null}
        {state.status === "loaded" && !isEmpty && current.kind === "markdown" && current.view === "markdown" ? (
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

