import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { TestClock } from "effect/testing";

import { vi } from "vite-plus/test";

import * as ResourceQueueModule from "./ResourceQueue.ts";
import {
  classifyResctl,
  make,
  parseResourceQueue,
  resolveCommand,
  ResourceQueue,
} from "./ResourceQueue.ts";

const GOOD = JSON.stringify({
  maintenance: false,
  resources: { cpu: { capacity: 16, in_use: 0, leases: [], queue: [] } },
});
const run = (stdout: string, exitCode: number, stderrTail = "") => ({
  stdout,
  stderrTail,
  exitCode,
});
const reasonOf = (r: Parameters<typeof classifyResctl>[0]) => {
  const snap = classifyResctl(r, 5);
  return snap.available ? "AVAILABLE" : snap.unavailableReason;
};

describe("parseResourceQueue", () => {
  it("normalizes leases and queues into running/waiting with derived fields", () => {
    const now = 1782096816411;
    const json = JSON.stringify({
      maintenance: false,
      now: 1782096816.4,
      resources: {
        gpu: {
          capacity: 1,
          in_use: 1,
          advisory: false,
          leases: [
            {
              lease_id: "gpu-1",
              amount: 1,
              priority: "normal",
              reason: "atlas release",
              project: "atlas",
              agent: "atlas",
              pid: 18699,
              granted_at: 1782093799.17,
              eta_sec: null,
            },
          ],
          queue: [
            {
              seq: 2,
              amount: 1,
              priority: "background",
              reason: "E8 run",
              project: "sparse-attn-lab",
              agent: "sparse-attn-lab",
              pid: 28502,
              enqueued_at: 1782093929,
              eta_sec: null,
            },
            {
              seq: 8,
              amount: 2,
              priority: "background",
              reason: "E5b run",
              project: "sparse-attn-lab",
              pid: 98639,
              enqueued_at: 1782094831.4,
              eta_sec: 900,
            },
          ],
        },
        cpu: { capacity: 16, in_use: 0, advisory: false, leases: [], queue: [] },
        ram: { capacity: 124, in_use: 0, advisory: true, leases: [], queue: [] },
      },
    });

    const snap = parseResourceQueue(json, now);

    expect(snap.available).toBe(true);
    expect(snap.maintenance).toBe(false);
    expect(snap.ts).toBe(now);

    expect(snap.running).toHaveLength(1);
    expect(snap.running[0]).toMatchObject({
      resource: "gpu",
      state: "running",
      priority: "normal",
      project: "atlas",
      agent: "atlas",
      pid: 18699,
      amount: 1,
    });
    // granted_at seconds → ms
    expect(snap.running[0]?.sinceMs).toBe(1782093799.17 * 1000);

    // queue entries become waiting jobs with 1-based positions per resource
    expect(snap.waiting).toHaveLength(2);
    expect(snap.waiting[0]).toMatchObject({ state: "waiting", pos: 1, pid: 28502 });
    expect(snap.waiting[1]).toMatchObject({ pos: 2, amount: 2, etaSec: 900 });
    // agent omitted on the second entry stays undefined
    expect(snap.waiting[1]?.agent).toBeUndefined();

    // idle-but-provisioned pools are kept (capacity > 0); ram keeps its advisory flag
    expect(snap.resources.find((r) => r.name === "cpu")).toMatchObject({ capacity: 16, inUse: 0 });
    expect(snap.resources.find((r) => r.name === "ram")?.advisory).toBe(true);
  });

  it("drops fully-idle zero-capacity pools and tolerates missing fields", () => {
    const json = JSON.stringify({
      resources: { machine: { capacity: 0, in_use: 0, leases: [], queue: [] } },
    });
    const snap = parseResourceQueue(json, 1000);
    expect(snap.resources).toHaveLength(0);
    expect(snap.running).toHaveLength(0);
    expect(snap.waiting).toHaveLength(0);
    expect(snap.available).toBe(true);
    expect(snap.maintenance).toBe(false);
  });

  it("defaults priority/amount and reads maintenance", () => {
    const json = JSON.stringify({
      maintenance: true,
      resources: {
        gpu: {
          capacity: 1,
          in_use: 1,
          leases: [{ reason: "x", project: "p", pid: 1, granted_at: 5 }],
          queue: [],
        },
      },
    });
    const snap = parseResourceQueue(json, 1000);
    expect(snap.maintenance).toBe(true);
    expect(snap.running[0]).toMatchObject({ priority: "normal", amount: 1, sinceMs: 5000 });
  });
});

