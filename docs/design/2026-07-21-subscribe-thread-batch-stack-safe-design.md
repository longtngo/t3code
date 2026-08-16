# subscribeThread activity-batch — stack-safe replacement for the leaking `Stream.groupedWithin` — 2026-07-21

**Branch:** `fix/subscribe-thread-batch-stack-safe`
**Status:** Design (Stage 5) — reviewed (Stage 6, 1 round, all findings applied → this doc is the consolidated result)
**Type:** Defect fix (server OOM). Prior fix (`Stream.take` recycle) FAILED — this is the real fix.

## Goal

Stop the t3code server OOM. The server climbs ~1.9 GB/hr, monotonic, to its 24 GB
V8 ceiling and OOM-crashes every ~13-14 h during long autonomous agent sessions.
Fix without losing the activity-batching bandwidth optimization it provides.

## Root cause (verified — heap forensics + independent RCA agree, source-verified)

`apps/server/src/ws.ts:1034` pipes the `subscribeThread` live event stream through
**`Stream.groupedWithin(64, Duration.millis(20))`** to coalesce event bursts into
one wire frame. That lowers (effect `Stream.js:5595`) to
`aggregateWithin(self, Sink.take(64), Schedule.spaced(20ms))`, whose internal
schedule loop **`stepToBuffer` (effect `Stream.js:5887-5888`) is not stack-safe**:

```js
const stepToBuffer = Effect.suspend(function loop() {
  return step(lastOutput).pipe(
    Effect.flatMap(() => (!sinkHasInput ? loop() : Queue.offer(buffer, scheduleStep))), // recurses here
    Effect.flatMap(() => Effect.never), // this successCont frame never pops
    Pull.catchDone(() => Cause.done()),
  ); // this failureCont frame never pops
});
```

Every 20 ms `Schedule.spaced` tick, while the subscription is **idle**
(`sinkHasInput === false`, the common case between event bursts in a long
session), `loop()` self-recurses **inside** the innermost `flatMap`, so the outer
`flatMap(() => Effect.never)` + `Pull.catchDone` frames stay pinned on the fiber's
continuation `_stack` forever (+1 `successCont`, +1 `failureCont` per tick).
`Effect.never` guarantees that arm never resolves to unwind them.

**Evidence:** two live heap snapshots of the leaking process (pid 29769), 365 s
apart: the `subscribeThread` request fibers' `_stack` grew **161,817 → 191,523**
frames (+81 frames/s ≈ 40 iterations/s — tracks the 20 ms timer, NOT the event
rate), children alternating `~effect/Effect/successCont` / `failureCont`. Heap:
8.4M → 9.9M closures. The arithmetic closes: these ~3 fibers ARE the whole leak.

**Why the prior `Stream.take(20000)` recycle failed:** it bounds _emitted batch
frames_; this leak is per _idle schedule tick_ and grows fastest when **zero**
frames are emitted. Wrong axis — hence the straight-line climb with no sawtooth.

**Blast radius:** `Stream.groupedWithin` / `aggregateWithin` is used in exactly
ONE place in our source — ws.ts:1034 (constants at ws.ts:149-150).

## Approach (chosen — user-selected: local stack-safe batcher)

Replace `Stream.groupedWithin` with a small local coalescer that batches by
**backpressure**, not by a timer — so it runs **zero timers while idle and grows
zero fiber-stack frames**, and coalesces precisely when it helps (a slow socket)
while flushing immediately for a fast one. Mirror the proven, already-shipped
`boundedSubscriberStream.ts` shape (a bounded `Queue` + a scoped forked pump).

New helper `apps/server/src/orchestration/Layers/batchWithinStackSafe.ts`:

```ts
// Stream<A> -> Stream<A[]>: coalesce into <=maxBatch-element batches by
// backpressure. Stack-safe; runs zero timers while idle; memory bounded.
export const batchWithinStackSafe = <A>(
  source: Stream.Stream<A>,
  maxBatch: number, // >= 1; batch size cap (64)
  bufferCapacity: number, // bounded hand-off buffer (backpressure -> upstream drop+resync)
): Stream.Stream<A[]> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Bounded (backpressuring) queue. `Cause.Done` in the error channel lets
      // Queue.end signal clean completion (excluded by Pull => Stream<A[]>).
      const q = yield* Queue.bounded<A, Cause.Done>(bufferCapacity);
      // Pump: drain source arrays into q; end q when source ends OR fails.
      // runForEachArray = Channel.runForEach = Effect.forever/whileLoop
      // (trampolined => constant _stack depth). offerAll on a bounded queue
      // BACKPRESSURES the pump when full (Queue.js:530-540 -> offerRemainingArray),
      // which fills the upstream boundedSubscriberStream buffer -> it drops+ends
      // -> source ends -> Queue.end(q) -> clean stream end -> client resubscribes.
      // ensuring(Queue.end) intentionally maps a source *failure* to clean
      // completion too (same philosophy as boundedSubscriberStream; liveEvents
      // realistically only ends cleanly).
      yield* Effect.forkScoped(
        Stream.runForEachArray(source, (arr) => Queue.offerAll(q, arr)).pipe(
          Effect.ensuring(Queue.end(q)),
        ),
      );
      // Pull: takeBetween(1, maxBatch) blocks for >=1 element (idle => parks on
      // awaitTake, NO timer, trampolined/stack-safe like Queue.take) and returns
      // up to maxBatch of whatever accumulated since the last pull => coalescing
      // is backpressure-driven and self-tuning. On an ended+empty queue it fails
      // with Cause.Done => clean completion (Pull.ExcludeDone). A Closing queue
      // with a buffered tail drains the tail first, so no element is lost.
      // fromPull takes an ACQUIRE effect that resolves to the reused pull.
      const pull = Queue.takeBetween(q, 1, maxBatch).pipe(
        Effect.map((batch) => [batch] as A[][]), // one batch = one downstream element
      );
      return Stream.fromPull(Effect.succeed(pull));
    }),
  );
```

