import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("047_ProjectionProjectIcon", (it) => {
  it.effect("adds the nullable project icon JSON to project projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Fork applied ids: this migration is 55, not its filename number 47 (registry §1).
      yield* runMigrations({ toMigrationInclusive: 54 });

      // Control: without it, the assertions below pass whether or not 55 is the right id.
      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.equal(
        before.find((column) => column.name === "project_icon_json"),
        undefined,
      );

      yield* runMigrations({ toMigrationInclusive: 55 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const projectIcon = columns.find((column) => column.name === "project_icon_json");

      assert.equal(projectIcon?.name, "project_icon_json");
      assert.equal(projectIcon?.notnull, 0);
    }),
  );
});
