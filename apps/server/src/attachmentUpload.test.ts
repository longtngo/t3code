// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AttachmentUploadError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

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
  const tempAttachmentsDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upload-"));

  it.effect("writes decoded bytes and returns the absolute path", () =>
    Effect.gen(function* () {
      const dir = tempAttachmentsDir();
      const bytes = Buffer.from("hello world");
      const result = yield* writeUploadedAttachment({
        attachmentsDir: dir,
        threadId: "thread-1",
        fileName: "greeting.txt",
        dataBase64: bytes.toString("base64"),
      });
      expect(result.path.startsWith(NodePath.resolve(dir))).toBe(true);
      expect(result.path.endsWith("/greeting.txt")).toBe(true);
      expect(NodeFS.readFileSync(result.path)).toEqual(bytes);
    }),
  );

  it.effect("fails with a typed error for an empty payload", () =>
    Effect.gen(function* () {
      const dir = tempAttachmentsDir();
      const error = yield* writeUploadedAttachment({
        attachmentsDir: dir,
        threadId: "thread-1",
        fileName: "empty.bin",
        dataBase64: "",
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(AttachmentUploadError);
    }),
  );

  it.effect("fails with a typed error when the decoded bytes exceed the size limit", () =>
    Effect.gen(function* () {
    const dir = tempAttachmentsDir();
    // 21 MB of zero bytes (limit is 20 MB).
    const tooBig = Buffer.alloc(21 * 1024 * 1024);
    const error = yield* writeUploadedAttachment({
      attachmentsDir: dir,
      threadId: "thread-1",
      fileName: "big.bin",
      dataBase64: tooBig.toString("base64"),
    }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(AttachmentUploadError);
      expect(error.message).toContain("limit");
    }),
  );
});
