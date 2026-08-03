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

  it("explains a sandbox rejection in terms the reader can act on", () => {
    const message = trustedReadErrorMessage(
      PATH,
      new WorkspaceFileSystem.WorkspaceReadOutsideSandboxError({
        requestedPath: PATH,
        resolvedPath: PATH,
      }),
    );
    expect(message).toContain("outside the folders this environment may read");
  });

  it("falls back to a plain read failure for an unknown cause", () => {
    expect(trustedReadErrorMessage(PATH, operationError({ code: "EIO" }))).toBe(
      `Failed to read '${PATH}'.`,
    );
    expect(trustedReadErrorMessage(PATH, operationError(null))).toBe(`Failed to read '${PATH}'.`);
  });
});
