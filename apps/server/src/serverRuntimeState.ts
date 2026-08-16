import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import type * as ServerConfig from "./config.ts";
import { formatHostForUrl, isWildcardHost } from "./startupAccess.ts";

export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  // Present when the server fronts a dev web server (VITE_DEV_SERVER_URL).
  // Dev is single-origin: browsers must pair through this URL, not `origin`.
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

export class ServerRuntimeStateError extends Schema.TaggedErrorClass<ServerRuntimeStateError>()(
  "ServerRuntimeStateError",
  {
    operation: Schema.Literals(["persist", "read", "decode", "clear"]),
    statePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} server runtime state at ${this.statePath}.`;
  }
}

const decodePersistedServerRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

const runtimeOriginForConfig = (
  config: Pick<ServerConfig.ServerConfig["Service"], "host">,
  port: number,
): PersistedServerRuntimeState["origin"] => {
  const hostname =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
  return `http://${hostname}:${port}`;
};

export const makePersistedServerRuntimeState = (input: {
  readonly config: Pick<ServerConfig.ServerConfig["Service"], "host" | "devUrl">;
  readonly port: number;
}): Effect.Effect<PersistedServerRuntimeState> =>
  Effect.map(DateTime.now, (now) => ({
    version: 1,
    pid: process.pid,
    ...(input.config.host ? { host: input.config.host } : {}),
    port: input.port,
    origin: runtimeOriginForConfig(input.config, input.port),
    ...(input.config.devUrl ? { devUrl: input.config.devUrl.toString() } : {}),
    startedAt: DateTime.formatIso(now),
  }));

export const persistServerRuntimeState = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) =>
  writeFileStringAtomically({
    filePath: input.path,
    contents: `${JSON.stringify(input.state)}\n`,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ServerRuntimeStateError({
          operation: "persist",
          statePath: input.path,
          cause,
        }),
    ),
  );

export const clearPersistedServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(path, { force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "clear",
            statePath: path,
            cause,
          }),
      ),
      Effect.catchTags({
        ServerRuntimeStateError: (error) =>
          Effect.logWarning(error.message).pipe(
            Effect.annotateLogs({
              operation: error.operation,
              statePath: error.statePath,
              cause: error,
            }),
          ),
      }),
    );
  });

export const readPersistedServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new ServerRuntimeStateError({
                  operation: "read",
                  statePath: path,
                  cause,
                }),
              ),
        onSuccess: (contents) => Effect.succeed(Option.some(contents)),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<PersistedServerRuntimeState>();
    }

    const trimmed = raw.value.trim();
    if (trimmed.length === 0) {
      return Option.none<PersistedServerRuntimeState>();
    }

    return yield* decodePersistedServerRuntimeState(trimmed).pipe(
      Effect.map(Option.some),
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "decode",
            statePath: path,
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.catchTags({
      ServerRuntimeStateError: (error) =>
        Effect.logWarning(error.message).pipe(
          Effect.annotateLogs({
            operation: error.operation,
            statePath: error.statePath,
            cause: error,
          }),
          Effect.as(Option.none<PersistedServerRuntimeState>()),
        ),
    }),
  );

/**
 * A boot that dies sooner than this looks like a crash loop rather than a
 * one-off fault, and is reported at error level so it stands out in the log.
 */
export const crashLoopUptimeThresholdMillis = 5 * 60 * 1_000;

/**
 * What the leftover state file says about how the previous process ended. The
 * file is written once the server is serving and removed by its release
 * finalizer, so finding one at boot means the previous process never ran that
 * finalizer: it crashed, was killed, or the machine went down under it.
 */
export type PreviousShutdownDiagnosis =
  | { readonly _tag: "clean" }
  | { readonly _tag: "concurrent"; readonly pid: number }
  | {
      readonly _tag: "unclean";
      readonly pid: number;
      readonly startedAt: string;
      /**
       * How long ago the dead process started. It is an upper bound on that
       * process's lifetime — we know when it booted, not when it died — but a
       * supervisor that restarts on exit closes that gap to seconds.
       */
      readonly previousBootAgeMillis: number | undefined;
      readonly crashLoopSuspected: boolean;
    };

// Signal 0 delivers nothing; it only reports whether the pid exists. EPERM
// means it exists but belongs to another user, which still counts as alive.
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

export const diagnosePreviousShutdown = (input: {
  readonly previous: Option.Option<PersistedServerRuntimeState>;
  readonly currentPid: number;
  readonly nowEpochMillis: number;
  readonly isProcessAlive?: (pid: number) => boolean;
}): PreviousShutdownDiagnosis => {
  if (Option.isNone(input.previous)) {
    return { _tag: "clean" };
  }

  const previous = input.previous.value;
  if (previous.pid === input.currentPid) {
    return { _tag: "clean" };
  }

  // A pid the OS has since recycled reads as alive here, which downgrades a
  // real crash to "concurrent". That costs us a warning, never a false one.
  const alive = (input.isProcessAlive ?? isProcessAlive)(previous.pid);
  if (alive) {
    return { _tag: "concurrent", pid: previous.pid };
  }

  const startedAtMillis = DateTime.make(previous.startedAt).pipe(
    Option.map(DateTime.toEpochMillis),
    Option.getOrUndefined,
  );
  const previousBootAgeMillis =
    startedAtMillis === undefined ? undefined : Math.max(0, input.nowEpochMillis - startedAtMillis);

  return {
    _tag: "unclean",
    pid: previous.pid,
    startedAt: previous.startedAt,
    previousBootAgeMillis,
    crashLoopSuspected:
      previousBootAgeMillis !== undefined && previousBootAgeMillis < crashLoopUptimeThresholdMillis,
  };
};

/**
 * Says out loud, at boot, that the previous process did not shut down cleanly.
 * A supervisor with restart-on-exit makes a crash loop look healthy — every
 * health probe answers, because a fresh process answers it — so the log line
 * is the only place the loop is visible.
 *
 * The state file is written once the server is serving, so a process that dies
 * before that leaves nothing behind and goes unreported here.
 */
export const reportPreviousShutdown = (input: {
  readonly path: string;
  readonly currentPid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
}) =>
  Effect.gen(function* () {
    const previous = yield* readPersistedServerRuntimeState(input.path);
    const now = yield* DateTime.now;
    const diagnosis = diagnosePreviousShutdown({
      previous,
      currentPid: input.currentPid ?? process.pid,
      nowEpochMillis: DateTime.toEpochMillis(now),
      ...(input.isProcessAlive ? { isProcessAlive: input.isProcessAlive } : {}),
    });

    switch (diagnosis._tag) {
      case "clean":
        break;
      case "concurrent":
        yield* Effect.logWarning("server.boot.state-file-owned-by-live-process").pipe(
          Effect.annotateLogs({ previousPid: diagnosis.pid, statePath: input.path }),
        );
        break;
      case "unclean": {
        const annotations = {
          previousPid: diagnosis.pid,
          previousStartedAt: diagnosis.startedAt,
          previousBootAgeSeconds:
            diagnosis.previousBootAgeMillis === undefined
              ? undefined
              : Math.round(diagnosis.previousBootAgeMillis / 1_000),
          statePath: input.path,
        };
        yield* (
          diagnosis.crashLoopSuspected
            ? Effect.logError("server.boot.crash-loop-suspected")
            : Effect.logWarning("server.boot.previous-shutdown-unclean")
        ).pipe(Effect.annotateLogs(annotations));
        break;
      }
    }

    return diagnosis;
  });
