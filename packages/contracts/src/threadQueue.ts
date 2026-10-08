/**
 * The sidebar Queue as the primary environment's server holds it. The server
 * stores and versions the document; the queue's rules run in the web client,
 * which writes whole states by compare-and-set on `bootId` + `revision`.
 *
 * @module threadQueue
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

/** A row title snapshot taken at enqueue, shown by devices that cannot render the row. */
export const THREAD_QUEUE_LABEL_MAX_LENGTH = 80;
/** Bounds on what one client can make every other client hold and re-send. */
export const THREAD_QUEUE_MAX_ENTRIES = 500;
/**
 * Generous on purpose: server-derived ids nest encoded ids (an MCP thread id carries a client
 * request id of up to 256 characters, and a run id encodes the thread id again), reaching ~4k.
 */
export const THREAD_QUEUE_ID_MAX_LENGTH = 4096;
/**
 * A claim's prior-state ids are derived from the thread id once more (a run id encodes the
 * thread id), and encodeURIComponent at most triples a string.
 */
export const THREAD_QUEUE_PRIOR_ID_MAX_LENGTH = 3 * THREAD_QUEUE_ID_MAX_LENGTH + 32;
export const THREAD_QUEUE_FAILURE_TITLE_MAX_LENGTH = 500;
export const THREAD_QUEUE_FAILURE_MESSAGE_MAX_LENGTH = 4000;

const boundedString = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));
const QueueId = boundedString(THREAD_QUEUE_ID_MAX_LENGTH);
const PriorId = boundedString(THREAD_QUEUE_PRIOR_ID_MAX_LENGTH);

export const ThreadQueueEntry = Schema.Struct({
  environmentId: EnvironmentId.check(Schema.isMaxLength(THREAD_QUEUE_ID_MAX_LENGTH)),
  /** Drafts pre-allocate their thread id, so the key survives the draft becoming a thread. */
  threadId: ThreadId.check(Schema.isMaxLength(THREAD_QUEUE_ID_MAX_LENGTH)),
  /** Set while the thread is still a draft on its owning device. */
  draftId: Schema.NullOr(QueueId),
  addedAt: Schema.Finite,
  /** The device that queued it: only that device holds the draft, so only it sends. */
  ownerId: QueueId,
  label: Schema.NullOr(boundedString(THREAD_QUEUE_LABEL_MAX_LENGTH)),
});
export type ThreadQueueEntry = typeof ThreadQueueEntry.Type;

export const ThreadQueueInFlight = Schema.Struct({
  entry: ThreadQueueEntry,
  claimId: QueueId,
  /** Stamped by the server's clock; a client's value is never kept. */
  claimedAt: Schema.Finite,
  priorUserMessageAt: Schema.NullOr(PriorId),
  priorTurnId: Schema.NullOr(PriorId),
  priorSessionUpdatedAt: Schema.NullOr(PriorId),
  /** Stamped by the server's clock when the claim first arrives as sent. */
  sentAt: Schema.NullOr(Schema.Finite),
  /** Stamped by the server's clock when the claim first arrives as about to send. Absent until then. */
  sendingAt: Schema.optionalKey(Schema.Finite),
  /** The user sent this thread by hand while it was queued; the claim only holds the slot. Absent otherwise. */
  handSent: Schema.optionalKey(Schema.Literal(true)),
});
export type ThreadQueueInFlight = typeof ThreadQueueInFlight.Type;

export const ThreadQueueFailure = Schema.Struct({
  /** `environmentId:threadId`, two ids and the separator. */
  threadKey: boundedString(THREAD_QUEUE_ID_MAX_LENGTH * 2 + 1),
  title: boundedString(THREAD_QUEUE_FAILURE_TITLE_MAX_LENGTH),
  message: boundedString(THREAD_QUEUE_FAILURE_MESSAGE_MAX_LENGTH),
});
export type ThreadQueueFailure = typeof ThreadQueueFailure.Type;

export const ThreadQueueState = Schema.Struct({
  entries: Schema.Array(ThreadQueueEntry).check(Schema.isMaxLength(THREAD_QUEUE_MAX_ENTRIES)),
  paused: Schema.Boolean,
  inFlight: Schema.NullOr(ThreadQueueInFlight),
  lastFailure: Schema.NullOr(ThreadQueueFailure),
});
export type ThreadQueueState = typeof ThreadQueueState.Type;

export const ThreadQueueDocument = Schema.Struct({
  /** Random per server start: a client always adopts a document from another boot. */
  bootId: Schema.String,
  /** Increases by one per accepted write and continues across restarts. */
  revision: NonNegativeInt,
  ...ThreadQueueState.fields,
});
export type ThreadQueueDocument = typeof ThreadQueueDocument.Type;

export const ThreadQueueSetInput = Schema.Struct({
  bootId: QueueId,
  expectedRevision: NonNegativeInt,
  state: ThreadQueueState,
});
export type ThreadQueueSetInput = typeof ThreadQueueSetInput.Type;

export const ThreadQueueSnapshot = Schema.Struct({
  document: ThreadQueueDocument,
  /** The server's clock when this message was sent. */
  serverTime: Schema.Finite,
});
export type ThreadQueueSnapshot = typeof ThreadQueueSnapshot.Type;

/** `ok: false` means the document moved on; `document` is the current one to re-run against. */
export const ThreadQueueSetResult = Schema.Struct({
  ok: Schema.Boolean,
  ...ThreadQueueSnapshot.fields,
});
export type ThreadQueueSetResult = typeof ThreadQueueSetResult.Type;

export class ThreadQueueWriteError extends Schema.TaggedError<ThreadQueueWriteError>()(
  "ThreadQueueWriteError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "The queue could not be saved.";
  }
}
