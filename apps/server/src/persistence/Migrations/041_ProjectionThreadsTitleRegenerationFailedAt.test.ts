import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectionThreadsTitleRegenerationFailedAt", (it) => {
  it.effect("adds the nullable title regeneration failure marker to thread projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Applied ids, not filename numbers: this migration is registered as 46 in
      // the fork's manifest (see docs/fork/README.md invariant 1).
      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* runMigrations({ toMigrationInclusive: 46 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_threads)
      `;
      const failedAt = columns.find((column) => column.name === "title_regeneration_failed_at");

      assert.equal(failedAt?.name, "title_regeneration_failed_at");
      // Nullable: existing threads have never failed a regeneration, and a
      // NOT NULL column would need a backfill value that means "no failure".
      assert.equal(failedAt?.notnull, 0);
    }),
  );
});
