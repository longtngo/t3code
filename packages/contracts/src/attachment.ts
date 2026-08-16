import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Upper bound on the raw byte size of a file uploaded as a path reference (the web/remote
// fallback for non-image drops, where the browser can't expose a local path). base64
// transport inflates this by ~33%.
export const ATTACHMENT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

const ATTACHMENT_UPLOAD_FILE_NAME_MAX_LENGTH = 255;
// Coarse upper bound on the base64 string: base64 is always < 4/3 the byte size, so 2x is a
// safe over-estimate. The authoritative size check is the decoded-byte check on the server.
const ATTACHMENT_UPLOAD_DATA_MAX_LENGTH = ATTACHMENT_UPLOAD_MAX_BYTES * 2;

export const AttachmentUploadInput = Schema.Struct({
  threadId: ThreadId,
  fileName: TrimmedNonEmptyString.check(Schema.isMaxLength(ATTACHMENT_UPLOAD_FILE_NAME_MAX_LENGTH)),
  dataBase64: TrimmedNonEmptyString.check(Schema.isMaxLength(ATTACHMENT_UPLOAD_DATA_MAX_LENGTH)),
});
export type AttachmentUploadInput = typeof AttachmentUploadInput.Type;

export const AttachmentUploadResult = Schema.Struct({
  // Absolute filesystem path on the agent host where the bytes were written.
  path: TrimmedNonEmptyString,
});
export type AttachmentUploadResult = typeof AttachmentUploadResult.Type;

export class AttachmentUploadError extends Schema.TaggedErrorClass<AttachmentUploadError>()(
  "AttachmentUploadError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
