import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";
import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";
import { createMarkdownHtmlCache } from "../markdownHtml.ts";
import { MarkdownHtmlRenderer } from "../markdownHtmlRenderer.ts";

// Cap previewable file reads so a stray large file can't be slurped into memory.
const MAX_READ_FILE_BYTES = 2 * 1024 * 1024;

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;
  const markdownHtmlRenderer = yield* MarkdownHtmlRenderer;

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });

  // Resolve a read target the same way for every reader: relative paths resolve
  // against cwd; absolute paths (e.g. /var/folders/…, ~/reports/…) are used as-is,
  // intentionally allowing reads outside the root (report/temp files live there).
  const resolveReadPath = (cwd: string, requestedPath: string): string => {
    const expanded = expandHomePath(requestedPath.trim());
    return path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(cwd, expanded);
  };

  // Stat a read target and enforce the shared file/size guards. Returned to
  // callers that need mtime/size (e.g. the HTML cache) without re-statting.
  const statReadableFile = Effect.fn("WorkspaceFileSystem.statReadableFile")(function* (
    cwd: string,
    requestedPath: string,
    absolutePath: string,
  ) {
    const stat = yield* fileSystem.stat(absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd,
            relativePath: requestedPath,
            operation: "workspaceFileSystem.stat",
            detail: cause.message,
            cause,
          }),
      ),
    );
    if (stat.type !== "File") {
      return yield* new WorkspaceFileSystemError({
        cwd,
        relativePath: requestedPath,
        operation: "workspaceFileSystem.readFile",
        detail: `Not a file: ${absolutePath}`,
      });
    }
    if (Number(stat.size) > MAX_READ_FILE_BYTES) {
      return yield* new WorkspaceFileSystemError({
        cwd,
        relativePath: requestedPath,
        operation: "workspaceFileSystem.readFile",
        detail: `File is too large to preview (${Number(stat.size)} bytes; max ${MAX_READ_FILE_BYTES}).`,
      });
    }
    return stat;
  });

  const readFileStringAt = Effect.fn("WorkspaceFileSystem.readFileStringAt")(function* (
    cwd: string,
    requestedPath: string,
    absolutePath: string,
  ) {
    return yield* fileSystem.readFileString(absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd,
            relativePath: requestedPath,
            operation: "workspaceFileSystem.readFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
  });

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const absolutePath = resolveReadPath(input.cwd, input.path);
    yield* statReadableFile(input.cwd, input.path, absolutePath);
    const contents = yield* readFileStringAt(input.cwd, input.path, absolutePath);
    return { contents, resolvedPath: absolutePath };
  });

  // Per-process LRU of rendered HTML documents, keyed by resolved path and
  // validated against the source file's stat + content hash on each request.
  const htmlCache = createMarkdownHtmlCache();

  const readFileAsHtml: WorkspaceFileSystemShape["readFileAsHtml"] = Effect.fn(
    "WorkspaceFileSystem.readFileAsHtml",
  )(function* (input) {
    const absolutePath = resolveReadPath(input.cwd, input.path);
    const stat = yield* statReadableFile(input.cwd, input.path, absolutePath);
    const mtimeMs = Option.getOrUndefined(Option.map(stat.mtime, (date) => date.getTime()));
    const size = Number(stat.size);

    const cached = htmlCache.get(absolutePath);
    // Fast path: an unchanged file (same mtime + size) reuses the cached document
    // without reading or hashing. Skipped when the platform omits mtime.
    if (
      cached !== undefined &&
      mtimeMs !== undefined &&
      cached.mtimeMs === mtimeMs &&
      cached.size === size
    ) {
      return { html: cached.html, resolvedPath: absolutePath, fromCache: true };
    }

    const contents = yield* readFileStringAt(input.cwd, input.path, absolutePath);
    const hash = createHash("sha256").update(contents).digest("hex");

    // Content matches a prior render (e.g. the file was touched but unchanged):
    // refresh the stat metadata and reuse the cached HTML.
    if (cached !== undefined && cached.hash === hash) {
      htmlCache.set(absolutePath, { mtimeMs, size, hash, html: cached.html });
      return { html: cached.html, resolvedPath: absolutePath, fromCache: true };
    }

    const html = yield* markdownHtmlRenderer.render(contents);
    htmlCache.set(absolutePath, { mtimeMs, size, hash, html });
    return { html, resolvedPath: absolutePath, fromCache: false };
  });

  return { writeFile, readFile, readFileAsHtml } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
