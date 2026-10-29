import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type FilesystemBrowseResult,
  type ProjectListEntriesResult,
  ProjectReadFileError,
  type ProjectReadFileResult,
  T3_PROJECT_FILE_NAME,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { filesystemEnvironment, useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useProjectPathSearch } from "~/state/queries";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { isDirectoryListing } from "./directoryListing.logic";
import { revisionedQuery } from "~/state/revisionedQuery";

const EMPTY_PROJECT_FILE_PATH = "";
const EMPTY_PROJECT_ENTRIES_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectListEntriesResult, never>(false),
);
const EMPTY_PROJECT_FILE_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectReadFileResult, never>(false),
).pipe(Atom.withLabel("project-file-query:empty"));
export function optimisticFileAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
) {
  return projectEnvironment.optimisticFile({ environmentId, cwd, relativePath });
}

// Dirty contents must survive a closed preview, including failed or unauthorized saves.
const unsavedFileMounts = new Map<ReturnType<typeof optimisticFileAtom>, () => void>();

function releaseUnsavedFile(atom: ReturnType<typeof optimisticFileAtom>): void {
  const unmount = unsavedFileMounts.get(atom);
  unsavedFileMounts.delete(atom);
  unmount?.();
}

interface ProjectQueryState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

interface ProjectFileQueryState extends ProjectQueryState<ProjectReadFileResult> {
  readonly readError: ProjectReadFileError | null;
  readonly isNotFile: boolean;
  readonly isFile: boolean;
}

function getProjectEntriesQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath?: string,
) {
  return projectEnvironment.listEntries({
    environmentId,
    input: { cwd, ...(directoryPath !== undefined ? { directoryPath } : {}) },
  });
}

export function getProjectFileQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
) {
  return projectEnvironment.readFile({
    environmentId,
    input: {
      cwd,
      relativePath: relativePath ?? EMPTY_PROJECT_FILE_PATH,
      ...(relativePath === T3_PROJECT_FILE_NAME ? { allowMissing: true } : {}),
    },
  });
}

export function getTrustedFileQueryAtom(environmentId: EnvironmentId, path: string) {
  return projectEnvironment.readTrustedFile({ environmentId, input: { path } });
}

const EMPTY_RENDERED_HTML_ATOM = Atom.make(
  AsyncResult.initial<{ readonly html: string }, never>(false),
).pipe(Atom.withLabel("project-file-query:empty-html"));

/**
 * Server-rendered standalone HTML for a markdown file, sandboxed by the same
 * trusted-read roots. Powers the viewer's HTML toggle.
 */
export function useTrustedMarkdownHtmlQuery(
  environmentId: EnvironmentId | null,
  path: string | null,
): ProjectQueryState<{ readonly html: string }> {
  const fileAccess = useFilesystemReadAccess(environmentId);
  const enabled = environmentId !== null && path !== null;
  const atom =
    enabled && fileAccess.canReadFiles
      ? projectEnvironment.renderTrustedMarkdown({ environmentId, input: { path } })
      : EMPTY_RENDERED_HTML_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = () => refreshAtom();
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: fileAccessError(fileAccess, enabled, failureCause(result)),
    isPending: enabled && (fileAccess.isPending || result.waiting),
    refresh,
  };
}

export function setProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): void {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  if (!unsavedFileMounts.has(atom)) {
    unsavedFileMounts.set(atom, appAtomRegistry.mount(atom));
  }
  appAtomRegistry.set(atom, {
    confirmedAgainst: undefined,
    data: {
      relativePath,
      contents,
      byteLength: new TextEncoder().encode(contents).byteLength,
      truncated: false,
    },
  });
}

export function getOptimisticProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? null;
}

export function getProjectFileContents(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): string | undefined {
  const optimistic = getOptimisticProjectFileQueryData(environmentId, cwd, relativePath);
  if (optimistic) return optimistic.contents;
  const result = appAtomRegistry.get(getProjectFileQueryAtom(environmentId, cwd, relativePath));
  const data = Option.getOrUndefined(AsyncResult.value(result));
  return data?.exists === false ? undefined : data?.contents;
}

