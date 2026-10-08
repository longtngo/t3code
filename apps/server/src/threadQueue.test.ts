import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ThreadQueueEntry, ThreadQueueInFlight, ThreadQueueState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "./config.ts";
import * as ThreadQueue from "./threadQueue.ts";

const entry = (id: string, ownerId = "device-a"): ThreadQueueEntry => ({
  environmentId: "env-1" as ThreadQueueEntry["environmentId"],
  threadId: id as ThreadQueueEntry["threadId"],
  draftId: null,
  addedAt: 1,
  ownerId,
  label: id,
});
const claim = (
  id: string,
  claimId: string,
  times: { readonly claimedAt: number; readonly sentAt: number | null },
): ThreadQueueInFlight => ({
  entry: entry(id),
  claimId,
  priorUserMessageAt: null,
  priorTurnId: null,
  priorSessionUpdatedAt: null,
  ...times,
});
const state = (overrides: Partial<ThreadQueueState> = {}): ThreadQueueState => ({
  entries: [],
  paused: false,
  inFlight: null,
  lastFailure: null,
  ...overrides,
});

/** Runs `body` against a service started on `baseDir`, as a server start would. */
const withQueue = <A, E, R>(baseDir: string, body: Effect.Effect<A, E, R>) =>
  body.pipe(
    Effect.provide(
      ThreadQueue.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
    ),
  );

const current = Effect.gen(function* () {
  const queue = yield* ThreadQueue.ThreadQueueService;
  return Option.getOrThrow(yield* Stream.runHead(queue.changes));
});

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3code-thread-queue-" });
});

