/**
 * Read-only view of a file by ABSOLUTE path through the trusted read RPC, which has NO path
 * sandbox: the boundary is the `orchestration:read` scope (see `readTrustedFile`). Renders both
 * the `/viewer/$` route and the right panel's trusted-file surface; editable workspace files
 * use `FilePreviewPanel` instead.
 */
import { LoaderCircle, RotateCcwIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { EnvironmentId } from "@t3tools/contracts";

import ChatMarkdown, { HighlightedCodeView } from "../ChatMarkdown";
import { classifyFileViewerKind } from "../../lib/codeFileTypes";
import { DirectoryListingView } from "./DirectoryListingView";
import { isMarkdownPreviewFile } from "./filePreviewMode";
import {
  useDirectoryListingQuery,
  useTrustedFileQuery,
  useTrustedMarkdownHtmlQuery,
} from "./projectFilesQueryState";
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
  /**
   * Opens a file picked out of a directory listing, when this path turns out to
   * be a folder. Every mount supplies one; a listing whose rows do nothing when
   * clicked is worse than the read error it replaced.
   */
  onOpenListedFile?: (absolutePath: string) => void;
}

/**
 * How this view renders a path. `.mdx` goes through `isMarkdownPreviewFile` because the shared
 * classifier covers only `md|markdown`. Everything unclassified falls through to `code`, which
 * keeps `Makefile`, `Dockerfile` and unlisted extensions viewable.
 */
type TrustedViewKind = "markdown" | "html" | "image" | "video" | "audio" | "code";

/**
 * What a raw-byte view (image, video, rendered HTML) shows for one render. A raw-byte kind
 * never issues the text read, so its media `onError` is the only failure signal, and a
 * DIRECTORY named `demo.mp4` must reach the listing probe rather than a dead player.
 */
export type RawMediaOutcome = "connecting" | "media" | "listing" | "probing" | "failed";

/**
 * Whether a path that would not open as a regular file should be probed as a directory. Both
 * failure signals count: a raw-byte kind never issues the text read, so a failed <img>/<video>
 * is its only signal, and arming on `readError` alone left media-named directories unprobed.
 */
export function shouldProbeForDirectory(input: {
  readonly readError: string | null;
  readonly mediaFailed: boolean;
}): boolean {
  return input.readError !== null || input.mediaFailed;
}

export function rawMediaOutcome(input: {
  readonly hasUrl: boolean;
  readonly mediaFailed: boolean;
  readonly listingHasData: boolean;
  readonly listingIsPending: boolean;
}): RawMediaOutcome {
  if (!input.hasUrl) return "connecting";
  if (!input.mediaFailed) return "media";
  if (input.listingHasData) return "listing";
  return input.listingIsPending ? "probing" : "failed";
}

export function trustedViewKind(absolutePath: string): TrustedViewKind {
  if (isMarkdownPreviewFile(absolutePath)) return "markdown";
  const classified = classifyFileViewerKind(absolutePath);
  return classified === "html" ||
    classified === "image" ||
    classified === "video" ||
    classified === "audio" ||
    classified === "markdown"
    ? classified
    : "code";
}

/**
 * Owns the file query, the markdown/HTML toggle, and reload. Callers supply only
 * their outer chrome — the route adds an address bar above it, the right panel
 * sits under the tab strip — so navigation stays out of this component while the
 * view controls live next to the state they act on.
 */