export function getUnsavedProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  const optimistic = appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath));
  return optimistic?.confirmedAgainst === undefined ? (optimistic?.data ?? null) : null;
}

export function confirmProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): boolean {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  const optimisticFile = appAtomRegistry.get(atom);
  if (optimisticFile?.data.contents !== contents) return false;

  const queryAtom = getProjectFileQueryAtom(environmentId, cwd, relativePath);
  const confirmed = {
    ...optimisticFile,
    confirmedAgainst: appAtomRegistry.get(queryAtom),
  };
  appAtomRegistry.set(atom, confirmed);
  releaseUnsavedFile(atom);
  appAtomRegistry.refresh(queryAtom);
  void executeAtomQuery(appAtomRegistry, queryAtom, {
    reportDefect: false,
    reportFailure: false,
  }).then((result) => {
    if (result._tag === "Success" && appAtomRegistry.get(atom) === confirmed) {
      appAtomRegistry.set(atom, null);
    }
  });
  return true;
}

export function resolveProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  data: ProjectReadFileResult | null,
): ProjectReadFileResult | null {
  if (relativePath === null) return data;
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? data;
}

export function clearProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): void {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  appAtomRegistry.set(atom, null);
  releaseUnsavedFile(atom);
}

function failureCause<A>(result: AsyncResult.AsyncResult<A, unknown>): unknown {
  return result._tag === "Failure" ? Cause.squash(result.cause) : null;
}

function errorMessage(cause: unknown): string | null {
  if (cause === null) return null;
  return cause instanceof Error ? cause.message : "Workspace query failed.";
}

type FileAccess = ReturnType<typeof useFilesystemReadAccess>;

/** FORK: the error the trusted and listing queries report, matching upstream's gated queries above
 *  and below: nothing while disabled or while access is still being checked, the server's error
 *  once the read ran, and the access error when it may not run. */
function fileAccessError(fileAccess: FileAccess, enabled: boolean, cause: unknown): string | null {
  if (!enabled || fileAccess.isPending) return null;
  return fileAccess.canReadFiles
    ? errorMessage(cause)
    : (fileAccess.error ?? "This connection cannot read host files.");
}

const isProjectReadFileError = Schema.is(ProjectReadFileError);

/** `revision` is the workspace mutation id; a new one refetches the listing. */
export function useProjectEntriesQuery(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath?: string,
  revision?: string | null,
): ProjectQueryState<ProjectListEntriesResult> {
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const atom = canReadFiles
    ? getProjectEntriesQueryAtom(environmentId, cwd, directoryPath)
    : EMPTY_PROJECT_ENTRIES_QUERY_ATOM;
  const result = useAtomValue(revisionedQuery(atom, canReadFiles ? revision : undefined));
  const refreshAtom = useAtomRefresh(atom);
  const refresh = () => refreshAtom();
  return {
    data: AsyncResult.getOrElse(result, () => null),
    error: fileAccess.isPending
      ? null
      : canReadFiles
        ? errorMessage(failureCause(result))
        : (fileAccess.error ?? "This connection cannot read host files."),
    isPending: fileAccess.isPending || result.waiting,
    refresh,
  };
}

/** Empty queries return frecency-ranked files without transferring the full workspace listing. */
export function useProjectFilePickerQuery(
  environmentId: EnvironmentId,
  cwd: string,
  query: string,
  limit: number,
  options?: { readonly imageOnly?: boolean },
) {
  const search = useProjectPathSearch(
    {
      environmentId,
      cwd,
      query,
      kind: "file",
      ...(options?.imageOnly ? { imageOnly: true } : {}),
    },
    limit,
    { allowEmptyQuery: true },
  );

  return {
    entries: search.isPending ? [] : search.entries,
    error: search.error,
    isPending: search.isPending,
    matchedQuery: search.searchedQuery,
  };
}

