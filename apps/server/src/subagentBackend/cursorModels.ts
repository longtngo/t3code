/**
 * cursorModels — enumerates the concrete model ids `cursor-agent --model` accepts.
 *
 * t3code discovers Cursor models over ACP as *base* slugs (35 of them, with Auto
 * as `auto-smart`) for the provider snapshot the chat UI shows. The subagent
 * dispatch toggle instead has to hand the CLI one of its own 204 *concrete* ids
 * (Auto is `auto` there), so it probes `--list-models` directly rather than
 * reusing that snapshot — passing a snapshot slug would ship a default the CLI
 * rejects.
 *
 * @module subagentBackend/cursorModels
 */
import type { SubagentBackendModelOption } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

const LIST_MODELS_TIMEOUT = Duration.seconds(10);
const CACHE_TTL_MILLIS = Duration.toMillis(Duration.minutes(10));
const MAX_OUTPUT_BYTES = 200_000;

/** Strips the CLI's own annotations so two instances do not disagree on a label. */
const ANNOTATION = /\s*\((default|current)\)\s*$/;

/**
 * Parses `cursor-agent --list-models` output into id/label pairs, skipping the
 * banner line and anything else that doesn't match `<id> - <label>`. Returns an
 * empty list for output it cannot make sense of rather than inventing ids.
 */
export function parseCursorModelList(stdout: string): SubagentBackendModelOption[] {
  const models: SubagentBackendModelOption[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^([A-Za-z0-9._-]+) - (.+)$/.exec(line.trim());
    if (match === null) continue;
    models.push({ id: match[1]!, label: match[2]!.replace(ANNOTATION, "") });
  }
  return models;
}

/** Runs `<binaryPath> --list-models`, returning stdout or "" on any failure or timeout. */
const runListModels = (
  binaryPath: string,
): Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(binaryPath, ["--list-models"], { cwd: process.cwd() }),
    );
    const collected = yield* collectUint8StreamText({
      stream: child.stdout,
      maxBytes: MAX_OUTPUT_BYTES,
    });
    return collected.text;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(LIST_MODELS_TIMEOUT),
    Effect.map((result) => (Option.isSome(result) ? result.value : "")),
    Effect.catchCause(() => Effect.succeed("")),
  );

interface CacheEntry {
  readonly models: readonly SubagentBackendModelOption[];
  readonly expiresAtMs: number;
}

// Module-level and keyed by binary path: every caller naming the same Cursor
// binary (multiple instances, multiple browser tabs) shares one probe instead
// of each spawning its own `--list-models`.
const cache = new Map<string, CacheEntry>();

/**
 * Probes currently running, keyed by the same binary path as `cache`.
 *
 * The cache alone only shares a probe with callers that arrive AFTER one
 * finishes. Callers that arrive DURING one all miss — nothing has been written
 * yet — and each spawns its own. That is the common case rather than a corner:
 * opening the panel issues a refreshing `get` and flipping the toggle issues a
 * `set`, both of which probe the same binary, and a ~3.4s probe leaves a wide
 * window to overlap in. Measured before this existed: three concurrent callers
 * spawned three processes.
 */
const inFlight = new Map<string, Deferred.Deferred<readonly SubagentBackendModelOption[]>>();

/**
 * Returns whatever `listCursorModels` last probed for `binaryPath`, without
 * spawning a probe of its own — including a stale (TTL-expired) entry, since a
 * known-but-old list beats showing nothing while the caller that wants a fresh
 * one runs its own probe separately. Empty until a probe has run at least once.
 * `subagentBackend.get` uses this to stay cheap on client mount (see ws.ts).
 */
export function peekCursorModels(binaryPath: string): readonly SubagentBackendModelOption[] {
  return cache.get(binaryPath)?.models ?? [];
}

/**
 * Lists the CLI model ids `<binaryPath> --list-models` reports, cached for 10
 * minutes per binary path. A failed or timed-out probe falls back to the cached
 * value if one exists, otherwise an empty list — never an error, since an empty
 * model list degrades the picker rather than blocking the dispatch toggle.
 */
export const listCursorModels = Effect.fn("subagentBackend.listCursorModels")(function* (
  binaryPath: string,
): Effect.fn.Return<
  readonly SubagentBackendModelOption[],
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const now = yield* Clock.currentTimeMillis;
  const cached = cache.get(binaryPath);
  if (cached !== undefined && cached.expiresAtMs > now) {
    return cached.models;
  }

  const running = inFlight.get(binaryPath);
  if (running !== undefined) {
    return yield* Deferred.await(running);
  }

  const deferred = yield* Deferred.make<readonly SubagentBackendModelOption[]>();
  inFlight.set(binaryPath, deferred);

  // `onExit` rather than a plain sequence: an interrupted or failed probe must
  // still clear its slot and release everyone waiting on it, or the first
  // interruption wedges every later caller for this binary until restart.
  return yield* Effect.gen(function* () {
    const stdout = yield* runListModels(binaryPath);
    const models = parseCursorModelList(stdout);
    if (models.length === 0) {
      return cached?.models ?? [];
    }
    cache.set(binaryPath, { models, expiresAtMs: now + CACHE_TTL_MILLIS });
    return models;
  }).pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => {
        inFlight.delete(binaryPath);
      }).pipe(
        Effect.andThen(
          exit._tag === "Success"
            ? Deferred.succeed(deferred, exit.value)
            : Deferred.succeed(deferred, cached?.models ?? []),
        ),
      ),
    ),
  );
});
