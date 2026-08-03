/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  CheckpointRef,
  OrchestrationCheckpointSummary,
  OrchestrationHistoryCursor,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadHistoryPageInput,
  OrchestrationThreadHistoryPageResult,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

export interface ProjectionFullThreadDiffContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly latestCheckpointTurnCount: number;
  readonly toCheckpointRef: CheckpointRef | null;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine without hydrating message/activity/checkpoint bodies.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read archived thread shell summaries for the archive page.
   *
   * This query is separate from the main shell snapshot so archived threads
   * are never bootstrapped into normal navigation state.
   */
  readonly getArchivedShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Search active thread navigation metadata, user messages, and canonical
   * assistant outputs without hydrating thread detail snapshots.
   */
  readonly searchThreads: (
    input: OrchestrationSearchThreadsInput,
  ) => Effect.Effect<OrchestrationSearchThreadsResult, ProjectionRepositoryError>;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model
   * entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read only the narrow context needed to compute a full-thread diff from
   * checkpoint 0 to a specific turn count.
   */
  readonly getFullThreadDiffContext: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionFullThreadDiffContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   *
   * The resolved thread stays pure in `.value`; windowing metadata rides
   * alongside it. With no `options` (or with both bounds absent) the full
   * thread is loaded and the result carries `oldestLoaded: undefined,
   * hasMoreHistory: false`. When `windowTurns`/`maxRows` are supplied the
   * snapshot is capped to the most recent turns and reports how far back it
   * reaches. `Option.none` means the thread was not found (unchanged).
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
    options?: {
      readonly windowTurns?: number | undefined;
      readonly maxRows?: number | undefined;
      /**
       * Thread-load windowing: cap the initial snapshot to at most `maxBytes` of
       * serialized per-turn content (message/activity/plan text), in addition to
       * the turn/row bounds. Bounds the frame size for the "few turns, heavy
       * payloads" case that escapes `windowTurns`/`maxRows`. Server-internal (no
       * client sends it); always keeps at least the newest turn.
       */
      readonly maxBytes?: number | undefined;
    },
  ) => Effect.Effect<
    Option.Option<OrchestrationThreadDetailResult>,
    ProjectionRepositoryError
  >;

  /**
   * Read the next OLDER page of a thread's history, paging strictly before the
   * `beforeTurn` cursor. Symmetric to the windowed `getThreadDetailById`, but
   * returns only the four per-turn collections (no thread head): the next
   * `maxTurns` turns older than the cursor, capped by `maxRows`, plus the new
   * `oldestLoaded` cursor and whether still-older turns remain.
   */
  readonly getThreadHistoryPage: (
    input: OrchestrationThreadHistoryPageInput & {
      /**
       * Server-internal byte budget for a single page (see
       * {@link getThreadDetailById} `maxBytes`). Not on the wire — the ws handler
       * injects the default. Always keeps at least the next-older turn so paging
       * advances even when one turn alone exceeds the budget.
       */
      readonly maxBytes?: number | undefined;
    },
  ) => Effect.Effect<OrchestrationThreadHistoryPageResult, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail together with the projection snapshot
   * sequence in one consistent transaction, so the returned `snapshotSequence`
   * exactly matches the state reflected in `thread` (no interleaving projector
   * update between the two reads).
   */
  readonly getThreadDetailSnapshot: (
    threadId: ThreadId,
    options?: {
      readonly windowTurns?: number | undefined;
      readonly maxRows?: number | undefined;
      /**
       * Server-internal serialized-byte budget (see {@link getThreadDetailById}
       * `maxBytes`). Forwarded to the underlying windowed read so a huge thread
       * returns a bounded recent window plus `oldestLoaded`/`hasMoreHistory` rather
       * than one giant snapshot frame. Always keeps at least the newest turn.
       */
      readonly maxBytes?: number | undefined;
    },
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;
}

/**
 * A resolved thread detail plus its thread-load windowing metadata.
 */
export interface OrchestrationThreadDetailResult {
  /** The resolved thread (full or windowed to the most recent turns). */
  readonly value: OrchestrationThread;
  /**
   * Cursor identifying the oldest turn included in the snapshot, for paging
   * further back. `undefined` when the full thread history was loaded.
   */
  readonly oldestLoaded: OrchestrationHistoryCursor | undefined;
  /**
   * Whether older turns exist beyond `oldestLoaded`. `false` for full
   * (unwindowed) snapshots.
   */
  readonly hasMoreHistory: boolean;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
