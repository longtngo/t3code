import * as OS from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

// Cap previewable file reads so a stray large file can't be slurped into memory.
const MAX_READ_FILE_BYTES = 2 * 1024 * 1024;

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(OS.homedir(), input.slice(2));
  }
  return input;
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

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

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const expanded = expandHomePath(input.path.trim(), path);
    // Relative paths resolve against cwd; absolute paths (e.g. /var/folders/…,
    // ~/reports/…) are used as-is, intentionally allowing reads outside the root.
    const absolutePath = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(input.cwd, expanded);

    const stat = yield* fileSystem.stat(absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.path,
            operation: "workspaceFileSystem.stat",
            detail: cause.message,
            cause,
          }),
      ),
    );
    if (stat.type !== "File") {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.path,
        operation: "workspaceFileSystem.readFile",
        detail: `Not a file: ${absolutePath}`,
      });
    }
    if (Number(stat.size) > MAX_READ_FILE_BYTES) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.path,
        operation: "workspaceFileSystem.readFile",
        detail: `File is too large to preview (${Number(stat.size)} bytes; max ${MAX_READ_FILE_BYTES}).`,
      });
    }

    const contents = yield* fileSystem.readFileString(absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.path,
            operation: "workspaceFileSystem.readFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    return { contents, resolvedPath: absolutePath };
  });

  return { writeFile, readFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