function TrustedFileViewContents({
  environmentId,
  absolutePath,
  className,
  onOpenListedFile,
}: TrustedFileViewProps) {
  // "Show the non-default view for this kind": rendered↔source for html, and
  // markdown↔server-rendered-html for markdown. Reset per file by the `key` on the
  // wrapper below, so a toggle set while reading a report cannot follow you to the
  // next file and open it in the mode you were trying to get away from.
  const [showAlternate, setShowAlternate] = useState(false);
  const kind = absolutePath === null ? null : trustedViewKind(absolutePath);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const rawUrl = viewerHttpUrl(environmentHttpBaseUrl, absolutePath);

  // Images, video and rendered HTML stream from the server's /viewer route, so the
  // text read is not merely unnecessary for them — for an image or a video it is
  // the read that fails ("… is binary and cannot be previewed as text").
  const usesRawBytes =
    kind === "image" || kind === "video" || kind === "audio" || (kind === "html" && !showAlternate);
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
  // A raw-byte kind never issues the text read, so `file.error` stays null and the
  // error branch below cannot see a failed <video>. Without this, a 404, 413, 416
  // or 401 renders as a silent dead player.
  const [rawMediaFailed, setRawMediaFailed] = useState(false);
  // Every read failure is a directory candidate; the listing request is both question and
  // answer (it fails for anything that is not a folder). Never guess from the name: `Makefile`
  // and `.env` are files. Raw-byte kinds never issue the text read, so `rawMediaFailed` also
  // feeds the probe, since a DIRECTORY named `demo.mp4` fails as media.
  const readFailed = shouldProbeForDirectory({
    readError: file.error,
    mediaFailed: rawMediaFailed,
  });
  const listing = useDirectoryListingQuery(
    readFailed ? environmentId : null,
    readFailed ? absolutePath : null,
  );
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
      const outcome = rawMediaOutcome({
        hasUrl: rawUrlWithReload !== null,
        mediaFailed: rawMediaFailed,
        listingHasData: listing.data !== null,
        listingIsPending: listing.isPending,
      });
      // The `rawUrlWithReload === null` half is redundant with the outcome and
      // present only so the <img>/<video> below narrow to a non-null src.
      if (outcome === "connecting" || rawUrlWithReload === null) {
        return (
          <TrustedFileNotice>
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            Connecting…
          </TrustedFileNotice>
        );
      }
      if (outcome === "listing") {
        return (
          <DirectoryListingView
            environmentId={environmentId}
            directoryPath={absolutePath}
            {...(onOpenListedFile ? { onOpenListedFile } : {})}
          />
        );
      }
      if (outcome === "probing") {
        return (
          <TrustedFileNotice>
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            Loading…
          </TrustedFileNotice>
        );
      }
      if (outcome === "failed") {
        return (
          <TrustedFileNotice tone="error">
            This file could not be played. It may be missing, too large, or in a format this browser
            cannot decode.
          </TrustedFileNotice>
        );
      }
      if (kind === "video") {
        return (
          <div className="flex min-h-0 flex-1 items-center justify-center bg-black/90 p-4">
            {/* No autoPlay: the expanded-image dialog is an explicit "play this"
                gesture, but the viewer is a file browser, and a report path that
                starts playing audio on click is a defect. */}
            <video
              src={rawUrlWithReload}
              controls
              playsInline
              preload="metadata"
              onError={() => setRawMediaFailed(true)}
              className="max-h-full max-w-full rounded"
            />
          </div>
        );
      }
      if (kind === "audio") {
        return (
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            {/* No autoPlay, for the same reason video has none: the viewer is a
                file browser, and a path that starts playing on click is a defect. */}
            <audio
              src={rawUrlWithReload}
              controls
              preload="metadata"
              onError={() => setRawMediaFailed(true)}
              className="w-full max-w-lg"
            />
          </div>
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
      // Loaded by `src`, not `srcDoc`: relative assets resolve, the server's CSP governs it, and it
      // skips the trusted read's 1 MiB cap. The server sandboxes .html (`allow-scripts allow-popups`):
      // an opaque origin with no access to this app, but interactive.
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
      if (listing.data !== null && environmentId !== null) {
        return (
          <DirectoryListingView
            environmentId={environmentId}
            directoryPath={absolutePath}
            {...(onOpenListedFile ? { onOpenListedFile } : {})}
          />
        );
      }
      if (listing.isPending) {
        return (
          <TrustedFileNotice>
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            Loading…
          </TrustedFileNotice>
        );
      }
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
              if (usesRawBytes) {
                if (listing.data !== null) {
                  // A directory is on screen. Resetting the media state would only
                  // re-issue the byte request that already failed and flash the
                  // listing away in between.
                  listing.refresh();
                } else {
                  // The notice would otherwise be sticky for the life of the mount,
                  // since the component is keyed on the path.
                  setRawMediaFailed(false);
                  setRawReloadToken((token) => token + 1);
                }
              } else if (markdownHtmlMode) rendered.refresh();
              else {
                file.refresh();
                // The read stays failed for a directory, so refreshing it alone
                // never reaches the listing that is actually on screen.
                if (file.error !== null) listing.refresh();
              }
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
