// @effect-diagnostics nodeBuiltinImport:off - the last test reads this module's own source, a property with no runtime observable; see its comment.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { MODEL_SERVER_FORCE_KILL_AFTER } from "./LlmServeManager.ts";

const isAlive = (pid: number): boolean => {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH means "no such process". EPERM means it is alive and we simply
    // may not signal it — swallowing that as "dead" makes this report success
    // for a process that is very much still holding its memory.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
};

// This is the premise the manager's unload path rests on, so it is measured
// rather than read out of the option's documentation. With `forceKillAfter`
// unset, closing the scope of a process that ignores SIGTERM never returns, and
// `unload` — plus the shutdown finalizer, which closes the same scopes — hangs
// with it. Measured directly against this fixture:
//
//     forceKillAfter: 1s   close returned after 1007ms, process dead
//     omitted              close had not returned after 5000ms, process alive
//
// A plain timeout on our side would return but leave the process alive holding
// its weights, so both halves have to hold at once: the wait terminates AND the
// process is gone.
//
// Top-level `it.live` with the layer provided explicitly, rather than `it.effect`
// inside `it.layer`: this needs the real clock, and `it.live` is not available on
// the layer-scoped tester. Under the default TestClock the grace period is
// virtual time that never elapses, and an earlier version of this test passed
// identically with `forceKillAfter` removed entirely.
it.live(
  "reaps a model server that ignores SIGTERM, instead of waiting on it forever",
  () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const scope = yield* Scope.make();

      const child = yield* spawner
        .spawn(
          // Survives a SIGTERM delivered to the whole process GROUP, which is
          // what `detached: true` makes the spawner signal. `trap "" TERM; sleep
          // 600` is not enough: the group signal kills the untrapped `sleep`
          // child, the trapping shell falls through and exits on its own, and
          // the escalation is never reached. The loop restarts the sleep, so the
          // shell really does outlive SIGTERM.
          ChildProcess.make("/bin/sh", ["-c", 'trap "" TERM; while true; do sleep 0.2; done'], {
            detached: true,
            shell: false,
            stdout: "ignore",
            stderr: "ignore",
            forceKillAfter: Duration.seconds(1),
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));

      const pid = Number(child.pid);
      yield* Effect.sleep(Duration.millis(300));
      assert.isTrue(isAlive(pid), "the fixture process should be running before we stop it");

      // The live clock, because this test runs under `it.live` — it measures
      // real elapsed wall time, which is the whole point.
      const startedAt = yield* Clock.currentTimeMillis;
      yield* Scope.close(scope, Exit.void);
      const closeMs = (yield* Clock.currentTimeMillis) - startedAt;

      // The close actually waited out the grace period. If this were ~0 the
      // escalation was never exercised and the assertion below would prove
      // nothing — which is exactly how the first version of this test lied.
      assert.isAtLeast(closeMs, 900);

      yield* Effect.sleep(Duration.millis(300));
      assert.isFalse(
        isAlive(pid),
        "the process must actually be dead, not merely abandoned by a timeout",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 30_000 },
);

it("bounds the production stop with a real, positive grace period", () => {
  // `undefined` is the option's default and means "wait forever", which is the
  // defect. Zero would SIGKILL a healthy server before it could release its
  // weights cleanly.
  const ms = Duration.toMillis(MODEL_SERVER_FORCE_KILL_AFTER);
  assert.isAbove(ms, 0);
  assert.isBelow(ms, 60_000);
});

// A source-shape guard, and only because there is no cheaper runtime observable:
// nothing here builds `LlmServeManager` (its layer wants the whole server's
// settings and registry), so the spawn options cannot be captured without a
// harness larger than the thing under test. The convention matches `http.test.ts`.
//
// It exists because the two tests above do NOT pin production. Measured: deleting
// `forceKillAfter` from the real spawn leaves this file and
// `LlmServeManager.logic.test.ts` fully green and `tsgo` at zero errors - the
// mechanism test builds its own fixture, and the constant test only reads the
// constant. Both can pass with the defect reintroduced.
it("passes the grace period to the real model-server spawn", () => {
  const source = NodeFS.readFileSync(new URL("./LlmServeManager.ts", import.meta.url), "utf8");
  const spawnIndex = source.indexOf(".spawn(");
  assert.isAbove(spawnIndex, -1);
  const optionsEnd = source.indexOf("Effect.provideService(Scope.Scope, childScope)", spawnIndex);
  assert.isAbove(optionsEnd, spawnIndex);
  const options = source.slice(spawnIndex, optionsEnd);
  assert.include(options, "forceKillAfter: MODEL_SERVER_FORCE_KILL_AFTER,");
  // Commenting the line out is the likeliest way it gets disabled by accident,
  // and it leaves both the plain `include` above and `tsgo` perfectly happy.
  const live = options
    .split("\n")
    .filter((line) => line.includes("forceKillAfter: MODEL_SERVER_FORCE_KILL_AFTER,"))
    .filter((line) => !line.trim().startsWith("//"));
  assert.lengthOf(live, 1);
});
