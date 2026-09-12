/**
 * cursorUsageRead — best-effort read of the Cursor account's total usage window,
 * reduced to the wire-shaped `CursorUsageSnapshot`.
 *
 * The composer's usage readout comes from `account.usage.updated` events, which
 * the server only emits to threads with a live provider session (see
 * `CursorAdapter`'s per-thread broadcast). A subagent-backend toggle panel with
 * no thread open has nothing to subscribe to, so this polls
 * `makeAccountUsagePoll` (token resolution + `fetchUsageSnapshot`, from
 * `CursorUsage.ts`) directly, cached for 60s so repeatedly opening the panel
 * does not repeatedly hit Cursor's API. A failed or unauthenticated fetch
 * resolves to `null`, never an error — the panel simply shows no usage.
 *
 * @module subagentBackend/cursorUsageRead
 */
import type { AccountUsageUpdatedPayload, CursorUsageSnapshot } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeAccountUsagePoll } from "../provider/Layers/CursorUsage.ts";

const CACHE_TTL_MILLIS = Duration.toMillis(Duration.seconds(60));

interface CacheEntry {
  readonly snapshot: CursorUsageSnapshot | null;
  readonly expiresAtMs: number;
}

// Module-level: one Cursor account per server, so a single entry (unlike
// cursorModels.ts's per-binary-path map) is enough.
let cache: CacheEntry | undefined;

/** Reduces a full account-usage payload to the Cursor total window the toggle
 * panel shows, or `null` when there is nothing to show. `fetchedAtIso` is only
 * used as a fallback: `makeAccountUsagePoll` always stamps `fetchedAt` on a
 * non-null payload, so the fallback is defensive rather than expected to run. */
function toSnapshot(
  payload: AccountUsageUpdatedPayload | null,
  fetchedAtIso: string,
): CursorUsageSnapshot | null {
  const total = payload?.cursor?.total ?? null;
  if (total === null) return null;
  const startsAt = payload?.cursor?.cycleStartsAt ?? null;
  return {
    label: "Cursor",
    usedPercent: total.utilization,
    resetsAt: total.resetsAt,
    fetchedAt: payload?.fetchedAt ?? fetchedAtIso,
    ...(startsAt !== null && startsAt !== undefined ? { startsAt } : {}),
  };
}

/**
 * Reads the Cursor account's total usage window, cached for 60s. Never fails:
 * an unavailable account, an unauthenticated CLI, or a network error all
 * collapse to `null` via `makeAccountUsagePoll`'s own fail-safe behavior.
 */
export const readCursorUsage = Effect.fn("subagentBackend.cursorUsageRead")(
  function* (): Effect.fn.Return<
    CursorUsageSnapshot | null,
    never,
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  > {
    const now = yield* Clock.currentTimeMillis;
    if (cache !== undefined && cache.expiresAtMs > now) {
      return cache.snapshot;
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClientOption = yield* Effect.serviceOption(HttpClient.HttpClient);

    const payload = yield* makeAccountUsagePoll({
      // oxlint-disable-next-line t3code/no-global-process-runtime
      env: process.env,
      httpClient: httpClientOption,
      spawner: Option.some(childProcessSpawner),
      fileSystem: Option.some(fileSystem),
    });

    const fetchedAtIso = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const snapshot = toSnapshot(payload, fetchedAtIso);
    cache = { snapshot, expiresAtMs: now + CACHE_TTL_MILLIS };
    return snapshot;
  },
);
