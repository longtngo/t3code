import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_PendingBackgroundTasks.ts";
// Fork migration 33 (PendingBackgroundTasks) is preserved. Id 34 is the fork's first
// Web Push migration ("PushSubscriptions"), still recorded on real databases; it is
// registered below with the same idempotent body as 37 so the history matches.
// Upstream migrations kept their original 033/034 filenames but are assigned
// ids 35/36 here so the fork's already-deployed 33 is never renumbered and stays
// consistent with live DBs.
import Migration0035 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0036 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
// Web Push background notifications. First applied as fork id 34, re-ported as 37
// when upstream took 33-36; real databases record both. CREATE TABLE IF NOT EXISTS
// makes whichever runs second a no-op.
import Migration0037 from "./Migrations/037_PushSubscriptions.ts";
// Upstream's 035 arrives after the fork already deployed ids 35-37, so it takes the
// next free id (38) rather than its filename number. Renumbering an applied id would
// re-run or skip migrations on live fork DBs.
import Migration0038 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
// Adds projection_projects.members_json (workspace members), the next unused
// migration id after 38. File is named 038 for the feature it introduces;
// the id is 39 because 38 is already taken by the entry above.
import Migration0039 from "./Migrations/038_ProjectionProjectMembers.ts";
import Migration0040 from "./Migrations/039_ProjectionCheckpointMemberStates.ts";
// Upstream's 036 (thread pinning) arrives after the fork already deployed ids
// 33-40, so it takes the next free id (41) rather than its filename number.
import Migration0041 from "./Migrations/036_ProjectionThreadsPinned.ts";
// Upstream's 037 (V1 turns keyset index backing windowed thread
// pagination) arrives after the fork already deployed ids 33-41, so it takes
// the next free id (42) rather than its filename number.
import Migration0042 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
// Upstream's 038 (manual pin ordering key) arrives after the fork already
// deployed ids 33-42, so it takes the next free id (43) rather than its
// filename number.
import Migration0043 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
// Upstream's 039 (projection_projects.default_thread_env_mode) arrives after the
// fork already deployed ids 33-43, so it takes the next free id (44) rather than
// its filename number. Its 039 filename collides with the fork's own
// 039_ProjectionCheckpointMemberStates (id 40); filenames are free to repeat,
// applied ids are not.
import Migration0044 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
// Upstream's 040 (projection_projects.favicon_path) likewise takes the next free
// id (45) rather than its filename number.
import Migration0045 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
// Fork migration. Its filename continues upstream's 0NN sequence, but the
// applied id is the next free one (46) — filename numbers and applied ids
// diverged long ago and must not be reconciled.
import Migration0046 from "./Migrations/041_ProjectionThreadsTitleRegenerationFailedAt.ts";
import Migration0047 from "./Migrations/042_DropUnusedCommandReceiptIndexes.ts";
// Upstream's 041 (auth_sessions client connection columns, #7774) arrives after
// the fork already deployed ids 33-47, so it takes the next free id (48) rather
// than its filename number. Its 041 filename collides with the fork's own
// 041_ProjectionThreadsTitleRegenerationFailedAt (id 46); filenames are free to
// repeat, applied ids are not.
import Migration0048 from "./Migrations/041_AuthSessionClientConnection.ts";
// Upstream's 042 (V1 threads.linked_pull_request_json, #8160) arrives after
// the fork already deployed ids 33-48, so it takes the next free id (49) rather than
// its filename number. Its 042 filename collides with the fork's own
// 042_DropUnusedCommandReceiptIndexes (id 47); filenames are free to repeat,
// applied ids are not.
import Migration0049 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
// Upstream's 043 (V1 threads.unsettled_at, #8231) likewise takes the next
// free id (50) rather than its filename number.
import Migration0050 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
// Crew orchestration was removed; 51 stays registered (ids are positional) and its tables are unused.
import Migration0051 from "./Migrations/051_CrewTasks.ts";
// Upstream's 044 (clear automatic project model defaults) and 045
// (projection_projects auto-pull columns) arrive after the fork already deployed
// ids 33-51, so they take the next free ids (52, 53) rather than their filename
// numbers. Filenames are free to repeat and to lag; applied ids are not.
import Migration0052 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0053 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
// Upstream's 046 (repair automatic settlement timestamps) and 047
// (projection_projects.project_icon_json) arrive after the fork already deployed
// ids 33-53, so they take the next free ids (54, 55) rather than their filename
// numbers. Their tests are retargeted to those applied ids.
import Migration0054 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0055 from "./Migrations/047_ProjectionProjectIcon.ts";
// Upstream's 048 (V1 threads.branch_pull_request) arrives after the fork
// already deployed ids 33-55, so it takes the next free id (56) rather than its
// filename number. It backs `branchPullRequest`, which replaced the fork's
// client-side pull-request derivation in the command palette.
import Migration0056 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";

