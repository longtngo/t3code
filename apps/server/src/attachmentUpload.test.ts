// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AttachmentUploadError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveUploadedAttachmentPath,
  sanitizeUploadedFileName,
  writeUploadedAttachment,
} from "./attachmentUpload.ts";

describe("sanitizeUploadedFileName", () => {
  it("keeps a normal file name with its extension", () => {
    expect(sanitizeUploadedFileName("report.pdf")).toBe("report.pdf");
  });

  it("strips directory components, keeping only the basename", () => {
    expect(sanitizeUploadedFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeUploadedFileName("C:\\Users\\me\\secret.docx")).toBe("secret.docx");
  });

  it("removes NUL bytes and falls back to 'file' when nothing usable remains", () => {
    expect(sanitizeUploadedFileName("a\0b.txt")).toBe("ab.txt");
    expect(sanitizeUploadedFileName("/")).toBe("file");
    expect(sanitizeUploadedFileName("..")).toBe("file");
    expect(sanitizeUploadedFileName("   ")).toBe("file");
  });

  it("strips control characters so a name can't span multiple lines when inserted", () => {
    // A newline would otherwise split one path into two lines in the composer.
    expect(sanitizeUploadedFileName("a\nb.txt")).toBe("ab.txt");
    expect(sanitizeUploadedFileName("a\r\nb.txt")).toBe("ab.txt");
    expect(sanitizeUploadedFileName("a\tb.txt")).toBe("ab.txt");
  });
});

describe("resolveUploadedAttachmentPath", () => {
  it("places the file under uploads/<threadSegment>/<uploadId>/<name> inside attachmentsDir", () => {
    const resolved = resolveUploadedAttachmentPath({
      attachmentsDir: "/state/attachments",
      threadId: "Thread Folder/Unsafe",
      uploadId: "11111111-1111-1111-1111-111111111111",
      fileName: "notes.md",
    });
    expect(resolved).toBe(
      "/state/attachments/uploads/thread-folder-unsafe/11111111-1111-1111-1111-111111111111/notes.md",
    );
  });

  it("never escapes attachmentsDir even with a hostile file name", () => {
    const resolved = resolveUploadedAttachmentPath({
      attachmentsDir: "/state/attachments",
      threadId: "t",
      uploadId: "22222222-2222-2222-2222-222222222222",
      fileName: "../../../../etc/passwd",
    });
    expect(resolved).toBe(
      "/state/attachments/uploads/t/22222222-2222-2222-2222-222222222222/passwd",
    );
  });
});

describe("writeUploadedAttachment", () => {
  const tempAttachmentsDir = () => mkdtempSync(path.join(os.tmpdir(), "t3-upload-"));

  it("writes decoded bytes and returns the absolute path", async () => {
    const dir = tempAttachmentsDir();
    const bytes = Buffer.from("hello world");
    const result = await Effect.runPromise(
      writeUploadedAttachment({
        attachmentsDir: dir,
        threadId: "thread-1",
        fileName: "greeting.txt",
        dataBase64: bytes.toString("base64"),
      }),
    );
    expect(result.path.startsWith(path.resolve(dir))).toBe(true);
    expect(result.path.endsWith("/greeting.txt")).toBe(true);
    expect(readFileSync(result.path)).toEqual(bytes);
  });

  it("fails with a typed error for an empty payload", async () => {
    const dir = tempAttachmentsDir();
    const error = await Effect.runPromise(
      writeUploadedAttachment({
        attachmentsDir: dir,
        threadId: "thread-1",
        fileName: "empty.bin",
        dataBase64: "",
      }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(AttachmentUploadError);
  });

  it("fails with a typed error when the decoded bytes exceed the size limit", async () => {
    const dir = tempAttachmentsDir();
    // 21 MB of zero bytes (limit is 20 MB).
    const tooBig = Buffer.alloc(21 * 1024 * 1024);
    const error = await Effect.runPromise(
      writeUploadedAttachment({
        attachmentsDir: dir,
        threadId: "thread-1",
        fileName: "big.bin",
        dataBase64: tooBig.toString("base64"),
      }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(AttachmentUploadError);
    expect(error.message).toContain("limit");
  });
});