describe("classifyResctl", () => {
  it("exit 0 + real snapshot is available", () => {
    const snap = classifyResctl(run(GOOD, 0), 5);
    expect(snap.available).toBe(true);
    expect(snap.unavailableReason).toBeUndefined();
  });
  it("reads the error document before the exit code", () => {
    expect(reasonOf(run('{"error":"daemon_unreachable","event":"error"}', 3))).toBe(
      "broker not running (daemon_unreachable)",
    );
    // error key wins even when the exit code says success
    expect(reasonOf(run('{"error":"daemon_unreachable"}', 0))).toBe(
      "broker not running (daemon_unreachable)",
    );
  });
  it("names any other error document as a resctl error, not a stopped broker", () => {
    expect(reasonOf(run('{"error":"bad_config"}', 1))).toBe("resctl error (bad_config)");
    expect(reasonOf(run('{"error":"  daemon_unreachable  "}', 3))).toBe(
      "broker not running (daemon_unreachable)",
    );
  });
  it("truncates a long error text to 120 characters", () => {
    const reason = reasonOf(run(JSON.stringify({ error: "e".repeat(300) }), 1));
    expect(reason).toBe(`resctl error (${"e".repeat(120)}…)`);
    expect(reasonOf(run(JSON.stringify({ error: "e".repeat(120) }), 1))).toBe(
      `resctl error (${"e".repeat(120)})`,
    );
  });
  it("drops control characters from an error document", () => {
    expect(reasonOf(run(JSON.stringify({ error: "\u001b[31mbad\u0007\u007f\u001b[0m" }), 1))).toBe(
      "resctl error ([31mbad[0m)",
    );
    // only control characters left: blank, so not an error document
    expect(reasonOf(run(JSON.stringify({ error: "\u001b\u0000" }), 0))).toBe(
      "unexpected resctl output",
    );
  });
  it("a blank error and no resources is unexpected output", () => {
    expect(reasonOf(run('{"error":"  "}', 0))).toBe("unexpected resctl output");
  });
  it("names a non-zero exit without the stderr tail", () => {
    const tail = "usage: resctl status: error: unrecognized arguments: --bogus";
    expect(reasonOf(run("", 2, tail))).toBe("resctl exited 2");
    expect(reasonOf(run("", 1, "  \n"))).toBe("resctl exited 1");
    // a valid snapshot on a failing exit is still unavailable
    expect(reasonOf(run(GOOD, 4, "boom"))).toBe("resctl exited 4");
  });
  it.each([
    "null",
    "[]",
    '{"event":"error"}',
    '{"resources":[]}',
    '{"resources":null}',
    "not json",
    "",
  ])("exit 0 without a resources object (%j) is unexpected output", (stdout) => {
    expect(reasonOf(run(stdout, 0))).toBe("unexpected resctl output");
  });
  it("names each spawn failure without the command path", () => {
    expect(reasonOf({ spawnError: "not-found" })).toBe("resctl not found");
    expect(reasonOf({ spawnError: "permission-denied" })).toBe("resctl is not executable");
    expect(reasonOf({ spawnError: "timeout" })).toBe("resctl timed out after 2 s");
    expect(reasonOf({ spawnError: "spawn-failed" })).toBe("resctl could not be started");
    expect(reasonOf({ signal: "SIGKILL" })).toBe("resctl was killed (SIGKILL)");
  });
});

interface Step {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly spawnError?: "NotFound" | "PermissionDenied" | "Unknown";
  readonly never?: boolean;
  readonly stdoutFails?: boolean;
  /** The process started, then this signal ended it. */
  readonly signal?: string;
  /** The exit code fails with this message instead (not a signal). */
  readonly exitFails?: string;
}
const sysError = (tag: "NotFound" | "PermissionDenied" | "Unknown") =>
  PlatformError.systemError({ _tag: tag, module: "ChildProcess", method: "spawn" });

/** The exit-code failure the real spawner raises, method and message included. */
const exitError = (message: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method: "exitCode",
    cause: new Error(message),
  });

/**
 * `spawns.n` counts spawn attempts; `delay` makes every spawn take that long (TestClock);
 * `commands` records each spawned command.
 */
