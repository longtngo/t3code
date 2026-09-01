import { describe, expect, it } from "@effect/vitest";

import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import { trustedReadErrorMessage } from "./ws.ts";

const PATH = "/tmp/handoff-2026-08-02.md";

function operationError(cause: unknown): WorkspaceFileSystem.WorkspaceFileSystemError {
  return new WorkspaceFileSystem.WorkspaceFileSystemOperationError({
    workspaceRoot: "/tmp",
    relativePath: PATH,
    resolvedPath: PATH,
    operationPath: PATH,
    operation: "realpath-target",
    cause,
  });
}

describe("trustedReadErrorMessage", () => {
  it("says the file is missing rather than blaming the workspace", () => {
    const message = trustedReadErrorMessage(PATH, operationError({ code: "ENOENT" }));
    expect(message).toBe(`File not found: '${PATH}'.`);
    // The old text read "Failed to read workspace file 'X' in 'X'" — the same
    // absolute path twice, which looked like a viewer bug rather than a
    // deleted file.
    expect(message).not.toContain("workspace file");
    expect(message.indexOf(PATH)).toBe(message.lastIndexOf(PATH));
  });

  it("distinguishes permission and directory failures", () => {
    expect(trustedReadErrorMessage(PATH, operationError({ code: "EACCES" }))).toContain(
      "Permission denied",
    );
    expect(trustedReadErrorMessage(PATH, operationError({ code: "EISDIR" }))).toContain(
      "is a directory",
    );
  });

  // The three tagged errors below carry NO `cause`, so a mapper that only reads
  // `cause.code` sends every one of them to the generic fallback. That is not
  // hypothetical: one NUL byte in a report made the viewer answer
  // "Failed to read '<path>'", which read as a server regression and cost a
  // full RCA before the file turned out to be the problem.
  it("names a binary file instead of reporting a generic read failure", () => {
    const message = trustedReadErrorMessage(
      PATH,
      new WorkspaceFileSystem.WorkspaceBinaryFileError({
        workspaceRoot: "/tmp",
        relativePath: PATH,
        resolvedPath: PATH,
      }),
    );
    expect(message).toBe(`'${PATH}' is not text, so it cannot be previewed.`);
    expect(message).not.toContain("Failed to read");
    // Same single-path rule the ENOENT case asserts: no "'X' in 'X'".
    expect(message.indexOf(PATH)).toBe(message.lastIndexOf(PATH));
  });

  it("names a non-file path instead of reporting a generic read failure", () => {
    const message = trustedReadErrorMessage(
      PATH,
      new WorkspaceFileSystem.WorkspacePathNotFileError({
        workspaceRoot: "/tmp",
        relativePath: PATH,
        resolvedPath: PATH,
      }),
    );
    expect(message).toBe(`'${PATH}' is not a regular file.`);
    expect(message.indexOf(PATH)).toBe(message.lastIndexOf(PATH));
  });

  it("falls back to a plain read failure for an unknown cause", () => {
    expect(trustedReadErrorMessage(PATH, operationError({ code: "EIO" }))).toBe(
      `Failed to read '${PATH}'.`,
    );
    expect(trustedReadErrorMessage(PATH, operationError(null))).toBe(`Failed to read '${PATH}'.`);
  });
});
