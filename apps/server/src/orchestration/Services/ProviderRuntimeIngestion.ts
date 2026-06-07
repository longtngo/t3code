/**
 * ProviderRuntimeIngestionService - Provider runtime ingestion service interface.
 *
 * Owns background workers that consume provider runtime streams and emit
 * orchestration commands/events.
 *
 * @module ProviderRuntimeIngestionService
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { ThreadId, TurnId } from "@t3tools/contracts";

/**
 * TurnActivitySnapshot - the last provider runtime event observed for a thread's
 * active turn, used by the stall watchdog to detect a silently-wedged SDK turn.
 *
 * `lastEventAt` is epoch millis derived from the event's `createdAt`. `lastEventType`
 * is the provider runtime event `type` (e.g. "item.completed"). `synthetic` marks a
 * background/synthetic turn (auto-started for agent responses between user prompts),
 * which the watchdog must not "resume" with a user-visible continue message.
 */
export interface TurnActivitySnapshot {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly lastEventAt: number;
  readonly lastEventType: string;
  readonly synthetic: boolean;
}

/**
 * ProviderRuntimeIngestionShape - Service API for runtime ingestion lifecycle.
 */
export interface ProviderRuntimeIngestionShape {
  /**
   * Start ingesting provider runtime events into orchestration commands.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Uses an internal queue and continues after non-interrupt failures by
   * logging warnings.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;

  /**
   * Snapshot of the last provider runtime event seen per thread with an active
   * turn. The stall watchdog reads this to find turns that have gone silent.
   * Entries are removed when their turn completes/aborts or the session exits.
   */
  readonly listTurnActivity: Effect.Effect<ReadonlyArray<TurnActivitySnapshot>>;
}

/**
 * ProviderRuntimeIngestionService - Service tag for runtime ingestion workers.
 */
export class ProviderRuntimeIngestionService extends Context.Service<
  ProviderRuntimeIngestionService,
  ProviderRuntimeIngestionShape
>()("t3/orchestration/Services/ProviderRuntimeIngestion/ProviderRuntimeIngestionService") {}
