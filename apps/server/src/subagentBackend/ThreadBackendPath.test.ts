// @effect-diagnostics nodeBuiltinImport:off - path traversal safety is a Node filesystem boundary.
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodePath from "node:path";

import {
  THREAD_BACKEND_MAX_FILE_NAME_LENGTH,
  threadBackendFileName,
  threadBackendFilePath,
} from "./ThreadBackendPath.ts";

const dir = "/state/subagent-threads";

describe("threadBackendFilePath", () => {
  it("stays inside the threads dir for a traversal-shaped thread id", () => {
    const threadId = ThreadId.make("../../etc/passwd");
    const filePath = threadBackendFilePath(dir, threadId);
    expect(NodePath.dirname(filePath)).toBe(dir);
    expect(NodePath.basename(filePath)).not.toContain("/");
    expect(NodePath.basename(filePath)).not.toContain("..");
  });

  it("is injective for ids that differ only in case or punctuation", () => {
    const a = threadBackendFileName(ThreadId.make("thread-A"));
    const b = threadBackendFileName(ThreadId.make("thread-a"));
    const c = threadBackendFileName(ThreadId.make("thread_A"));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("encodes a non-ASCII id to a plain file name", () => {
    const name = threadBackendFileName(ThreadId.make("线程-🧵"));
    expect(name).toMatch(/^[A-Za-z0-9_-]+\.json$/);
  });

  it("puts the mkdtemp cliff one character past the longest writable name", () => {
    // 182 UTF-8 bytes encode to a 248-character file name; 183 bytes encode to 249.
    const atLimit = threadBackendFileName(ThreadId.make("x".repeat(182)));
    const pastLimit = threadBackendFileName(ThreadId.make("x".repeat(183)));
    expect(atLimit.length).toBe(THREAD_BACKEND_MAX_FILE_NAME_LENGTH);
    expect(pastLimit.length).toBe(THREAD_BACKEND_MAX_FILE_NAME_LENGTH + 1);
  });
});
