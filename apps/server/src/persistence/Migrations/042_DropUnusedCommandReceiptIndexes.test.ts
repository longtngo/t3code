import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const receiptIndexNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'orchestration_command_receipts'
    ORDER BY name
  `;
  return rows.map((row) => row.name);
});

layer("042_DropUnusedCommandReceiptIndexes", (it) => {
  it.effect("drops both secondary indexes and keeps lookups by command id working", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Applied ids, not filename numbers: this migration is registered as 47
      // in the fork's manifest (see docs/fork/README.md invariant 1).
      yield* runMigrations({ toMigrationInclusive: 46 });

      // Control: without it, "they are gone afterwards" would also hold if
      // migration 2 had never created them.
      const before = yield* receiptIndexNames;
      assert.deepEqual(before, [
        "idx_orch_command_receipts_aggregate",
        "idx_orch_command_receipts_sequence",
        // SQLite's implicit index for the TEXT PRIMARY KEY. It is what serves
        // the dedup lookup, and it must survive.
        "sqlite_autoindex_orchestration_command_receipts_1",
      ]);

      yield* runMigrations({ toMigrationInclusive: 47 });

      assert.deepEqual(yield* receiptIndexNames, [
        "sqlite_autoindex_orchestration_command_receipts_1",
      ]);

      // The dedup lookup is the only read this table has, and it must still
      // work - and still refuse a second row for the same command id.
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at,
          result_sequence, status, error
        )
        VALUES ('cmd-1', 'thread', 'thread-1', '2026-03-01T00:00:00.000Z', 7, 'accepted', NULL)
      `;
      const found = yield* sql<{ readonly resultSequence: number }>`
        SELECT result_sequence AS "resultSequence"
        FROM orchestration_command_receipts
        WHERE command_id = 'cmd-1'
      `;
      assert.equal(found.length, 1);
      assert.equal(found[0]?.resultSequence, 7);
    }),
  );
});
