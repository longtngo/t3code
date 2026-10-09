/**
 * ThreadQueue - the sidebar Queue document, held for every client of this server.
 *
 * A versioned document store. Clients run the queue's rules and write whole
 * states by compare-and-set on (`bootId`, `revision`). The server owns what
 * clients cannot be trusted with: ordering (the revision) and claim times
 * (`claimedAt`, `sendingAt`, `sentAt` come from this server's clock, so every
 * device ages a claim the same way). Every message is the whole document.
 *
 * @module ThreadQueue
 */
import {
  NonNegativeInt,
  ThreadQueueState,
  ThreadQueueWriteError,
  type ThreadQueueDocument,
  type ThreadQueueInFlight,
  type ThreadQueueSetInput,
  type ThreadQueueSetResult,
  type ThreadQueueSnapshot,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "./config.ts";

export const THREAD_QUEUE_FILE_NAME = "thread-queue.json";

/** On disk: the document without `bootId`, which is minted fresh at every start. */
const ThreadQueueFile = Schema.Struct({ revision: NonNegativeInt, ...ThreadQueueState.fields });
const decodeFile = Schema.decodeUnknownExit(Schema.fromJsonString(ThreadQueueFile));
const encodeFile = Schema.encodeSync(Schema.fromJsonString(ThreadQueueFile));

const EMPTY_FILE: typeof ThreadQueueFile.Type = {
  revision: 0,
  entries: [],
  paused: false,
  inFlight: null,
  lastFailure: null,
};

const stateOf = (document: ThreadQueueDocument): ThreadQueueState => ({
  entries: document.entries,
  paused: document.paused,
  inFlight: document.inFlight,
  lastFailure: document.lastFailure,
});

/**
 * Claim times come from this server's clock. The same claim keeps the stamps it
 * was first given; a time arriving for the first time is stamped now. An absent
 * `sendingAt` stays absent: `Equal.equals` compares key sets, so an explicit
 * `undefined` would make a rewrite of the stored claim count as a change.
 */
const stampClaimTimes = (
  current: ThreadQueueInFlight | null,
  next: ThreadQueueInFlight | null,
  now: number,
): ThreadQueueInFlight | null => {
  if (next === null) return null;
  const { sendingAt, ...claim } = next;
  const first = current?.claimId === next.claimId ? current : null;
  const sending = first?.sendingAt ?? (sendingAt === undefined ? undefined : now);
  return {
    ...claim,
    claimedAt: first?.claimedAt ?? now,
    sentAt: first?.sentAt ?? (next.sentAt === null ? null : now),
    ...(sending === undefined ? {} : { sendingAt: sending }),
  };
};

export class ThreadQueueService extends Context.Service<
  ThreadQueueService,
  {
    /** Applies `state` only when `bootId` and `expectedRevision` match the held document. */
    readonly set: (
      input: ThreadQueueSetInput,
    ) => Effect.Effect<ThreadQueueSetResult, ThreadQueueWriteError>;
    /** The current document, then every later revision, each stamped with this server's time when sent. */
    readonly changes: Stream.Stream<ThreadQueueSnapshot>;
  }
>()("t3/threadQueue/ThreadQueueService") {}

/**
 * The stored queue. A missing file is empty; an undecodable one is renamed aside
 * and replaced by empty. A read failure fails the start: the file may be fine.
 */
const loadFile = Effect.fn("ThreadQueue.loadFile")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(filePath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
  );
  if (contents === null) return EMPTY_FILE;
  const decoded = decodeFile(contents);
  if (Exit.isSuccess(decoded)) return decoded.value;
  const keptAt = `${filePath}.corrupt-${yield* Clock.currentTimeMillis}`;
  yield* fs.rename(filePath, keptAt).pipe(Effect.ignore({ log: true }));
  yield* Effect.logError("thread queue file is undecodable; starting empty", {
    path: filePath,
    keptAt,
  });
  return EMPTY_FILE;
});

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const filePath = path.join(stateDir, THREAD_QUEUE_FILE_NAME);

  const stored = yield* loadFile(filePath);
  const bootId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  const document = yield* Ref.make<ThreadQueueDocument>({ bootId, ...stored });
  /** Sliding(1): every message is the whole document, so a slow subscriber needs only the newest. */
  const published = yield* PubSub.sliding<ThreadQueueDocument>(1);
  /** Guards compare, write and publish together, so two writers cannot both pass the compare. */
  const writes = yield* Semaphore.make(1);

  const set = (input: ThreadQueueSetInput) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const held = yield* Ref.get(document);
        const now = yield* Clock.currentTimeMillis;
        if (input.bootId !== held.bootId || input.expectedRevision !== held.revision) {
          return { ok: false, document: held, serverTime: now };
        }
        const state: ThreadQueueState = {
          ...input.state,
          inFlight: stampClaimTimes(held.inFlight, input.state.inFlight, now),
        };
        if (Equal.equals(state, stateOf(held)))
          return { ok: true, document: held, serverTime: now };
        const next: ThreadQueueDocument = {
          bootId: held.bootId,
          revision: held.revision + 1,
          ...state,
        };
        // Once the file is written, memory and subscribers must follow: an interrupt in between
        // would serve a document older than the one the next start loads.
        yield* writeFileStringAtomically({
          filePath,
          contents: encodeFile({ revision: next.revision, ...state }),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError((cause) => new ThreadQueueWriteError({ cause })),
          Effect.andThen(Ref.set(document, next)),
          Effect.andThen(PubSub.publish(published, next)),
          Effect.uninterruptible,
        );
        yield* Effect.logInfo("thread queue written", {
          revision: next.revision,
          entries: next.entries.length,
          claim: `${held.inFlight?.claimId ?? "none"} -> ${next.inFlight?.claimId ?? "none"}`,
          claimOwner: next.inFlight?.entry.ownerId ?? null,
        });
        return { ok: true, document: next, serverTime: now };
      }),
    );

  const stamp = (doc: ThreadQueueDocument) =>
    Effect.map(Clock.currentTimeMillis, (serverTime): ThreadQueueSnapshot => ({
      document: doc,
      serverTime,
    }));

  const changes = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before reading, so a write landing in between is delivered; then
      // drop anything the first emission already covers.
      const subscription = yield* PubSub.subscribe(published);
      const first = yield* Ref.get(document);
      return Stream.concat(
        Stream.make(first),
        Stream.fromSubscription(subscription).pipe(
          Stream.filter((doc) => doc.revision > first.revision),
        ),
      ).pipe(Stream.mapEffect(stamp));
    }),
  );

  return ThreadQueueService.of({ set, changes });
});

export const layer = Layer.effect(ThreadQueueService, make);