Call site (ws.ts:1028-1036) becomes:

```ts
const liveStreamAfter = (afterSequence: number) =>
  batchWithinStackSafe(
    liveEvents.pipe(
      Stream.filter((event) => event.sequence > afterSequence),
      Stream.filter(isThisThreadEvent),
    ),
    ACTIVITY_BATCH_MAX_EVENTS, // 64 (unchanged)
    ACTIVITY_BATCH_BUFFER_CAPACITY, // new const, 4096 (mirrors WS_SUBSCRIBER_BUFFER)
  ).pipe(Stream.map((events) => ({ kind: "events" as const, events })));
```

`ACTIVITY_BATCH_WINDOW` (the 20 ms `Duration`) is **removed** — no timer. The
`Stream.map` now receives the batch array directly (no `Array.from(chunk)`).

## Why this is stack-safe (the load-bearing proof — source-verified in review)

1. **Pump + output are trampolined.** `Stream.runForEachArray` and `Stream.fromPull`
   are both driven by `Channel.runWith`'s `Effect.forever(Effect.flatMap(pull, f))`
   (effect `Channel.js:3714`); `Effect.forever` = `whileLoop` (`internal/effect.js
:1186`), whose primitive re-pushes _itself_ and returns to constant depth
   (`fiber._stack.push(this)`, effect.js:1827-1841). Each `pull`/pump iteration
   runs on a fresh shallow stack that unwinds on return — **no per-element or
   per-batch frame accumulation**, unlike `stepToBuffer`'s `loop()` self-recursion.
   (Review note: this refutes an earlier memory claim that `runForEachArray` grows
   `_stack` one frame/element — a misattribution; the only leak was `stepToBuffer`.)
2. **Idle = parked, no timer.** With an empty, non-Done queue `takeBetween(q,1,max)`
   returns `undefined` from `takeBetweenUnsafe` and parks on `awaitTake` (effect
   `Queue.js:1091`) — a blocked `Deferred`, zero frame growth, no schedule ticking.
   This is the exact property `groupedWithin` lacked.
3. **Chunk shape.** `fromPull` expects the pull to yield a `NonEmptyReadonlyArray`
   of downstream elements (Stream.d.ts:594). Downstream element = a batch `A[]`, so
   one batch per pull is `[[…batch]]` (`A[][]`), always non-empty. Emits exactly one
   `A[]` per pull; does not flatten or emit events individually.
4. **Clean completion.** `Queue.end` = `failCause(Done())` (Queue.js:749); a take on
   an ended+empty queue fails with `Cause.Done`; `fromPull` erases Done via
   `Pull.ExcludeDone` → clean `Exit.success`, not a transport error — so the WS
   client resubscribes-and-resyncs (it STOPS on a non-transport error). Preserved.
5. **Scope.** `Stream.unwrap` → `Channel.unwrap` runs the acquire with
   `Scope.provide(scope)` (Channel.js:3181) and erases `Scope` from requirements
   (Stream.d.ts:1611), so `Effect.forkScoped` is satisfied and the pump fiber's
   lifetime is tied to the stream scope (interrupted on teardown / on recycle
   re-subscribe, when a fresh queue+pump is built).

## Memory-bounded (no dead-socket OOM regression)

The hand-off queue is **`Queue.bounded`**, not unbounded. If the socket writer
stalls, `fromPull` stops being pulled, `q` fills to `bufferCapacity`, and
`Queue.offerAll` in the pump backpressures (Queue.js:530-540 → `offerRemainingArray`).
Memory is bounded at `bufferCapacity` here + the upstream 4096 buffer, in both
teardown cases:

- **Slow-but-alive consumer:** its draining lets the pump make progress, the
  upstream `boundedSubscriberStream` eventually drops+ends, the source stream ends,
  `ensuring(Queue.end)` ends `q`, and the stream completes cleanly → resubscribe.
