import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";
import { allowedReadRoots, isWithinAllowedRoots } from "../readAccess.ts";
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
  // against cwd; absolute paths and `~/…` are used as-is. Sandbox containment is
  // enforced separately (see authorizeReadPath / authorizeRealPath).
  const resolveReadPath = (cwd: string, requestedPath: string): string => {
    const expanded = expandHomePath(requestedPath.trim());
    return path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(cwd, expanded);
  };

  const outsideRootsError = (cwd: string, requestedPath: string, absolutePath: string) =>
    new WorkspaceFileSystemError({
      cwd,
      relativePath: requestedPath,
      operation: "workspaceFileSystem.readFile",
      detail: `Path is outside the allowed read roots (~, temp dir, or project): ${absolutePath}`,
    });

  // Realpath helper: resolve symlinks, falling back to the input when it can't
  // be resolved (e.g. the path doesn't exist).
  const realPathOrSelf = (p: string) =>
    fileSystem.realPath(p).pipe(Effect.orElseSucceed(() => p));

  // Home + OS tempdir are process-invariant, so resolve them and their realpaths
  // once (realpath covers the macOS /var/folders → /private/var/folders and
  // /tmp → /private/tmp aliases). Per-read work then adds only the caller's
  // trusted project roots and the target.
  const baseRoots = allowedReadRoots();
  const baseRealRoots = yield* Effect.forEach(baseRoots, realPathOrSelf);

  // Lexical containment gate, run before any filesystem access so a path outside
  // the sandbox is rejected without leaking whether it exists. Reads are limited
  // to home, the OS temp dir, and the server-trusted project roots — never the
  // client cwd, which is used only to resolve relative paths (see readAccess.ts).
  const authorizeReadPath = Effect.fn("WorkspaceFileSystem.authorizeReadPath")(function* (
    cwd: string,
    requestedPath: string,
    absolutePath: string,
    trustedRoots: readonly string[],
  ) {
    if (!isWithinAllowedRoots(absolutePath, [...baseRoots, ...trustedRoots])) {
      return yield* outsideRootsError(cwd, requestedPath, absolutePath);
    }
  });

  // Symlink-escape gate, run after the file is known to exist: a link inside an
  // allowed root can still point outside it, so re-check the target's realpath
  // against the realpath'd roots.
  const authorizeRealPath = Effect.fn("WorkspaceFileSystem.authorizeRealPath")(function* (
    cwd: string,
    requestedPath: string,
    absolutePath: string,
    trustedRoots: readonly string[],
  ) {
    const realTrustedRoots = yield* Effect.forEach(trustedRoots, realPathOrSelf);
    const realTarget = yield* realPathOrSelf(absolutePath);
    if (
      !isWithinAllowedRoots(realTarget, [
        ...baseRoots,
        ...trustedRoots,
        ...baseRealRoots,
        ...realTrustedRoots,
      ])
    ) {
      return yield* outsideRootsError(cwd, requestedPath, realTarget);
    }
  });

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
  )(function* (input, allowedRoots = []) {
    const absolutePath = resolveReadPath(input.cwd, input.path);
    yield* authorizeReadPath(input.cwd, input.path, absolutePath, allowedRoots);
    yield* statReadableFile(input.cwd, input.path, absolutePath);
    yield* authorizeRealPath(input.cwd, input.path, absolutePath, allowedRoots);
    const contents = yield* readFileStringAt(input.cwd, input.path, absolutePath);
    return { contents, resolvedPath: absolutePath };
  });

  // Per-process LRU of rendered HTML documents, keyed by resolved path and
  // validated against the source file's stat + content hash on each request.
  const htmlCache = createMarkdownHtmlCache();

  const readFileAsHtml: WorkspaceFileSystemShape["readFileAsHtml"] = Effect.fn(
    "WorkspaceFileSystem.readFileAsHtml",
  )(function* (input, allowedRoots = []) {
    const absolutePath = resolveReadPath(input.cwd, input.path);
    yield* authorizeReadPath(input.cwd, input.path, absolutePath, allowedRoots);
    const stat = yield* statReadableFile(input.cwd, input.path, absolutePath);
    const mtimeMs = Option.getOrUndefined(Option.map(stat.mtime, (date) => date.getTime()));
    const size = Number(stat.size);

    const cached = htmlCache.get(absolutePath);
    // Fast path: an unchanged file (same mtime + size) reuses the cached document
    // without reading or hashing — and without the realpath syscalls, since the
    // bytes were already validated when the entry was rendered. Skipped when the
    // platform omits mtime.
    if (
      cached !== undefined &&
      mtimeMs !== undefined &&
      cached.mtimeMs === mtimeMs &&
      cached.size === size
    ) {
      return { html: cached.html, resolvedPath: absolutePath, fromCache: true };
    }

    // Cache miss: run the symlink-escape guard before touching the file bytes.
    yield* authorizeRealPath(input.cwd, input.path, absolutePath, allowedRoots);
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