const spawnerFor = (
  steps: Step[],
  spawns = { n: 0 },
  delay?: Duration.Input,
  commands: unknown[] = [],
) => {
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      commands.push(command);
      const step = steps[Math.min(spawns.n++, steps.length - 1)]!;
      if (delay !== undefined) yield* Effect.sleep(delay);
      if (step.spawnError) return yield* sysError(step.spawnError);
      const enc = (t: string | undefined) =>
        t === undefined ? Stream.empty : Stream.make(new TextEncoder().encode(t));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: step.stdoutFails
          ? Stream.fail(sysError("Unknown"))
          : step.never
            ? Stream.never
            : enc(step.stdout),
        stderr: enc(step.stderr),
        all: Stream.empty,
        exitCode: step.never
          ? Effect.never
          : step.signal !== undefined
            ? Effect.fail(
                exitError(`Process interrupted due to receipt of signal: '${step.signal}'`),
              )
            : step.exitFails !== undefined
              ? Effect.fail(exitError(step.exitFails))
              : Effect.succeed(ChildProcessSpawner.ExitCode(step.exitCode ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
};

const withLogs = <A, E>(effect: Effect.Effect<A, E, never>) => {
  const lines: string[] = [];
  const logger = Logger.layer([
    Logger.make(({ message }) => {
      lines.push((Array.isArray(message) ? message : [message]).join(" "));
    }),
  ]);
  return effect.pipe(
    Effect.provide(logger),
    Effect.map((a) => ({ a, lines })),
  );
};

/** The service's `read`, over a spawner that plays `steps`. */
const serviceRead = (
  steps: Step[],
  spawns = { n: 0 },
  delay?: Duration.Input,
  commands: unknown[] = [],
) =>
  make.pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      spawnerFor(steps, spawns, delay, commands),
    ),
    Effect.map((service) => service.read),
  );

describe("resolveCommand", () => {
  it("keeps a bare name a PATH lookup and resolves a path against the given cwd", () => {
    expect(resolveCommand("resctl", "/srv/t3")).toBe("resctl");
    expect(resolveCommand("-res$ctl", "/srv/t3")).toBe("-res$ctl");
    expect(resolveCommand("./bin/resctl", "/srv/t3")).toBe("/srv/t3/bin/resctl");
    expect(resolveCommand("../x y/[r]*", "/srv/t3")).toBe("/srv/x y/[r]*");
    expect(resolveCommand("/opt/resctl", "/srv/t3")).toBe("/opt/resctl");
    // A backslash is a path separator only on Windows; on Linux and macOS it is part of a name.
    expect(resolveCommand("res\\ctl", "/srv/t3")).toBe("res\\ctl");
  });
});

/** Re-imports the module with `T3CODE_RESCTL_CMD` set, which it reads once at load. */
async function importWithResctlCmd(value: string) {
  const before = process.env.T3CODE_RESCTL_CMD;
  process.env.T3CODE_RESCTL_CMD = value;
  vi.resetModules();
  try {
    return await import("./ResourceQueue.ts");
  } finally {
    if (before === undefined) delete process.env.T3CODE_RESCTL_CMD;
    else process.env.T3CODE_RESCTL_CMD = before;
  }
}

describe("ResourceQueue command at module load", () => {
  it.effect("resolves a relative T3CODE_RESCTL_CMD against the startup cwd, once", () =>
    Effect.gen(function* () {
      const commandFor = (value: string) =>
        Effect.gen(function* () {
          const fresh = yield* Effect.promise(() => importWithResctlCmd(value));
          const commands: unknown[] = [];
          yield* fresh.make.pipe(
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              spawnerFor([{ stdout: GOOD }], { n: 0 }, undefined, commands),
            ),
            Effect.flatMap((service) => service.read),
          );
          return (commands[0] as { command: string }).command;
        });
      expect(yield* commandFor("./bin/res ctl")).toBe(`${process.cwd()}/bin/res ctl`);
      expect(yield* commandFor("resctl-dev")).toBe("resctl-dev");
    }),
  );
});

