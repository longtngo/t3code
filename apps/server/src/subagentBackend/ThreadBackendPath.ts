/**
 * Where a thread's subagent-offload flag file lives. Pure path arithmetic so the
 * Claude adapter can compute the same path it points `SUBAGENT_BACKEND_STATE` at
 * without importing the writer module.
 *
 * The file name is `encodeBase64Url(threadId)` — the same encoding checkpoint refs and
 * terminal logs use for thread ids — so a client-supplied id with `/` or `..` cannot
 * escape the directory, and two distinct ids never share a file.
 */
import * as Encoding from "effect/Encoding";
import type { ThreadId } from "@t3tools/contracts";

/** The longest file name this module can write: darwin's NAME_MAX of 255 minus the
 * `.XXXXXX` (7) that `writeFileStringAtomically`'s mkdtemp appends to it. Expressed in
 * whole file names, suffix included, so a caller's length check is in the same unit. */
export const THREAD_BACKEND_MAX_FILE_NAME_LENGTH = 248;

export function threadBackendFileName(threadId: ThreadId): string {
  return `${Encoding.encodeBase64Url(threadId)}.json`;
}

/** Total, never throws: an over-long id still yields a path, so the env var can point
 * at a file that will be absent, and the wrapper refuses on it. */
export function threadBackendFilePath(threadsDir: string, threadId: ThreadId): string {
  return `${threadsDir}/${threadBackendFileName(threadId)}`;
}
