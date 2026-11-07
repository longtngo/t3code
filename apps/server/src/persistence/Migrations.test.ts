import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import UpstreamSettled from "./Migrations/033_ProjectionThreadsSettled.ts";
import UpstreamSnoozed from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import UpstreamTitleRegeneration from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import UpstreamPinned from "./Migrations/036_ProjectionThreadsPinned.ts";
import UpstreamKeysetIndex from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";

// Fork ids: upstream's V2 migrations 55+ apply as 64+ here (registry section 1).
const v2Migrations = migrationManifest.filter(([id]) => id >= 64);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (64, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 63 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "64_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 63", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 63 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("drops the unused correlation index and keeps correlation values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Fork ids (registry section 1): 63 is the last pre-V2 id, and upstream's 078 drop is 87.
      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created', '2026-01-01T00:00:00.000Z',
          'command-1', NULL, 'correlation-1', 'client', '{}', '{}'
        )
      `;

      // Control: the index is still there one id before the drop.
      yield* runMigrations({ toMigrationInclusive: 86 });
      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_orch_events_correlation_id'
      `;
      assert.lengthOf(before, 1);

      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events' AND sql IS NOT NULL
      `;
      const indexNames = indexes.map((row) => row.name);
      assert.notInclude(indexNames, "idx_orch_events_correlation_id");
      for (const kept of [
        "idx_orch_events_stream_version",
        "idx_orch_events_stream_sequence",
        "idx_orch_events_command_id",
        "idx_orchestration_events_agent_stream_sequence",
      ]) {
        assert.include(indexNames, kept);
      }
      const events = yield* sql<{ readonly correlation_id: string | null }>`
        SELECT correlation_id FROM orchestration_events WHERE event_id = 'event-1'
      `;
      assert.deepStrictEqual(events, [{ correlation_id: "correlation-1" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 63])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (65, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 64 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 65 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "65_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "66_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  // The live DB ran an upstream build first: it recorded upstream's names at 33-37, so the
  // fork's PushSubscriptions (34, 37) were skipped when the fork build took over at 38.
  it.effect("creates push_subscriptions on a history an upstream build started", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const pushTable = sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'push_subscriptions'
      `;
      yield* runMigrations({ toMigrationInclusive: 32 });
      const upstream = [
        [33, "ProjectionThreadsSettled", UpstreamSettled],
        [34, "ProjectionThreadsSnoozed", UpstreamSnoozed],
        [35, "ProjectionThreadTitleRegeneration", UpstreamTitleRegeneration],
        [36, "ProjectionThreadsPinned", UpstreamPinned],
        [37, "ProjectionTurnsKeysetIndex", UpstreamKeysetIndex],
      ] as const;
      for (const [id, name, body] of upstream) {
        yield* body;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
      }
      // Control: the build before the repair (through 89) leaves the table missing.
      yield* runMigrations({ toMigrationInclusive: 89 });
      assert.lengthOf(yield* pushTable, 0);

      yield* runMigrations();

      assert.lengthOf(yield* pushTable, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps existing push subscriptions when the repair runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 89 });
      yield* sql`
        INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
        VALUES ('https://push.example/1', 'k', 'a', '2026-11-07T00:00:00.000Z')
      `;

      assert.deepStrictEqual(
        (yield* runMigrations()).map(([id]) => id),
        [90],
      );

      const rows = yield* sql<{
        readonly endpoint: string;
      }>`SELECT endpoint FROM push_subscriptions`;
      assert.deepStrictEqual(rows, [{ endpoint: "https://push.example/1" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// Fork: file numbers are not applied ids (fork registry invariant 1), so match by name.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [match[2]] : [];
    });
    // Ids 34, 37 and 90 re-register PushSubscriptions on purpose, so compare distinct names.
    assert.deepStrictEqual(
      files.toSorted(),
      [...new Set(migrationManifest.map(([, name]) => name))].toSorted(),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
