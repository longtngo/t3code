import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationEntries, runMigrations } from "./Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("runMigrations divergence warning", (it) => {
  it.effect("names a recorded migration this build does not know", () => {
    const divergent: Array<unknown> = [];
    const capture = Logger.make(({ message, fiber }) => {
      const text = Array.isArray(message) ? message[0] : message;
      if (String(text).includes("migration history diverges")) {
        divergent.push(fiber.getRef(References.CurrentLogAnnotations)["divergent"]);
      }
    });
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      // Above every manifest id, so nothing of this build is skipped.
      const unknownId = Math.max(...migrationEntries.map(([id]) => id)) + 100;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${unknownId}, 'SiteLocalExperiment')
      `;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(divergent, [
        [`${unknownId}:SiteLocalExperiment (unknown to this build)`],
      ]);
    }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: true })));
  });
});
