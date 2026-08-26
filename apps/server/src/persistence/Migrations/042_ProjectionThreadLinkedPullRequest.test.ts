import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ProjectionThreadLinkedPullRequest", (it) => {
  it.effect("adds the linked pull request column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // FORK: applied ids, not filename numbers. This migration's file is named
      // 042 but it is applied as id 49 here (see docs/fork/README.md invariant 1),
      // so upstream's 41/42 would run neither it nor its predecessor.
      yield* runMigrations({ toMigrationInclusive: 48 });

      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      // Control: without this, the assertion below passes whether or not the
      // renumbering is right, because some later id would have added the column.
      assert.ok(!before.some((column) => column.name === "linked_pull_request_json"));

      yield* runMigrations({ toMigrationInclusive: 49 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "linked_pull_request_json"));
    }),
  );
});