// Fork-authored. Applied id 57, filename 052: 52-56 were already taken by
// upstream migrations that kept their own filename numbers, so the next free
// filename and the next free id have diverged (registry section 1).
import Migration0057 from "./Migrations/052_ProjectionThreadActivityKindIndex.ts";

// Upstream-authored. Applied id 58, filename 049: upstream numbered it 49, but ids 49-57
// are already spent on live fork databases, so it takes the next free id and keeps its
// own filename (registry section 1).
import Migration0058 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";

// Upstream's 050 (V1 thread pull requests, multi-PR links) arrives after
// the fork already deployed ids 33-58, so it takes the next free id (59) rather
// than its filename number.
import Migration0059 from "./Migrations/050_ProjectionThreadPullRequests.ts";
// Upstream's 051 (V1 thread messages.context_json, composer context records)
// arrives after the fork already deployed ids 33-59, so it takes the next free id (60)
// rather than its filename number.
import Migration0060 from "./Migrations/051_ProjectionThreadMessageContext.ts";
// Upstream's 052 (V1 threads.title_state_json, #10720) arrives after the fork
// already deployed ids 33-60, so it takes the next free id (61) rather than its filename
// number. Its 052 filename collides with the fork's own 052_ProjectionThreadActivityKindIndex
// (id 57); filenames are free to repeat, applied ids are not.
import Migration0061 from "./Migrations/052_ProjectionThreadTitleState.ts";
// Upstream's 053 (pull request files marked as viewed, #7721) arrives after the fork
// already deployed ids 33-61, so it takes the next free id (62) rather than its filename
// number.
import Migration0062 from "./Migrations/053_PullRequestFilesViewed.ts";
// Upstream's 054 (V1 threads.auto_settle_disabled_at, #11846) arrives after the
// fork already deployed ids 33-62, so it takes the next free id (63) rather than its
// filename number.
import Migration0063 from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
// Upstream's 055 (orchestrator v2 schema, #2829) and 056 arrive after the fork
// already deployed ids 33-63, so they take the next free ids (64, 65) rather than
// their filename numbers (registry section 1).
import Migration0064 from "./Migrations/055_OrchestrationV2.ts";
import Migration0065 from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
// Upstream's 057/058 (scheduled-task webhooks, #15085 / #15487) arrive after the fork
// already deployed ids 33-65, so they take the next free ids (66, 67) rather than their
// filename numbers (registry section 1).
import Migration0066 from "./Migrations/057_ScheduledTaskWebhooks.ts";
import Migration0067 from "./Migrations/058_WebhookRelayDeliveries.ts";
// Upstream's 059/060 (MCP app model context, thread snapshot window indexes) arrive after
// the fork already deployed ids 33-67, so they take the next free ids (68, 69) rather than
// their filename numbers (registry section 1).
import Migration0068 from "./Migrations/059_McpAppModelContext.ts";
import Migration0069 from "./Migrations/060_ThreadSnapshotWindowIndexes.ts";
// Upstream's 061 (pull request review guides, #18124) arrives after the fork already
// deployed ids 33-69, so it takes the next free id (70) rather than its filename
// number (registry section 1).
import Migration0070 from "./Migrations/061_PullRequestReviewGuides.ts";
// Upstream's 062 (thread failure lookup index, #18628) arrives after the fork already
// deployed ids 33-70, so it takes the next free id (71) rather than its filename
// number (registry section 1).
import Migration0071 from "./Migrations/062_ThreadFailureLookupIndex.ts";
// Upstream's 063/064 (drop unused V1 projections, #20947; canonicalize thread pull
// request links, #19129) arrive after the fork already deployed ids 33-71, so they take
// the next free ids (72, 73) rather than their filename numbers (registry section 1).
import Migration0072 from "./Migrations/063_DropUnusedV1Projections.ts";
import Migration0073 from "./Migrations/064_CanonicalizeThreadPullRequestLinks.ts";
// Upstream's 065-067 (Codex native turn index, client settlement timestamp repair, webhook
// dedupe) arrive after the fork already deployed ids 33-73, so they take the next free ids
// (74, 75, 76) rather than their filename numbers (registry section 1).
import Migration0074 from "./Migrations/065_CodexUsageNativeTurnIndex.ts";
import Migration0075 from "./Migrations/066_RepairClientSettlementTimestamps.ts";
import Migration0076 from "./Migrations/067_WebhookDedupe.ts";
// Upstream's 068 (shell stop request index) arrives after the fork already deployed ids
// 33-76, so it takes the next free id (77) rather than its filename number (registry section 1).
import Migration0077 from "./Migrations/068_ShellStopRequestIndex.ts";

