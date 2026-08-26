/**
 * Read-only view of a file addressed by ABSOLUTE path, read through the trusted
 * read RPC (server-sandboxed to home / OS-temp / trusted roots).
 *
 * This is the renderer behind both the standalone `/viewer/$` route and the
 * right panel's trusted-file surface, so a report opened from a chat message
 * looks the same wherever it lands.
 *
 * Distinct from `FilePreviewPanel`, which is an *editor* for files inside the
 * workspace, keyed on `(environmentId, cwd, relativePath)`. Files outside the
 * workspace have no workspace-relative path and no write RPC, so they get this
 * read-only surface rather than a disabled editor.
 *
 * @module TrustedFileView
 */
import { LoaderCircle, RotateCcwIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { EnvironmentId } from "@t3tools/contracts";

import ChatMarkdown, { HighlightedCodeView } from "../ChatMarkdown";
import { classifyFileViewerKind } from "../../lib/codeFileTypes";
import { isMarkdownPreviewFile } from "./filePreviewMode";
import { useTrustedFileQuery, useTrustedMarkdownHtmlQuery } from "./projectFilesQueryState";
import { viewerHttpUrl } from "./viewerPath";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { cn } from "../../lib/utils";

/** Directory of an absolute posix path — the `cwd` for markdown relative links. */
export function directoryOfAbsolutePath(absolutePath: string): string {
  const lastSlash = absolutePath.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : absolutePath.slice(0, lastSlash);
}

export function TrustedFileNotice({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center gap-2 px-6 text-center text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

export interface TrustedFileViewProps {
  environmentId: EnvironmentId | null;
  absolutePath: string | null;
  className?: string;
}

/**
 * How this view renders a path.
 *
 * `.mdx` is deliberately routed through `isMarkdownPreviewFile` rather than the
 * shared classifier, which covers only `md|markdown` — dropping it would silently
 * demote `.mdx` from rendered markdown to source. Everything unclassified falls
 * through to `code`, which is what keeps `Makefile` / `Dockerfile` / unlisted
 * extensions viewable through the address bar.
 */
type TrustedViewKind = "markdown" | "html" | "image" | "code";

export function trustedViewKind(absolutePath: string): TrustedViewKind {
  if (isMarkdownPreviewFile(absolutePath)) return "markdown";
  const classified = classifyFileViewerKind(absolutePath);
  return classified === "html" || classified === "image" || classified === "markdown"
    ? classified
    : "code";
}

/**
 * Owns the file query, the markdown/HTML toggle, and reload. Callers supply only
 * their outer chrome — the route adds an address bar above it, the right panel
 * sits under the tab strip — so navigation stays out of this component while the
 * view controls live next to the state they act on.
 */
function TrustedFileViewContents({ environmentId, absolutePath, className }: TrustedFileViewProps) {
  // "Show the non-default view for this kind": rendered↔source for html, and
  // markdown↔server-rendered-html for markdown. Reset per file by the `key` on the
  // wrapper below, so a toggle set while reading a report cannot follow you to the
  // next file and open it in the mode you were trying to get away from.
  const [showAlternate, setShowAlternate] = useState(false);
  const kind = absolutePath === null ? null : trustedViewKind(absolutePath);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const rawUrl = viewerHttpUrl(environmentHttpBaseUrl, absolutePath);

  // Images and rendered HTML stream from the server's /viewer route, so the text
  // read is not merely unnecessary for them — for an image it is the read that
  // fails ("… is binary and cannot be previewed as text").
  const usesRawBytes = kind === "image" || (kind === "html" && !showAlternate);
  const file = useTrustedFileQuery(environmentId, usesRawBytes ? null : absolutePath);
  const contents = file.data?.contents ?? null;
  const markdownHtmlMode = showAlternate && kind === "markdown";
  const rendered = useTrustedMarkdownHtmlQuery(
    environmentId,
    markdownHtmlMode ? absolutePath : null,
  );
  // Bumped by Reload for the raw-byte views, whose bytes the server sends with
  // `no-store` but which the <img>/<iframe> would otherwise not re-request.
  const [rawReloadToken, setRawReloadToken] = useState(0);
  const rawUrlWithReload =
    rawUrl === null ? null : rawReloadToken === 0 ? rawUrl : `${rawUrl}&reload=${rawReloadToken}`;

  const body = (() => {
    if (absolutePath === null) {
      return <TrustedFileNotice>No file selected.</TrustedFileNotice>;
    }
    if (environmentId === null) {
      return <TrustedFileNotice>Connect to an environment to view files.</TrustedFileNotice>;
    }
    if (usesRawBytes) {
      if (rawUrlWithReload === null) {
        return (
          <TrustedFileNotice>
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            Connecting…
          </TrustedFileNotice>
        );
      }
      if (kind === "image") {
        return (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex min-h-0 items-center justify-center p-4">
              <img
                src={rawUrlWithReload}
                alt={absolutePath.slice(absolutePath.lastIndexOf("/") + 1)}
                className="max-w-full object-contain"
              />
            </div>
          </ScrollArea>
        );
      }
      // Loaded by `src`, not `srcDoc`: the document then has a real URL, so its
      // relative assets resolve against its own directory, the server's CSP governs
      // it, and it is not capped by the trusted read's 1 MiB text limit. The server
      // serves .html under `sandbox allow-scripts allow-popups` — an opaque origin
      // with no access to this app, but interactive, which is the point of opening a
      // report.
      return (
        <iframe
          title="Rendered document"
          src={rawUrlWithReload}
          // Belt and braces: the server already serves this document under a CSP
          // `sandbox` directive, so it has an opaque origin either way. Declaring it
          // here too means the frame stays sandboxed even if that header is ever
          // lost, and it matches the CSP's capabilities exactly.
          sandbox="allow-scripts allow-popups"
          className="min-h-0 flex-1 border-0 bg-white"
        />
      );
    }
    if (markdownHtmlMode) {
      return rendered.data ? (
        // Sandboxed: the rendered document is treated as untrusted content and
        // gets an opaque origin with no access to this app.
        <iframe
          title="Rendered document"
          sandbox=""
          srcDoc={rendered.data.html}
          className="min-h-0 flex-1 border-0 bg-white"
        />
      ) : (
        <TrustedFileNotice tone={rendered.error ? "error" : "muted"}>
          {rendered.error ?? "Rendering…"}
        </TrustedFileNotice>
      );
    }
    if (file.error !== null && contents === null) {
      return <TrustedFileNotice tone="error">{file.error}</TrustedFileNotice>;
    }
    if (contents === null) {
      return (
        <TrustedFileNotice>
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          {file.isPending ? "Loading…" : "No content."}
        </TrustedFileNotice>
      );
    }
    if (kind === "markdown") {
      return (
        <ScrollArea className="min-h-0 flex-1">
          <ChatMarkdown
            text={contents}
            cwd={directoryOfAbsolutePath(absolutePath)}
            // No thread here, but the environment is known — without it the file
            // chip's actions would resolve against the primary environment and
            // read the wrong machine.
            environmentId={environmentId}
            className="mx-auto max-w-4xl px-6 py-5"
          />
        </ScrollArea>
      );
    }
    return (
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 py-5">
          {/* The read is capped at 1 MiB and the payload has always said so; saying
              nothing made a large file look complete. */}
          {file.data?.truncated ? (
            <p className="mb-3 rounded border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Showing the first 1 MB of this file.
            </p>
          ) : null}
          <HighlightedCodeView code={contents} path={absolutePath} />
        </div>
      </ScrollArea>
    );
  })();

  const toggleLabel =
    kind === "markdown"
      ? {
          text: showAlternate ? "MD" : "HTML",
          title: showAlternate ? "Show markdown" : "Render as HTML",
        }
      : kind === "html"
        ? {
            text: showAlternate ? "Preview" : "Code",
            title: showAlternate ? "Render the document" : "Show HTML source",
          }
        : null;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {absolutePath === null ? null : (
        <div className="flex items-center justify-end gap-1 border-b border-border/60 px-2 py-1">
          {toggleLabel ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setShowAlternate((mode) => !mode)}
              title={toggleLabel.title}
            >
              {toggleLabel.text}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              if (usesRawBytes) setRawReloadToken((token) => token + 1);
              else if (markdownHtmlMode) rendered.refresh();
              else file.refresh();
            }}
            title="Reload file"
          >
            <RotateCcwIcon className="size-3.5" />
          </Button>
        </div>
      )}
      {body}
    </div>
  );
}

export function TrustedFileView(props: TrustedFileViewProps) {
  // Keyed on the path so per-file view state (which mode is showing, the reload
  // token) starts fresh for each file, matching how `WorkspaceImagePreview` and
  // `DiffPanel` are already keyed. The right panel mounts one instance and swaps
  // its path, so without this the state is shared across every file opened.
  return <TrustedFileViewContents key={props.absolutePath ?? ""} {...props} />;
}

export default TrustedFileView;