it.layer(NodeServices.layer)("thread queue service", (it) => {
  it.effect("starts empty at revision 0 when there is no file", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const { document } = yield* withQueue(dir, current);
      assert.strictEqual(document.revision, 0);
      assert.deepEqual(document.entries, []);
      assert.isNull(document.inFlight);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a stale revision or another boot, returning the current document", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      yield* withQueue(
        dir,
        Effect.gen(function* () {
          const queue = yield* ThreadQueue.ThreadQueueService;
          const { document } = yield* current;
          const staleRevision = yield* queue.set({
            bootId: document.bootId,
            expectedRevision: 5,
            state: state({ entries: [entry("A")] }),
          });
          assert.isFalse(staleRevision.ok);
          assert.strictEqual(staleRevision.document.revision, 0);
          const otherBoot = yield* queue.set({
            bootId: "another-boot",
            expectedRevision: 0,
            state: state({ entries: [entry("A")] }),
          });
          assert.isFalse(otherBoot.ok);
          assert.deepEqual(otherBoot.document.entries, []);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("two writers claiming from the same revision: exactly one wins", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      yield* withQueue(
        dir,
        Effect.gen(function* () {
          const queue = yield* ThreadQueue.ThreadQueueService;
          const { document } = yield* current;
          const seeded = yield* queue.set({
            bootId: document.bootId,
            expectedRevision: 0,
            state: state({ entries: [entry("A")] }),
          });
          const claimFrom = (claimId: string) =>
            queue.set({
              bootId: document.bootId,
              expectedRevision: seeded.document.revision,
              state: state({ inFlight: claim("A", claimId, { claimedAt: 0, sentAt: null }) }),
            });
          const results = yield* Effect.all([claimFrom("tab-1"), claimFrom("tab-2")], {
            concurrency: "unbounded",
          });
          assert.strictEqual(results.filter((result) => result.ok).length, 1);
          const winner = results.find((result) => result.ok)!;
          const { document: after } = yield* current;
          assert.strictEqual(after.inFlight?.claimId, winner.document.inFlight?.claimId);
          assert.strictEqual(after.revision, 2);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a write survives a restart, under a new bootId with the revision continued", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const before = yield* withQueue(
        dir,
        Effect.gen(function* () {
          const queue = yield* ThreadQueue.ThreadQueueService;
          const { document } = yield* current;
          const written = yield* queue.set({
            bootId: document.bootId,
            expectedRevision: 0,
            state: state({ entries: [entry("A")], paused: true }),
          });
          assert.isTrue(written.ok);
          return written.document;
        }),
      );
      const { document: after } = yield* withQueue(dir, current);
      assert.notStrictEqual(after.bootId, before.bootId);
      assert.strictEqual(after.revision, 1);
      assert.deepEqual(after.entries, before.entries);
      assert.isTrue(after.paused);
    }).pipe(Effect.scoped),
  );

  it.effect("an undecodable file starts empty and is kept aside", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      const { stateDir } = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), dir)),
      );
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, ThreadQueue.THREAD_QUEUE_FILE_NAME),
        "{not json",
      );

      const { document } = yield* withQueue(dir, current);
      assert.strictEqual(document.revision, 0);
      assert.deepEqual(document.entries, []);
      const aside = (yield* fs.readDirectory(stateDir)).filter((name) =>
        name.startsWith(`${ThreadQueue.THREAD_QUEUE_FILE_NAME}.corrupt-`),
      );
      assert.strictEqual(aside.length, 1);
      assert.strictEqual(yield* fs.readFileString(path.join(stateDir, aside[0]!)), "{not json");
    }).pipe(Effect.scoped),
  );

  it.effect("claim and landing times are this server's clock, whatever the client sent", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      yield* withQueue(
        dir,
        Effect.gen(function* () {
          const queue = yield* ThreadQueue.ThreadQueueService;
          yield* TestClock.setTime(1_000_000);
          const { document } = yield* current;
          // A client 10 minutes ahead sends its own clock.
          const claimed = yield* queue.set({
            bootId: document.bootId,
            expectedRevision: 0,
            state: state({ inFlight: claim("A", "c1", { claimedAt: 1_600_000, sentAt: null }) }),
          });
          assert.strictEqual(claimed.document.inFlight?.claimedAt, 1_000_000);
          assert.strictEqual(claimed.serverTime, 1_000_000);

          yield* TestClock.adjust("5 seconds");
          // A client 10 minutes behind marks it sent; the claim keeps its first stamp.
          const sent = yield* queue.set({
            bootId: document.bootId,
            expectedRevision: 1,
            state: state({ inFlight: claim("A", "c1", { claimedAt: 0, sentAt: 400_000 }) }),
          });
          assert.strictEqual(sent.document.inFlight?.claimedAt, 1_000_000);
          assert.strictEqual(sent.document.inFlight?.sentAt, 1_005_000);

          // A client connecting an hour later is told the server's time now.
          yield* TestClock.adjust("1 hour");
          const late = yield* current;
          assert.strictEqual(late.serverTime, 1_005_000 + 3_600_000);
          assert.strictEqual(late.document.inFlight?.claimedAt, 1_000_000);

          // A new claim is stamped now.
          const next = yield* queue.set({
            bootId: document.bootId,
            expectedRevision: 2,
            state: state({ inFlight: claim("B", "c2", { claimedAt: 7, sentAt: 7 }) }),
          });
          assert.strictEqual(next.document.inFlight?.claimedAt, 1_005_000 + 3_600_000);
          assert.strictEqual(next.document.inFlight?.sentAt, 1_005_000 + 3_600_000);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("streams the current document, then only real changes", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      yield* withQueue(
        dir,
        Effect.gen(function* () {
          const queue = yield* ThreadQueue.ThreadQueueService;
          const seen = yield* Queue.unbounded<number>();
          yield* Stream.runForEach(queue.changes, (snapshot) =>
            Queue.offer(seen, snapshot.document.revision),
          ).pipe(Effect.forkScoped);
          assert.strictEqual(yield* Queue.take(seen), 0);

          const { document } = yield* current;
          const once = state({ inFlight: claim("A", "c1", { claimedAt: 0, sentAt: null }) });
          assert.strictEqual(
            (yield* queue.set({ bootId: document.bootId, expectedRevision: 0, state: once }))
              .document.revision,
            1,
          );
          assert.strictEqual(yield* Queue.take(seen), 1);

          // The same state again, with different client times: accepted, not written, not published.
          const again = yield* queue.set({
            bootId: document.bootId,
            expectedRevision: 1,
            state: state({ inFlight: claim("A", "c1", { claimedAt: 99, sentAt: null }) }),
          });
          assert.isTrue(again.ok);
          assert.strictEqual(again.document.revision, 1);

          yield* queue.set({
            bootId: document.bootId,
            expectedRevision: 1,
            state: state({ paused: true }),
          });
          // The next publication is revision 2: the no-op published nothing.
          assert.strictEqual(yield* Queue.take(seen), 2);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("the about-to-send stamp is this server's clock and keeps its first value", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      yield* withQueue(
        dir,
        Effect.gen(function* () {
          const queue = yield* ThreadQueue.ThreadQueueService;
          yield* TestClock.setTime(1_000_000);
          const { document } = yield* current;
          const claimed = yield* queue.set({
            bootId: document.bootId,
            expectedRevision: 0,
            state: state({ inFlight: claim("A", "c1", { claimedAt: 0, sentAt: null }) }),
          });
          assert.isFalse("sendingAt" in claimed.document.inFlight!);

          yield* TestClock.adjust("2 seconds");
          const sending = yield* queue.set({
            bootId: document.bootId,
            expectedRevision: 1,
            state: state({
              inFlight: { ...claim("A", "c1", { claimedAt: 0, sentAt: null }), sendingAt: 7 },
            }),
          });
          assert.strictEqual(sending.document.inFlight?.sendingAt, 1_002_000);

          yield* TestClock.adjust("3 seconds");
          const sent = yield* queue.set({
            bootId: document.bootId,
            expectedRevision: 2,
            state: state({
              inFlight: { ...claim("A", "c1", { claimedAt: 0, sentAt: 9 }), sendingAt: 99 },
            }),
          });
          assert.strictEqual(sent.document.inFlight?.sendingAt, 1_002_000);
          assert.strictEqual(sent.document.inFlight?.sentAt, 1_005_000);

          const next = yield* queue.set({
            bootId: document.bootId,
            expectedRevision: 3,
            state: state({
              inFlight: { ...claim("B", "c2", { claimedAt: 0, sentAt: null }), sendingAt: 7 },
            }),
          });
          assert.strictEqual(next.document.inFlight?.sendingAt, 1_005_000);
        }),
      );
    }).pipe(Effect.scoped),
  );

  // Ruling 11: an absent optional key must stay absent, or the stored claim never equals a rewrite.
  it.effect("the same claim written again after a restart is not a change", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const written = state({ inFlight: claim("A", "c1", { claimedAt: 0, sentAt: null }) });
      yield* withQueue(
        dir,
        Effect.gen(function* () {
          const queue = yield* ThreadQueue.ThreadQueueService;
          const { document } = yield* current;
          yield* queue.set({ bootId: document.bootId, expectedRevision: 0, state: written });
        }),
      );
      yield* withQueue(
        dir,
        Effect.gen(function* () {
          const queue = yield* ThreadQueue.ThreadQueueService;
          const { document } = yield* current;
          const again = yield* queue.set({
            bootId: document.bootId,
            expectedRevision: 1,
            state: written,
          });
          assert.isTrue(again.ok);
          assert.strictEqual(again.document.revision, 1);
        }),
      );
    }).pipe(Effect.scoped),
  );

  // Ruling 12
  it.effect("a file that cannot be read fails the start and is left in place", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      const { stateDir } = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), dir)),
      );
      // A directory where the file belongs: it exists, and reading it fails.
      const filePath = path.join(stateDir, ThreadQueue.THREAD_QUEUE_FILE_NAME);
      yield* fs.makeDirectory(filePath, { recursive: true });

      const started = yield* Effect.exit(withQueue(dir, current));
      assert.isTrue(Exit.isFailure(started));
      assert.isTrue((yield* fs.stat(filePath)).type === "Directory");
      const aside = (yield* fs.readDirectory(stateDir)).filter((name) =>
        name.startsWith(`${ThreadQueue.THREAD_QUEUE_FILE_NAME}.corrupt-`),
      );
      assert.deepEqual(aside, []);
    }).pipe(Effect.scoped),
  );

  it.effect("an interrupted write never leaves the file ahead of the document it serves", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      const renamed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // The write has landed on disk; the set is interrupted before it can go on.
      const stalling = FileSystem.FileSystem.of({
        ...fs,
        rename: (from: string, to: string) =>
          fs
            .rename(from, to)
            .pipe(
              Effect.andThen(Deferred.succeed(renamed, undefined)),
              Effect.andThen(Deferred.await(release)),
            ),
      });
      const { onDisk, held } = yield* withQueue(
        dir,
        Effect.gen(function* () {
          const queue = yield* ThreadQueue.ThreadQueueService;
          const { document } = yield* current;
          const fiber = yield* Effect.forkChild(
            queue.set({
              bootId: document.bootId,
              expectedRevision: 0,
              state: state({ entries: [entry("A")] }),
            }),
          );
          yield* Deferred.await(renamed);
          yield* Effect.sync(() => fiber.interruptUnsafe());
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.await(fiber);
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const file = yield* fs.readFileString(
            path.join(stateDir, ThreadQueue.THREAD_QUEUE_FILE_NAME),
          );
          return {
            onDisk: (JSON.parse(file) as { revision: number }).revision,
            held: (yield* current).document,
          };
        }),
      ).pipe(Effect.provideService(FileSystem.FileSystem, stalling));
      assert.strictEqual(onDisk, 1);
      assert.strictEqual(held.revision, onDisk);
      assert.deepEqual(
        held.entries.map((queued) => queued.threadId),
        ["A"],
      );
    }).pipe(Effect.scoped),
  );
});