export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "PendingBackgroundTasks", Migration0033],
  [34, "PushSubscriptions", Migration0037],
  [35, "ProjectionThreadsSettled", Migration0035],
  [36, "ProjectionThreadsSnoozed", Migration0036],
  [37, "PushSubscriptions", Migration0037],
  [38, "ProjectionThreadTitleRegeneration", Migration0038],
  [39, "ProjectionProjectMembers", Migration0039],
  [40, "ProjectionCheckpointMemberStates", Migration0040],
  [41, "ProjectionThreadsPinned", Migration0041],
  [42, "ProjectionTurnsKeysetIndex", Migration0042],
  [43, "ProjectionThreadsPinOrderKey", Migration0043],
  [44, "ProjectionProjectsDefaultThreadEnvMode", Migration0044],
  [45, "ProjectionProjectFaviconPath", Migration0045],
  [46, "ProjectionThreadsTitleRegenerationFailedAt", Migration0046],
  [47, "DropUnusedCommandReceiptIndexes", Migration0047],
  [48, "AuthSessionClientConnection", Migration0048],
  [49, "ProjectionThreadLinkedPullRequest", Migration0049],
  [50, "ProjectionThreadsUnsettledAt", Migration0050],
  [51, "CrewTasks", Migration0051],
  [52, "ClearAutomaticProjectModelDefaults", Migration0052],
  [53, "ProjectionProjectsAutoPull", Migration0053],
  [54, "RepairAutomaticSettlementTimestamps", Migration0054],
  [55, "ProjectionProjectIcon", Migration0055],
  [56, "ProjectionThreadBranchPullRequest", Migration0056],
  [57, "ProjectionThreadActivityKindIndex", Migration0057],
  [58, "ProjectionThreadsActiveOrderKey", Migration0058],
  [59, "ProjectionThreadPullRequests", Migration0059],
  [60, "ProjectionThreadMessageContext", Migration0060],
  [61, "ProjectionThreadTitleState", Migration0061],
  [62, "PullRequestFilesViewed", Migration0062],
  [63, "ProjectionThreadsAutoSettleDisabledAt", Migration0063],
  // Upstream's 55/56. Preserve this migration's schema; future V2 schema changes need
  // new migrations. Upstream's reconcileV2PreviewMigration is not taken: no fork database
  // ran a V2 preview, and its renumbering targets ids the fork already spent.
  [64, "OrchestrationV2", Migration0064],
  [65, "RemoveRedundantProjectionIndexes", Migration0065],
  [66, "ScheduledTaskWebhooks", Migration0066],
  [67, "WebhookRelayDeliveries", Migration0067],
  [68, "McpAppModelContext", Migration0068],
  [69, "ThreadSnapshotWindowIndexes", Migration0069],
  [70, "PullRequestReviewGuides", Migration0070],
  [71, "ThreadFailureLookupIndex", Migration0071],
  [72, "DropUnusedV1Projections", Migration0072],
  [73, "CanonicalizeThreadPullRequestLinks", Migration0073],
  [74, "CodexUsageNativeTurnIndex", Migration0074],
  [75, "RepairClientSettlementTimestamps", Migration0075],
  [76, "WebhookDedupe", Migration0076],
  [77, "ShellStopRequestIndex", Migration0077],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

// V2's schema migrations start at 64 here (upstream's 55; registry section 1).
const FIRST_V2_MIGRATION_ID = 64;

/**
 * Fail before migrating when the migrator would skip one of V2's own
 * migrations. It skips every id up to the highest recorded one, whatever name
 * was recorded, so a database that took a V2 id for another migration would
 * start without V2's schema and fail on first use.
 */
const assertV2MigrationsCanRun = Effect.fn("assertV2MigrationsCanRun")(function* (
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name]));
  const skipped = migrationEntries.flatMap(([id, name]) => {
    if (
      id < FIRST_V2_MIGRATION_ID ||
      id > latestRecordedId ||
      (throughId !== undefined && id > throughId)
    )
      return [];
    const recordedName = recordedNames.get(id);
    if (recordedName === name) return [];
    return [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
  if (skipped.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${latestRecordedId}), regardless of name. It was probably written by a different build. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
  });
});

const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const includesV2 =
    toMigrationInclusive === undefined || toMigrationInclusive >= FIRST_V2_MIGRATION_ID;
  if (includesV2) {
    yield* assertV2MigrationsCanRun(toMigrationInclusive);
  }
  const executedMigrations = yield* run({ loader: makeMigrationLoader(toMigrationInclusive) });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));

  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const manifestNames = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
  const divergent = recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);
    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }
    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });
  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }
  return executedMigrations;
});