- **Fully dead socket** (the original OOM trigger): the pump stays _parked_ in
  `offerAll` on a full `q` (bounded, not growing) and never observes source-end on
  its own; final reclaim comes from the WS transport's dead-socket detection
  tearing down the RPC scope, which interrupts the parked pump. Reclaim is via
  transport teardown, not the internal chain — but memory stays bounded throughout,
  which is the property that matters (and is no worse than `boundedSubscriberStream`
  alone).

(An unbounded queue here would have re-opened the exact OOM this fix closes —
caught in review.)

## Semantics vs. `groupedWithin(64, 20ms)`

- **Coalescing:** backpressure-driven. Events accumulate in `q` exactly when they
  arrive faster than the consumer can send them (a slow/bandwidth-constrained
  client, or a dense burst outrunning the round-trip); the next `takeBetween`
  returns them as one ≤64 batch. For a client that keeps up event-for-event,
  batches are size-1 with **0 added latency** (vs. `groupedWithin`'s 0-20 ms tax).
  This _dominates_ the fixed window: it batches at least as aggressively exactly
  when bandwidth matters, and adds no latency when it doesn't.
- **Cap:** `takeBetween(_, 1, 64)` returns ≤64; a >64 backlog yields the next ≤64
  on the following pull. No loss, no overflow handling.
- **Ordering:** FIFO (single queue, single pump, single consumer).
- **Non-empty:** every batch is ≥1 element, so `events: []` is never emitted (same
  as `groupedWithin`, which never flushes an empty chunk).

## Files touched

- `apps/server/src/orchestration/Layers/batchWithinStackSafe.ts` (new, ~35 LOC +
  doc) — the helper. Guard `maxBatch >= 1`.
- `apps/server/src/orchestration/Layers/batchWithinStackSafe.test.ts` (new) —
  tests (see below).
- `apps/server/src/ws.ts` (~12 LOC) — swap `Stream.groupedWithin` for
  `batchWithinStackSafe`; add `ACTIVITY_BATCH_BUFFER_CAPACITY = 4096`; remove
  `ACTIVITY_BATCH_WINDOW`; drop `Array.from`.

## Test plan (unit) — must include the two bugs review caught

1. **Coalescing works:** feed a burst while the consumer is paused; assert a pull
   returns a `>1`-element batch (would have caught the inert `takeBetween(0,…)`).
2. **Cap:** a burst of `>maxBatch` yields batches of ≤maxBatch, no loss, in order.
3. **Isolated event:** a single event flushes as `[e]` promptly.
4. **Memory bounded on stalled consumer:** source keeps producing while nothing
   pulls; assert the queue does not grow past `bufferCapacity` (pump parks) —
   would have caught the unbounded-queue OOM regression.
5. **Clean completion:** when source ends, the buffered tail is delivered, then the
   stream ends via `Exit.success` (no element lost, no surfaced error).
6. **Idle no-growth / stack-safety:** long idle then bursty; the driving fiber does
   not accumulate stack (bounded runtime / proxy metric).
7. Ordering (FIFO) across interleaved offer/take.

## Tradeoffs and known limitations

- One bounded `Queue` + one forked fiber per active `subscribeThread` subscription
  (same cost shape as `boundedSubscriberStream`). Negligible.
- The upstream effect `aggregateWithin` bug remains for any _future_ use of
  `groupedWithin`/`aggregate` — see follow-ups.
- No fixed 20 ms window: isolated events on a fast client flush immediately
  (better latency); this is a behavior change, judged strictly better (above).

## Follow-ups deferred

1. **Report the upstream effect `aggregateWithin` stack-safety bug** (Stream.js
   :5887) to effect maintainers with the minimal repro. Non-blocking; effort XS.
2. **Guard against re-introducing `Stream.groupedWithin`/`aggregate`** in server
   code (grep check or ESLint no-restricted-syntax) so this class can't silently
   return. Effort S.

## Verification plan (definitive step is live, not unit)

Unit tests prove semantics + the idle-no-growth + memory-bound properties. The
DEFINITIVE confirmation is the live heap trend: after deploy, watch one long
autonomous session via `~/.t3-oom-watch/watch.log` — the heap must **plateau/
sawtooth**, not climb monotonically. A post-deploy heap snapshot must show the
`subscribeThread` fibers' `_stack` staying small (not 160K+). Same instrument that
diagnosed the leak; it is the pass/fail gate before "done."

## Stage 6 design-review outcome (1 round, quiescent)

Two parallel opus reviewers (correctness+stack-safety; simplicity+compat), both
source-verified. Confirmed correct: root cause, trampolining, chunk shape, clean
completion, scope wiring, blast radius, wire/client compatibility (frame shape
identical; client consumers at `apps/web/.../service.ts:475` and
`packages/client-runtime/.../threadDetailState.ts:257` unchanged; no empty-batch
risk). Three blocking defects in the first sketch — `Queue.unbounded` (OOM
regression), `Stream.fromPull` shape, inert `takeBetween(0,…)` — all resolved by
adopting the timer-free backpressure realization above (both reviewers'
recommendation converged on it). No open findings.
