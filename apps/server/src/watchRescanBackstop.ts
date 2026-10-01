import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export const WATCH_RESCAN_INTERVAL = Duration.seconds(30);

/**
 * macOS fseventsd drops directory events under load with no drop flag, so the settings,
 * keybindings and theme watchers can miss an edit indefinitely. Re-checks each source on a
 * slow timer; each step dedupes, so an unchanged file publishes nothing.
 * Forked from serverRuntimeStartup, never inside a layer (TestClock wedge, docs/fork/README.md).
 */
export const runWatchRescanBackstop = <E>(steps: ReadonlyArray<Effect.Effect<unknown, E>>) =>
  Effect.forever(
    Effect.gen(function* () {
      yield* Effect.sleep(WATCH_RESCAN_INTERVAL);
      for (const step of steps) yield* step.pipe(Effect.ignoreCause({ log: true }));
    }),
  );
