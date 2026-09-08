import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { snapshotCookieDatabase } from "./CookieDatabase.ts";

const runNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("snapshotCookieDatabase", () => {
  it.effect("includes committed WAL data in one consistent database", () =>
    runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourceDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-cookie-source-",
        });
        const source = path.join(sourceDirectory, "Cookies");
        const snapshot = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA journal_mode = WAL`;
          yield* sql`PRAGMA wal_autocheckpoint = 0`;
          yield* sql`CREATE TABLE cookies(name TEXT NOT NULL)`;
          yield* sql`INSERT INTO cookies(name) VALUES (${"committed-in-wal"})`;
          expect(yield* fileSystem.exists(`${source}-wal`)).toBe(true);
          return yield* snapshotCookieDatabase(source);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: source })));
        const rows = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly name: string }>`SELECT name FROM cookies`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: snapshot, readonly: true })));
        expect(rows).toEqual([{ name: "committed-in-wal" }]);
      }),
    ),
  );

  it.effect("propagates snapshot failures and removes its temporary directory", () =>
    runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourceDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-cookie-invalid-source-",
        });
        const source = path.join(sourceDirectory, "Cookies");
        yield* fileSystem.writeFileString(source, "not a sqlite database");
        // A parent this test owns. Watching the shared system temp directory
        // instead would mean reading six figures of unrelated entries, which
        // stalls for seconds whenever anything else is writing there, and would
        // key the assertion on a pid prefix that the OS recycles.
        const snapshotParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-cookie-failed-parent-",
        });
        const error = yield* snapshotCookieDatabase(source, snapshotParent).pipe(
          Effect.scoped,
          Effect.flip,
        );
        expect(error._tag).toBe("SqlError");
        expect(yield* fileSystem.readDirectory(snapshotParent)).toEqual([]);
      }),
    ),
  );

  it.effect("removes a successful snapshot when its scope closes", () =>
    runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourceDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-cookie-cleanup-source-",
        });
        const source = path.join(sourceDirectory, "Cookies");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE cookies(name TEXT NOT NULL)`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: source })));
        const snapshotParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-cookie-cleanup-parent-",
        });
        const snapshot = yield* snapshotCookieDatabase(source, snapshotParent).pipe(Effect.scoped);
        // The snapshot really was made under the parent we gave it. Without this
        // the cleanup assertions below hold vacuously for a build that ignored
        // the parameter and wrote to the shared system temp directory instead.
        expect(snapshot.startsWith(`${snapshotParent}${path.sep}`)).toBe(true);
        expect(yield* fileSystem.exists(snapshot)).toBe(false);
        expect(yield* fileSystem.readDirectory(snapshotParent)).toEqual([]);
      }),
    ),
  );
});
