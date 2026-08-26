// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemEntryKind,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { FILESYSTEM_BROWSE_MAX_ENTRIES } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

export class WorkspaceEntriesWindowsPathUnsupportedError extends Schema.TaggedErrorClass<WorkspaceEntriesWindowsPathUnsupportedError>()(
  "WorkspaceEntriesWindowsPathUnsupportedError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Windows-style workspace path '${this.partialPath}' is not supported on '${this.platform}'${cwd}.`;
  }
}

export class WorkspaceEntriesCurrentProjectRequiredError extends Schema.TaggedErrorClass<WorkspaceEntriesCurrentProjectRequiredError>()(
  "WorkspaceEntriesCurrentProjectRequiredError",
  {
    partialPath: Schema.String,
  },
) {
  override get message(): string {
    return `A current project is required to browse relative workspace path '${this.partialPath}'.`;
  }
}

export class WorkspaceEntriesReadDirectoryError extends Schema.TaggedErrorClass<WorkspaceEntriesReadDirectoryError>()(
  "WorkspaceEntriesReadDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to read workspace directory '${this.parentPath}' while browsing '${this.partialPath}'${cwd}.`;
  }
}

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export const WorkspaceEntriesError = Schema.Union([
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceEntries") {}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

/**
 * Classify a directory entry, resolving symlinks.
 *
 * `dirent.isDirectory()` is false for a symlink to a directory — on macOS that
 * includes `/etc`, `/tmp` and `/var` — so trusting it renders those as files
 * nobody can open. Only symlinks pay for the extra `stat`; a link that dangles
 * or points at a fifo, socket or device resolves to `other`, which the viewer
 * refuses to open.
 */
const direntKind = Effect.fn("WorkspaceEntries.direntKind")(function* (
  dirent: NodeFS.Dirent,
  fullPath: string,
): Effect.fn.Return<FilesystemEntryKind, never> {
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  if (!dirent.isSymbolicLink()) return "other";
  const stats = yield* Effect.promise(() =>
    NodeFSP.stat(fullPath).then(
      (resolved) => resolved,
      () => null,
    ),
  );
  if (stats === null) return "other";
  return stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
});

const resolveBrowseTarget = Effect.fn("WorkspaceEntries.resolveBrowseTarget")(function* (
  input: FilesystemBrowseInput,
  path: Path.Path,
): Effect.fn.Return<string, WorkspaceEntriesBrowseError> {
  const platform = yield* HostProcessPlatform;
  if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    return yield* new WorkspaceEntriesWindowsPathUnsupportedError({
      cwd: input.cwd,
      partialPath: input.partialPath,
      platform,
    });
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePath(input.partialPath, path));
  }

  if (!input.cwd) {
    return yield* new WorkspaceEntriesCurrentProjectRequiredError({
      partialPath: input.partialPath,
    });
  }
  return path.resolve(expandHomePath(input.cwd, path), input.partialPath);
});

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  // A full listing readdirs off-thread, but the libuv pool is four threads by
  // default and RPC concurrency is unbounded: measured on a 19,477-entry
  // directory, four concurrent listings take an unrelated file read from 0.05ms
  // to 23ms and eight take it to 129ms, alongside WebSocket frame compression
  // for every connected client, which shares the same pool. Two permits leaves
  // headroom on a four-thread pool; a real directory listing costs single-digit
  // to low-tens of milliseconds, so nothing queues in practice.
  const listingSemaphore = yield* Semaphore.make(2);
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
        const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, variant);
        if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, indexKey))) {
          continue;
        }
        const recoverRefreshFailure = (
          cause:
            | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
            | WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut
            | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
        ) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Failed to refresh workspace search index", {
              cwd,
              variant,
              cause,
            });
            yield* workspaceSearchIndexes.invalidate(indexKey);
          });
        yield* Effect.gen(function* () {
          const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          yield* searchIndex.refresh();
        }).pipe(
          Effect.provide(workspaceSearchIndexes.get(indexKey)),
          Effect.catchTags({
            WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
            WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
            WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
          }),
        );
      }
    },
  );

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      return yield* browseUnbounded(input).pipe(
        input.includeFiles === true ? Semaphore.withPermits(listingSemaphore, 1) : (self) => self,
      );
    },
  );

  const browseUnbounded = Effect.fn("WorkspaceEntries.browseUnbounded")(function* (
    input: FilesystemBrowseInput,
  ): Effect.fn.Return<FilesystemBrowseResult, WorkspaceEntriesBrowseError> {
    const resolvedInputPath = yield* resolveBrowseTarget(input, path);
    const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
    const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
    const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

    const dirents = yield* Effect.tryPromise({
      try: () => NodeFSP.readdir(parentPath, { withFileTypes: true }),
      catch: (cause) =>
        new WorkspaceEntriesReadDirectoryError({
          cwd: input.cwd,
          partialPath: input.partialPath,
          parentPath,
          cause,
        }),
    }).pipe(
      Effect.catchIf(
        (error) => {
          // A viewer must not render an unreadable folder as an empty one, so
          // only autocomplete keeps the quiet degradation.
          if (input.includeFiles === true) return false;
          const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
          return code === "EACCES" || code === "EPERM";
        },
        () => Effect.succeed([]),
      ),
    );

    const showHidden = endsWithSeparator || prefix.startsWith(".");
    const lowerPrefix = prefix.toLowerCase();
    const matched = dirents.filter(
      (dirent) =>
        dirent.name.toLowerCase().startsWith(lowerPrefix) &&
        (showHidden || !dirent.name.startsWith(".")),
    );

    if (input.includeFiles !== true) {
      const entries = matched
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => ({
          name: dirent.name,
          fullPath: path.join(parentPath, dirent.name),
        }));
      return {
        parentPath,
        entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    }

    const totalCount = matched.length;
    // Sorted before the cap, not after: slicing raw `readdir` order and sorting
    // the survivors yields a list that looks alphabetical and is missing names
    // from the middle of it, under a count that says only the tail was dropped.
    // Truncating a sorted list drops a contiguous tail, which is what "showing
    // N of M" claims. Directories are floated to the top afterwards, on the
    // entries that survived, because that needs a `kind` this stage lacks.
    const kept = matched
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .slice(0, FILESYSTEM_BROWSE_MAX_ENTRIES);
    const entries: Array<{
      readonly name: string;
      readonly fullPath: string;
      readonly kind: FilesystemEntryKind;
    }> = [];
    for (const dirent of kept) {
      const fullPath = path.join(parentPath, dirent.name);
      entries.push({ name: dirent.name, fullPath, kind: yield* direntKind(dirent, fullPath) });
    }

    return {
      parentPath,
      entries: entries.toSorted(
        (left, right) =>
          Number(right.kind === "directory") - Number(left.kind === "directory") ||
          left.name.localeCompare(right.name),
      ),
      listedFiles: true,
      truncated: totalCount > kept.length,
      totalCount,
    };
  });

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const normalizedQuery = normalizeSearchQuery(input.query, {
        trimLeadingPattern: /^[@./]+/,
      });
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.search(normalizedQuery, input.limit, input.kind, input.imageOnly);
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  const searchContents: WorkspaceEntries["Service"]["searchContents"] = Effect.fn(
    "WorkspaceEntries.searchContents",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    return yield* Effect.gen(function* () {
      const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
      return yield* searchIndex.searchContents(input);
    }).pipe(
      Effect.provide(
        workspaceSearchIndexes.get(
          WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "content"),
        ),
      ),
    );
  });

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.list();
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  return WorkspaceEntries.of({ browse, list, refresh, search, searchContents });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
);
