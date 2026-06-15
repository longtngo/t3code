/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  ProjectWriteFileInput,
  ProjectWriteFileResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRenderMarkdownHtmlInput,
  ProjectRenderMarkdownHtmlResult,
} from "@t3tools/contracts";
import { WorkspacePathOutsideRootError } from "./WorkspacePaths.ts";

export class WorkspaceFileSystemError extends Schema.TaggedErrorClass<WorkspaceFileSystemError>()(
  "WorkspaceFileSystemError",
  {
    cwd: Schema.String,
    relativePath: Schema.optional(Schema.String),
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * WorkspaceFileSystemShape - Service API for workspace-relative file operations.
 */
export interface WorkspaceFileSystemShape {
  /**
   * Write a file relative to the workspace root.
   *
   * Creates parent directories as needed and rejects paths that escape the
   * workspace root.
   */
  readonly writeFile: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<
    ProjectWriteFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;

  /**
   * Read a file as UTF-8 text.
   *
   * Resolves relative paths against `cwd` and expands a leading `~`. Reads are
   * sandboxed to the home directory, the OS temp dir, and any `allowedRoots` the
   * caller trusts (the workspace roots of known projects). The client `cwd` is
   * used only to resolve relative paths, never to authorize them. Files larger
   * than a fixed byte cap are rejected rather than read.
   */
  readonly readFile: (
    input: ProjectReadFileInput,
    allowedRoots?: readonly string[],
  ) => Effect.Effect<ProjectReadFileResult, WorkspaceFileSystemError>;

  /**
   * Read a markdown file and render it to a self-contained HTML document.
   *
   * Resolves, sandboxes, and size-caps the path exactly like {@link readFile}.
   * The generated HTML is cached per process, keyed by resolved path; cache hits
   * are validated by file mtime + size (fast path) and content hash
   * (touch-without-change), so an unchanged file is converted at most once.
   * Returns the cached document with `fromCache: true` when reused.
   */
  readonly readFileAsHtml: (
    input: ProjectRenderMarkdownHtmlInput,
    allowedRoots?: readonly string[],
  ) => Effect.Effect<ProjectRenderMarkdownHtmlResult, WorkspaceFileSystemError>;
}

/**
 * WorkspaceFileSystem - Service tag for workspace file operations.
 */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  WorkspaceFileSystemShape
>()("t3/workspace/Services/WorkspaceFileSystem") {}
