import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_AuthSessionClientConnection", (it) => {
  it.effect("adds nullable client surface and app version columns to auth sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Applied ids, not filename numbers: upstream's 041 is registered as 48
      // in the fork's manifest, because ids 33-47 were already deployed here
      // (see docs/fork/README.md invariant 1). Upstream's own numbering runs
      // this at 40/41 and finds no columns.
      yield* runMigrations({ toMigrationInclusive: 47 });

      // Control: proves 48 is what adds these. Without it the assertions below
      // would also hold if some earlier migration already had, and the
      // renumbering above would be untested.
      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;
      assert.equal(
        before.some((column) => column.name === "client_surface"),
        false,
      );

      yield* runMigrations({ toMigrationInclusive: 48 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(auth_sessions)
      `;
      const surface = columns.find((column) => column.name === "client_surface");
      const appVersion = columns.find((column) => column.name === "client_app_version");

      assert.equal(surface?.name, "client_surface");
      assert.equal(surface?.notnull, 0);
      assert.equal(appVersion?.name, "client_app_version");
      assert.equal(appVersion?.notnull, 0);
    }),
  );
});
