import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

// The index is only worth having if the planner picks it, so that is what this
// asserts rather than the index's mere existence. Measured against mutations:
// it catches indexing the wrong column, and it does NOT catch reversing the
// column order — because for an equality-on-both query SQLite serves
// (kind, thread_id) just as well, so that reversal is not actually a defect here.
layer("052_ProjectionThreadActivityKindIndex", (it) => {
  const planFor = Effect.fn("planFor")(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT activity_id
      FROM projection_thread_activities
      WHERE thread_id = 'thread-1'
        AND kind = 'approval.requested'
    `;
    return rows.map((row) => row.detail).join(" | ");
  });

  it.effect("makes the planner search by (thread_id, kind) instead of scanning a thread", () =>
    Effect.gen(function* () {
      // Fork applied ids: this migration is 57, not its filename number 52.
      yield* runMigrations({ toMigrationInclusive: 56 });

      // Control. Without it, the assertion below would pass whether or not 57
      // is the right id, and whether or not the index changes anything.
      const before = yield* planFor();
      assert.notInclude(before, "idx_projection_thread_activities_thread_kind");
      assert.include(before, "thread_id=?");

      yield* runMigrations({ toMigrationInclusive: 57 });

      const after = yield* planFor();
      assert.include(after, "idx_projection_thread_activities_thread_kind");
      assert.include(after, "kind=?");
    }),
  );
});
