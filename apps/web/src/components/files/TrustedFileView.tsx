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

import ChatMarkdown from "../ChatMarkdown";
import { isMarkdownPreviewFile } from "./filePreviewMode";
import { useTrustedFileQuery, useTrustedMarkdownHtmlQuery } from "./projectFilesQueryState";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
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
 * Owns the file query, the markdown/HTML toggle, and reload. Callers supply only
 * their outer chrome — the route adds an address bar above it, the right panel
 * sits under the tab strip — so navigation stays out of this component while the
 * view controls live next to the state they act on.
 */
export function TrustedFileView({ environmentId, absolutePath, className }: TrustedFileViewProps) {
  const [showHtml, setShowHtml] = useState(false);
  const file = useTrustedFileQuery(environmentId, absolutePath);
  const contents = file.data?.contents ?? null;
  const isMarkdown = absolutePath !== null && isMarkdownPreviewFile(absolutePath);
  const htmlMode = showHtml && isMarkdown;
  const rendered = useTrustedMarkdownHtmlQuery(environmentId, htmlMode ? absolutePath : null);

  const body = (() => {
    if (absolutePath === null) {
      return <TrustedFileNotice>No file selected.</TrustedFileNotice>;
    }
    if (environmentId === null) {
      return <TrustedFileNotice>Connect to an environment to view files.</TrustedFileNotice>;
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
    if (htmlMode) {
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
    if (isMarkdown) {
      return (
        <ScrollArea className="min-h-0 flex-1">
          <ChatMarkdown
            text={contents}
            cwd={directoryOfAbsolutePath(absolutePath)}
            className="mx-auto max-w-4xl px-6 py-5"
          />
        </ScrollArea>
      );
    }
    return (
      <ScrollArea className="min-h-0 flex-1">
        <pre className="whitespace-pre-wrap break-words px-6 py-5 font-mono text-xs text-foreground/90">
          {contents}
        </pre>
      </ScrollArea>
    );
  })();

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {absolutePath === null ? null : (
        <div className="flex items-center justify-end gap-1 border-b border-border/60 px-2 py-1">
          {isMarkdown ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setShowHtml((mode) => !mode)}
              title={showHtml ? "Show markdown" : "Render as HTML"}
            >
              {showHtml ? "MD" : "HTML"}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => (htmlMode ? rendered.refresh() : file.refresh())}
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

export default TrustedFileView;