describe("ResourceQueue service", () => {
  it.effect("maps spawn errors by platform reason", () =>
    Effect.gen(function* () {
      const reasonFor = (spawnError: NonNullable<Step["spawnError"]>) =>
        serviceRead([{ spawnError }]).pipe(
          Effect.flatten,
          Effect.map((s) => s.unavailableReason),
        );
      expect(yield* reasonFor("NotFound")).toBe("resctl not found");
      expect(yield* reasonFor("PermissionDenied")).toBe("resctl is not executable");
      expect(yield* reasonFor("Unknown")).toBe("resctl could not be started");
    }),
  );

  it.effect("a resctl ended by a signal is reported killed, not unstartable", () =>
    Effect.gen(function* () {
      const reasonFor = (step: Step) =>
        Effect.flatten(serviceRead([step])).pipe(Effect.map((s) => s.unavailableReason));
      expect(yield* reasonFor({ signal: "SIGKILL" })).toBe("resctl was killed (SIGKILL)");
      expect(yield* reasonFor({ signal: "SIGTERM" })).toBe("resctl was killed (SIGTERM)");
      // Any other exit-code failure names no signal.
      expect(yield* reasonFor({ exitFails: "signal: '$(rm -rf /)'" })).toBe(
        "resctl could not be started",
      );
    }),
  );

  it.effect("runs `resctl status --json --no-spawn` without a working directory", () =>
    Effect.gen(function* () {
      const commands: unknown[] = [];
      yield* Effect.flatten(serviceRead([{ stdout: GOOD }], { n: 0 }, undefined, commands));
      expect(commands).toHaveLength(1);
      const command = commands[0] as {
        command: string;
        args: ReadonlyArray<string>;
        options: { cwd?: string };
      };
      expect([command.command, ...command.args]).toEqual([
        "resctl",
        "status",
        "--json",
        "--no-spawn",
      ]);
      // A deleted server cwd makes `process.cwd()` throw, which read as "could not be started".
      expect(command.options.cwd).toBeUndefined();
    }),
  );

  it.effect("a failing stdout stream reports the spawn-failed reason", () =>
    Effect.gen(function* () {
      const snap = yield* Effect.flatten(serviceRead([{ stdoutFails: true }]));
      expect(snap.unavailableReason).toBe("resctl could not be started");
    }),
  );

  it.effect("times out a wedged resctl", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.flatten(serviceRead([{ never: true }])).pipe(Effect.forkChild);
      yield* TestClock.adjust("3 seconds");
      const snap = yield* Fiber.join(fiber);
      expect(snap.unavailableReason).toBe("resctl timed out after 2 s");
    }),
  );

  it.effect("logs the command and the last 200 bytes of stderr, and sends neither", () =>
    Effect.gen(function* () {
      const stderr = "x".repeat(5000) + "TAIL-END";
      const { a: snap, lines } = yield* withLogs(
        Effect.flatten(serviceRead([{ stderr, exitCode: 2 }])),
      );
      expect(snap.unavailableReason).toBe("resctl exited 2");
      expect(lines).toEqual([
        `resctl unavailable: resctl exited 2 (cmd: resctl, exit 2, stderr: ${"x".repeat(192)}TAIL-END)`,
      ]);
    }),
  );

  it.effect("concurrent reads share one resctl run", () =>
    Effect.gen(function* () {
      const spawns = { n: 0 };
      const read = yield* serviceRead([{ stdout: GOOD }], spawns, "100 millis");
      const fibers = yield* Effect.forEach([read, read, read], (r) => Effect.forkChild(r));
      yield* TestClock.adjust("200 millis");
      const snaps = yield* Effect.forEach(fibers, (f) => Fiber.join(f));
      expect(snaps.map((snap) => snap.available)).toEqual([true, true, true]);
      expect(spawns.n).toBe(1);
    }),
  );

  it.effect("a result is reused for 2 s after it arrives, then read again", () =>
    Effect.gen(function* () {
      const spawns = { n: 0 };
      // A slow resctl (1.5 s): the 2 s window must start when the result arrives, not the request.
      const read = yield* serviceRead([{ stdout: GOOD }], spawns, "1500 millis");
      const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));
      const first = yield* Effect.forkChild(read);
      yield* TestClock.adjust("1500 millis");
      yield* Fiber.join(first);
      yield* TestClock.adjust("1900 millis"); // 3.4 s after the request, 1.9 s after the result
      const cached = yield* Effect.forkChild(read);
      yield* settle;
      expect(spawns.n).toBe(1);
      yield* Fiber.interrupt(cached);
      yield* TestClock.adjust("200 millis"); // 2.1 s after the result
      const second = yield* Effect.forkChild(read);
      yield* settle;
      expect(spawns.n).toBe(2);
      yield* TestClock.adjust("1500 millis");
      expect((yield* Fiber.join(second)).available).toBe(true);
    }),
  );

  it.effect("logs once per reason change, and recovery", () =>
    Effect.gen(function* () {
      const steps: Step[] = [
        { stdout: '{"error":"daemon_unreachable"}', exitCode: 3, stderr: "tb line\nlast" },
        { stdout: '{"error":"daemon_unreachable"}', exitCode: 3, stderr: "tb line\nlast" },
        { stdout: "", exitCode: 2, stderr: "bad flag" },
        { stdout: GOOD },
        { stdout: GOOD },
      ];
      const { a, lines } = yield* withLogs(
        Effect.gen(function* () {
          const svc = yield* ResourceQueue.pipe(
            Effect.provide(
              ResourceQueueModule.layer.pipe(
                Layer.provide(
                  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawnerFor(steps)),
                ),
              ),
            ),
          );
          const out = [];
          for (let n = 0; n < 5; n++) {
            out.push((yield* svc.read).available);
            yield* TestClock.adjust("10 seconds");
          }
          return out;
        }),
      );
      expect(a).toEqual([false, false, false, true, true]);
      expect(lines).toEqual([
        "resctl unavailable: broker not running (daemon_unreachable) (cmd: resctl, exit 3, stderr: tb line last)",
        "resctl unavailable: resctl exited 2 (cmd: resctl, exit 2, stderr: bad flag)",
        "resctl available again after 30s",
      ]);
    }),
  );
});
