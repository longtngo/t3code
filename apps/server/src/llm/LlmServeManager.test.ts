// @effect-diagnostics nodeBuiltinImport:off - the last test reads this module's own source, a property with no runtime observable; see its comment.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

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

// The unload path's premise, measured: without `forceKillAfter`, closing a SIGTERM-ignoring
// process's scope never returns (1s: returned in 1007ms, process dead; omitted: still alive
// at 5000ms). Both must hold: the wait ends AND the process is gone. `it.live` because under
// TestClock the grace never elapses and the test passed with `forceKillAfter` removed.
it.live("reaps a model server that ignores SIGTERM, instead of waiting on it forever", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.make();

    const child = yield* spawner
      .spawn(
        // Must survive SIGTERM to the whole process GROUP (`detached: true`). `trap "" TERM; sleep`
        // is not enough: the group signal kills `sleep` and the shell exits on its own. The loop
        // restarts the sleep so the shell really outlives SIGTERM.
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
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- lets the real shell install its TERM trap; nothing observable marks that point
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

    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- gives the kernel time to reap the SIGKILLed real process before probing its pid
    yield* Effect.sleep(Duration.millis(300));
    assert.isFalse(
      isAlive(pid),
      "the process must actually be dead, not merely abandoned by a timeout",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("bounds the production stop with a real, positive grace period", () => {
  // `undefined` is the option's default and means "wait forever", which is the
  // defect. Zero would SIGKILL a healthy server before it could release its
  // weights cleanly.
  const ms = Duration.toMillis(MODEL_SERVER_FORCE_KILL_AFTER);
  assert.isAbove(ms, 0);
  assert.isBelow(ms, 60_000);
});

// A source-shape guard, because building `LlmServeManager` needs the whole server's layers.
// Measured: deleting `forceKillAfter` from the real spawn leaves the two tests above, the
// logic tests and tsgo all green, so only this pins production.
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
