// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { ATTACHMENT_UPLOAD_MAX_BYTES, AttachmentUploadError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import { toSafeThreadAttachmentSegment } from "./attachmentStore.ts";

const UPLOADS_SUBDIR = "uploads";
const FILE_NAME_MAX_LENGTH = 255;
const CONTROL_CHAR_MAX_CODE = 0x1f;
const DELETE_CHAR_CODE = 0x7f;

/**
 * Reduce a client-supplied file name to a safe basename: drop any directory components the
 * client may have included, strip path separators and control characters (NUL, and
 * newlines/tabs that would otherwise split a single inserted path across lines), and fall back
 * to "file" when nothing usable remains. Ordinary spaces and printable characters are kept.
 */
export function sanitizeUploadedFileName(rawName: string): string {
  const segments = rawName.split(/[/\\]/);
  const basename = segments[segments.length - 1] ?? "";
  let cleaned = "";
  for (const ch of basename) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= CONTROL_CHAR_MAX_CODE || code === DELETE_CHAR_CODE) {
      continue;
    }
    cleaned += ch;
  }
  cleaned = cleaned.trim();
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    return "file";
  }
  return cleaned.slice(0, FILE_NAME_MAX_LENGTH);
}

/**
 * Compute the absolute path an uploaded attachment will be written to, under
 * `<attachmentsDir>/uploads/<threadSegment>/<uploadId>/<safeName>`. The fresh `uploadId`
 * (a UUID) avoids collisions and preserves the original file name/extension so the path is
 * meaningful to the agent. Returns `null` if the resolved path would escape `attachmentsDir`.
 */
export function resolveUploadedAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly uploadId: string;
  readonly fileName: string;
}): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(input.threadId) ?? "misc";
  const safeName = sanitizeUploadedFileName(input.fileName);
  const relativePath = `${UPLOADS_SUBDIR}/${threadSegment}/${input.uploadId}/${safeName}`;
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath,
  });
}

/**
 * Decode base64 bytes, enforce the size limit, and write them under `attachmentsDir`,
 * returning the absolute path for the agent to Read.
 */
export const writeUploadedAttachment = (input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly fileName: string;
  readonly dataBase64: string;
}): Effect.Effect<{ readonly path: string }, AttachmentUploadError> =>
  Effect.gen(function* () {
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.byteLength === 0) {
      return yield* new AttachmentUploadError({ message: "Uploaded file is empty." });
    }
    if (bytes.byteLength > ATTACHMENT_UPLOAD_MAX_BYTES) {
      return yield* new AttachmentUploadError({
        message: `Uploaded file exceeds the ${ATTACHMENT_UPLOAD_MAX_BYTES} byte limit.`,
      });
    }

    const targetPath = resolveUploadedAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      threadId: input.threadId,
      uploadId: NodeCrypto.randomUUID(),
      fileName: input.fileName,
    });
    if (!targetPath) {
      return yield* new AttachmentUploadError({ message: "Invalid attachment file name." });
    }

    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(NodePath.dirname(targetPath), { recursive: true });
        await NodeFSP.writeFile(targetPath, bytes);
      },
      catch: (cause) =>
        new AttachmentUploadError({ message: "Failed to write uploaded attachment.", cause }),
    });

    return { path: targetPath };
  });