export function useProjectFileQuery(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  enabled = true,
): ProjectFileQueryState {
  // Read media-like paths too; a failed read is how folders with those names are detected.
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const isQueryEnabled = enabled;
  const atom =
    enabled && canReadFiles
      ? getProjectFileQueryAtom(environmentId, cwd, relativePath)
      : EMPTY_PROJECT_FILE_QUERY_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = () => refreshAtom();
  const readData = AsyncResult.getOrElse(result, () => null);
  const isMissing = readData?.exists === false;
  const optimisticResult = useAtomValue(
    optimisticFileAtom(environmentId, cwd, relativePath ?? EMPTY_PROJECT_FILE_PATH),
  );
  const optimisticFile = relativePath === null ? null : optimisticResult;
  const cause = failureCause(result);
  const readError = isProjectReadFileError(cause) ? cause : null;
  const data = canReadFiles ? (optimisticFile?.data ?? (isMissing ? null : readData)) : null;
  const isNotFile = readError?.failure === "path_not_file";

  return {
    data,
    error:
      !isQueryEnabled || fileAccess.isPending
        ? null
        : canReadFiles
          ? isMissing && !optimisticFile
            ? `'${relativePath}' does not exist.`
            : errorMessage(cause)
          : (fileAccess.error ?? "This connection cannot read host files."),
    isPending: isQueryEnabled && (fileAccess.isPending || result.waiting),
    readError,
    isNotFile,
    // A folder error overrides cached contents retained across failed refreshes.
    isFile: !isNotFile && (data !== null || readError?.failure === "binary_file"),
    refresh,
  };
}

/**
 * Reads a file by ABSOLUTE path via the trusted-read RPC, for the `/viewer/$` route and files
 * outside any workspace (`~/reports/...`, `/tmp/...`). A stable empty atom while there is no
 * environment or path.
 */
export function useTrustedFileQuery(
  environmentId: EnvironmentId | null,
  path: string | null,
): ProjectQueryState<ProjectReadFileResult> {
  const fileAccess = useFilesystemReadAccess(environmentId);
  const enabled = environmentId !== null && path !== null;
  const atom =
    enabled && fileAccess.canReadFiles
      ? getTrustedFileQueryAtom(environmentId, path)
      : EMPTY_PROJECT_FILE_QUERY_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = () => refreshAtom();
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: fileAccessError(fileAccess, enabled, failureCause(result)),
    isPending: enabled && (fileAccess.isPending || result.waiting),
    refresh,
  };
}

const EMPTY_DIRECTORY_LISTING_ATOM = Atom.make(
  AsyncResult.initial<FilesystemBrowseResult, never>(false),
).pipe(Atom.withLabel("directory-listing-query:empty"));

/**
 * One level of a directory, by absolute path. The trailing separator makes `filesystem.browse` list
 * the folder instead of autocompleting it; `includeFiles` returns kinded files and reports an
 * unreadable folder. Viewers ask after a failed read, so a failure here means "not a directory".
 */
export function useDirectoryListingQuery(
  environmentId: EnvironmentId | null,
  directoryPath: string | null,
): ProjectQueryState<FilesystemBrowseResult> {
  const fileAccess = useFilesystemReadAccess(environmentId);
  const enabled = environmentId !== null && directoryPath !== null;
  const atom =
    enabled && fileAccess.canReadFiles
      ? filesystemEnvironment.browse({
          environmentId,
          input: {
            partialPath: directoryPath.endsWith("/") ? directoryPath : `${directoryPath}/`,
            includeFiles: true,
          },
        })
      : EMPTY_DIRECTORY_LISTING_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = () => refreshAtom();
  const value = Option.getOrNull(AsyncResult.value(result));
  // Discarding an unconfirmed listing leaves the viewer's original read error,
  // which is the most an older server can honestly support.
  const supported = value === null || isDirectoryListing(value);
  return {
    data: supported ? value : null,
    error: supported
      ? fileAccessError(fileAccess, enabled, failureCause(result))
      : "This server cannot list folders.",
    isPending: enabled && (fileAccess.isPending || result.waiting),
    refresh,
  };
}
