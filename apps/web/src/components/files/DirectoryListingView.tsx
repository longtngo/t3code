/**
 * Browsable listing of a directory addressed by ABSOLUTE path.
 *
 * Rendered by the file viewers when the path they were asked to open turns out
 * to be a folder, so a folder chip in chat opens something useful instead of a
 * read error.
 *
 * Each level is one `filesystem.browse` call with `includeFiles`, fetched when
 * the row is expanded. That is deliberate: the recursive workspace listing
 * (`projects.listEntries`) is a ranked search index that drops dotfiles and
 * images outside a git repo and pins a native index plus an FS watcher for
 * fifteen minutes, which makes it wrong for "show me what is in this folder".
 *
 * @module DirectoryListingView
 */
import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { useState } from "react";

import type { EnvironmentId, FilesystemBrowseEntry } from "@t3tools/contracts";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "../../lib/utils";
import { useDirectoryListingQuery } from "./projectFilesQueryState";

const INDENT_PER_LEVEL_PX = 12;

export interface DirectoryListingViewProps {
  environmentId: EnvironmentId;
  /** Absolute path of the folder to show. */
  directoryPath: string;
  /**
   * Opens a file the user picked. Named for the listing rather than reusing
   * `onOpenFile`, which `FilePreviewPanel` already defines with
   * workspace-relative semantics.
   */
  onOpenListedFile?: (absolutePath: string) => void;
}

function entryLabel(entry: FilesystemBrowseEntry): string {
  return entry.name;
}

/**
 * One directory's rows. Mounted per expanded folder, so the query for a level
 * is issued when it is first opened and torn down with it.
 */
function DirectoryLevel({
  environmentId,
  directoryPath,
  depth,
  onOpenListedFile,
}: {
  environmentId: EnvironmentId;
  directoryPath: string;
  depth: number;
  onOpenListedFile?: (absolutePath: string) => void;
}) {
  const listing = useDirectoryListingQuery(environmentId, directoryPath);
  const { resolvedTheme } = useTheme();
  const [expanded, setExpanded] = useState<ReadonlyArray<string>>([]);
  const indent = { paddingLeft: `${depth * INDENT_PER_LEVEL_PX}px` };

  if (listing.data === null) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground"
        style={indent}
      >
        {listing.error === null ? (
          <>
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            Loading…
          </>
        ) : (
          <span className="text-destructive">{listing.error}</span>
        )}
      </div>
    );
  }

  const entries = listing.data.entries;
  if (entries.length === 0) {
    return (
      <div className="px-3 py-1.5 text-sm text-muted-foreground" style={indent}>
        This folder is empty.
      </div>
    );
  }

  return (
    <>
      {entries.map((entry) => {
        const isDirectory = entry.kind === "directory";
        // A fifo, socket, device or dangling link. Reading one can block a
        // server thread indefinitely, so it is shown but not openable.
        const isInert = entry.kind === "other";
        const isExpanded = expanded.includes(entry.fullPath);
        return (
          <div key={entry.fullPath}>
            <button
              type="button"
              disabled={isInert}
              aria-expanded={isDirectory ? isExpanded : undefined}
              onClick={() => {
                if (isInert) return;
                if (isDirectory) {
                  setExpanded((current) =>
                    current.includes(entry.fullPath)
                      ? current.filter((path) => path !== entry.fullPath)
                      : [...current, entry.fullPath],
                  );
                  return;
                }
                onOpenListedFile?.(entry.fullPath);
              }}
              className={cn(
                "flex w-full items-center gap-1.5 px-3 py-1 text-left text-sm",
                isInert ? "cursor-default text-muted-foreground" : "hover:bg-muted/60",
              )}
              style={indent}
            >
              {isDirectory ? (
                isExpanded ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )
              ) : (
                <span className="size-3.5 shrink-0" aria-hidden />
              )}
              <PierreEntryIcon
                pathValue={entry.fullPath}
                kind={isDirectory ? "directory" : "file"}
                theme={resolvedTheme}
                className="size-3.5 shrink-0"
              />
              <span className="truncate">{entryLabel(entry)}</span>
            </button>
            {isDirectory && isExpanded ? (
              <DirectoryLevel
                environmentId={environmentId}
                directoryPath={entry.fullPath}
                depth={depth + 1}
                {...(onOpenListedFile ? { onOpenListedFile } : {})}
              />
            ) : null}
          </div>
        );
      })}
      {listing.data.truncated === true ? (
        <div className="px-3 py-1.5 text-xs text-muted-foreground" style={indent}>
          Showing {entries.length} of {listing.data.totalCount ?? entries.length} entries.
        </div>
      ) : null}
    </>
  );
}

export function DirectoryListingView({
  environmentId,
  directoryPath,
  onOpenListedFile,
}: DirectoryListingViewProps) {
  return (
    <div className="min-h-0 flex-1 overflow-auto py-1">
      <DirectoryLevel
        environmentId={environmentId}
        directoryPath={directoryPath}
        depth={0}
        {...(onOpenListedFile ? { onOpenListedFile } : {})}
      />
    </div>
  );
}
