import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { FilesystemBrowseError, FilesystemBrowseInput } from "./filesystem.ts";

describe("FilesystemBrowseError", () => {
  it("derives a stable message from browse context while retaining the cause", () => {
    const cause = new Error("sensitive filesystem detail");
    const error = new FilesystemBrowseError({
      cwd: "/workspace",
      partialPath: "./src/mai",
      failure: "read_directory_failed",
      parentPath: "/workspace/src",
      cause,
    });

    expect(error.message).toBe("Failed to browse filesystem path './src/mai' from '/workspace'.");
    expect(error.message).not.toContain(cause.message);
    expect(error.cause).toBe(cause);
  });

  it("decodes legacy message-only errors during rolling upgrades", () => {
    const decodeError = Schema.decodeUnknownSync(FilesystemBrowseError);
    const error = decodeError({
      _tag: "FilesystemBrowseError",
      message: "Legacy filesystem browse failure.",
    });

    expect(error.message).toBe("Legacy filesystem browse failure.");
    expect(error.partialPath).toBeUndefined();
    expect(error.failure).toBeUndefined();
  });
});

describe("FilesystemBrowseInput", () => {
  const decode = Schema.decodeUnknownSync(FilesystemBrowseInput);

  it("carries a path with significant trailing whitespace verbatim", () => {
    // `FilesystemBrowseEntry.name` is untrimmed because a folder may be named
    // `reports ` — so the request that lists it has to survive the round trip.
    // A trimming schema does not reject this, it browses a DIFFERENT directory.
    expect(decode({ partialPath: "/tmp/reports /" }).partialPath).toBe("/tmp/reports /");
    expect(decode({ partialPath: "/tmp/x", cwd: "/w/ s " }).cwd).toBe("/w/ s ");
  });

  it("accepts a path longer than any single platform's PATH_MAX floor", () => {
    // A nested node_modules path clears 512 characters without trying.
    const deep = `/${Array.from({ length: 120 }, (_, index) => `segment-${String(index)}`).join("/")}`;
    expect(deep.length).toBeGreaterThan(512);
    expect(decode({ partialPath: deep }).partialPath).toBe(deep);
  });

  it("still refuses an empty path", () => {
    expect(() => decode({ partialPath: "" })).toThrow();
  });
});
