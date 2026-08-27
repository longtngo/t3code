import * as Schema from "effect/Schema";
import { FilePathString, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Bound on a path on the wire. 512 sat below every supported platform's real
 * limit — a nested `node_modules` path clears it easily — so a folder that
 * exists could not be listed. 4096 is Linux's PATH_MAX, the largest of the
 * three, and still a bound.
 */
const FILESYSTEM_PATH_MAX_LENGTH = 4096;

/**
 * Cap on a single directory listing. Path autocomplete never approaches it; the
 * directory viewer can, and an unbounded level is a real frame: the largest one
 * measured on a developer machine was 19,477 entries, and a synthetic million
 * serializes to 2.43 MiB compressed with 327ms of blocking encode.
 */
export const FILESYSTEM_BROWSE_MAX_ENTRIES = 10_000;

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: FilePathString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(FilePathString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
  /**
   * Return files and other non-directory entries too, each tagged with its
   * `kind`. Path autocomplete wants folders only; the directory viewer wants
   * the whole listing, and wants an unreadable folder reported rather than
   * rendered as an empty one.
   */
  includeFiles: Schema.optional(Schema.Boolean),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

/**
 * `other` is anything that is neither a regular file nor a directory once
 * symlinks are resolved: a dangling link, a fifo, a socket, a device. It exists
 * so the viewer can render those rows inert — opening a fifo blocks a libuv
 * thread forever, and four of them wedge the default four-thread pool.
 */
export const FilesystemEntryKind = Schema.Literals(["file", "directory", "other"]);
export type FilesystemEntryKind = typeof FilesystemEntryKind.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  // Deliberately not trimmed: a file may legitimately be named " ", and
  // trimming either renames it into a dead path or fails the decode of the
  // entire listing it appears in.
  name: Schema.String,
  fullPath: Schema.String,
  /** Present only when the request set `includeFiles`. */
  kind: Schema.optional(FilesystemEntryKind),
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: FilePathString,
  entries: Schema.Array(FilesystemBrowseEntry),
  /**
   * The server confirming it understood `includeFiles`, so every entry carries
   * a `kind` and files are present.
   *
   * A server that predates the flag drops it on decode and answers with the
   * legacy directories-only listing, which is byte-for-byte a plausible answer
   * to the new question: a client with no way to tell would render every
   * subdirectory as a file and call a folder holding only files empty. Absent
   * therefore means "this server cannot list a folder", not "the folder had no
   * files".
   */
  listedFiles: Schema.optional(Schema.Boolean),
  /** Set when the directory held more than `FILESYSTEM_BROWSE_MAX_ENTRIES`. */
  truncated: Schema.optional(Schema.Boolean),
  /** Entries the directory actually holds, which may exceed those returned. */
  totalCount: Schema.optional(Schema.Number),
});
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;

export const FilesystemBrowseFailure = Schema.Literals([
  "windows_path_unsupported",
  "current_project_required",
  "read_directory_failed",
]);
export type FilesystemBrowseFailure = typeof FilesystemBrowseFailure.Type;

function decodedFilesystemBrowseErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class FilesystemBrowseError extends Schema.TaggedErrorClass<FilesystemBrowseError>()(
  "FilesystemBrowseError",
  {
    partialPath: Schema.optional(TrimmedNonEmptyString),
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(FilesystemBrowseFailure),
    parentPath: Schema.optional(TrimmedNonEmptyString),
    platform: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // Structured diagnostics stay optional for rolling compatibility with legacy message-only
  // payloads, while new call sites must provide the request context and failure classification.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly partialPath: string;
    readonly cwd?: string | undefined;
    readonly failure: FilesystemBrowseFailure;
    readonly parentPath?: string;
    readonly platform?: string;
    readonly cause?: unknown;
  }) {
    const cwd = props.cwd === undefined ? "" : ` from '${props.cwd}'`;
    super({
      ...props,
      message:
        decodedFilesystemBrowseErrorMessage(props) ??
        `Failed to browse filesystem path '${props.partialPath}'${cwd}.`,
    } as any);
  }
}
