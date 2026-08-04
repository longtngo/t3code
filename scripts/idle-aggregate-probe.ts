#!/usr/bin/env node --expose-gc

/**
 * Measures whether `Stream.aggregateWithin`'s idle schedule loop retains fiber
 * continuation frames, and prints the heap growth in MB.
 *
 * This runs as its own process on purpose: separating retained frames from
 * ordinary garbage needs a forced GC, and `--expose-gc` cannot be turned on
 * from inside an already-running process.
 *
 * Calibration on the two known builds, 1000 idle ticks/second:
 *   effect 4.0.0-beta.102 (leaking)  ~3.8 MB over the window
 *   effect 4.0.0-beta.103 (fixed)    ~0.02 MB over the window
 */

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const SETTLE = "1 second";
const MEASURE = "4 seconds";

const heapMb = () => {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().heapUsed / 1024 / 1024;
};

// A source that never emits, so every schedule tick takes the idle branch of
// the loop - the path where the leak lived.
const idleAggregate = Stream.fromEffect(Effect.never).pipe(
  // oxlint-disable-next-line t3code/no-unsafe-stream-aggregate -- The banned operator is the subject of the measurement: this probe exists to check whether it still leaks, so it has to call the real thing.
  Stream.groupedWithin(1000, "1 millis"),
  Stream.runDrain,
);

Effect.runFork(idleAggregate);

const program = Effect.gen(function* () {
  yield* Effect.sleep(SETTLE);
  const before = heapMb();
  yield* Effect.sleep(MEASURE);
  const after = heapMb();
  yield* Console.log((after - before).toFixed(3));
});

await Effect.runPromise(program);
process.exit(0);
