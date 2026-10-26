import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ATTACHMENT_UPLOAD_MAX_BYTES, AttachmentUploadInput } from "./attachment.ts";
import { ThreadId } from "./baseSchemas.ts";

/**
 * These bounds are all that stops an unbounded string from a remote client, so pin them here.
 * Asserted via `decode`, not `Schema.is`: `TrimmedNonEmptyString` trims then checks, and `is` never
 * runs the trim, so it calls a whitespace-only name valid.
 */
const decodeUploadInput = Schema.decodeUnknownSync(AttachmentUploadInput);
const accepts = (input: unknown): boolean => {
  try {
    decodeUploadInput(input);
    return true;
  } catch {
    return false;
  }
};

const uploadInput = {
  threadId: ThreadId.make("thread-1"),
  fileName: "notes.pdf",
  dataBase64: "ZmFrZQ==",
} as const;

describe("AttachmentUploadInput", () => {
  it("accepts a well-formed upload", () => {
    expect(accepts(uploadInput)).toBe(true);
  });

  it("rejects an empty or whitespace-only file name", () => {
    expect(accepts({ ...uploadInput, fileName: "" })).toBe(false);
    expect(accepts({ ...uploadInput, fileName: "   " })).toBe(false);
  });

  it("rejects an empty or whitespace-only payload", () => {
    expect(accepts({ ...uploadInput, dataBase64: "" })).toBe(false);
    expect(accepts({ ...uploadInput, dataBase64: "   " })).toBe(false);
  });

  it("bounds the file name at 255 characters", () => {
    // Both sides of the boundary, so the test fails if the limit moves either way
    // rather than only if the check disappears.
    expect(accepts({ ...uploadInput, fileName: "a".repeat(255) })).toBe(true);
    expect(accepts({ ...uploadInput, fileName: "a".repeat(256) })).toBe(false);
  });

  it("bounds the base64 payload at twice the raw byte limit", () => {
    // base64 is always under 4/3 of the byte size, so 2x is a deliberate
    // over-estimate; the authoritative check is on decoded bytes server-side.
    const limit = ATTACHMENT_UPLOAD_MAX_BYTES * 2;
    expect(accepts({ ...uploadInput, dataBase64: "a".repeat(limit) })).toBe(true);
    expect(accepts({ ...uploadInput, dataBase64: "a".repeat(limit + 1) })).toBe(false);
  });

  it("requires every field", () => {
    const { threadId: _threadId, ...noThread } = uploadInput;
    const { fileName: _fileName, ...noName } = uploadInput;
    const { dataBase64: _data, ...noData } = uploadInput;
    expect(accepts(noThread)).toBe(false);
    expect(accepts(noName)).toBe(false);
    expect(accepts(noData)).toBe(false);
  });
});
