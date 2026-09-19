import { assert, describe, expect, it as vitestIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

/**
 * The ids already deployed to live databases before this change. A literal, never
 * derived from `migrationEntries`: derived, the high-water predicate below reduces
 * to `every(id => true)` and stays green even for id 34, which this fork burned and
 * must never reuse (see the renumbering note in Migrations.ts).
 */
const LEGACY = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32, 33, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
]);

describe("051_CrewTasks ids", () => {
  vitestIt("LEGACY is the deployed set, not a truncated paste", () => {
    expect(LEGACY.size).toBe(49);
    expect(LEGACY.has(34)).toBe(false);
  });

  vitestIt("every id is legacy or above the applied high-water mark", () => {
    const ids = migrationEntries.map(([id]) => id);
    expect(ids.every((id) => LEGACY.has(id) || id > 50)).toBe(true);
  });

  // The predicate above only earns trust if it can report a hit. Each arm is the
  // shape of a real mistake; the id-34 arm is the one a derived LEGACY would miss.
  vitestIt.each([
    ["accepts a fresh id 51", [...LEGACY, 51], true],
    ["rejects id 34 reinserted in sorted position", [...LEGACY, 34], false],
    ["rejects a gap-filling id below the mark", [...LEGACY, 34, 51], false],
  ])("%s", (_label, ids, expected) => {
    expect(ids.every((id) => LEGACY.has(id) || id > 50)).toBe(expected);
  });

  // Retargeted on the 27th reconcile: this asserted "exactly one new id" when 51 was
  // the only one above the mark. Upstream's 044/045 have since arrived and taken 52/53,
  // so the subject is now that 51 is still CrewTasks and that every id past the mark is
  // a contiguous, ascending extension of it -- which is what a renumbering would break.
  vitestIt("keeps 51 as CrewTasks and extends contiguously above the mark", () => {
    const beyond = migrationEntries.filter(([id]) => !LEGACY.has(id));
    expect(beyond[0]?.[0]).toBe(51);
    expect(beyond[0]?.[1]).toBe("CrewTasks");
    expect(beyond.map(([id]) => id)).toEqual(beyond.map((_entry, index) => 51 + index));
  });

  vitestIt("ids are unique and strictly ascending", () => {
    const ids = migrationEntries.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });
});

const layer = vitestIt.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("051_CrewTasks schema", (it) => {
  it.effect("creates crew_tasks and crew_reports with their indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 50 });

      // Control: without this the assertions below pass whether or not migration 51
      // is the thing that created the tables.
      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      assert.ok(!before.some((row) => row.name === "crew_tasks"));
      assert.ok(!before.some((row) => row.name === "crew_reports"));

      yield* runMigrations({ toMigrationInclusive: 51 });

      const taskColumns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(crew_tasks)
      `;
      assert.deepStrictEqual(
        taskColumns.map((column) => column.name),
        [
          "task_id",
          "parent_thread_id",
          "crew_thread_id",
          "project_id",
          "base_ref",
          "branch",
          "worktree_path",
          "provider",
          "status",
          "created_at",
          "updated_at",
        ],
      );
      // base_ref is the only nullable column: a task may be rooted at the project's
      // current HEAD rather than a named ref.
      assert.deepStrictEqual(
        taskColumns.filter((column) => column.notnull === 0).map((column) => column.name),
        ["base_ref"],
      );

      const reportColumns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(crew_reports)
      `;
      assert.deepStrictEqual(
        reportColumns.map((column) => column.name),
        ["report_id", "task_id", "state", "note", "created_at", "noted_at", "reply_to"],
      );
      // noted_at is NULL until the delivery sweep stamps it; that NULL is the queue.
      assert.deepStrictEqual(
        reportColumns.filter((column) => column.notnull === 0).map((column) => column.name),
        ["noted_at", "reply_to"],
      );

      const taskIndexes = yield* sql<{ readonly name: string; readonly unique: number }>`
        PRAGMA index_list(crew_tasks)
      `;
      const byName = new Map(taskIndexes.map((index) => [index.name, index]));
      assert.ok(byName.has("ix_crew_tasks_parent"));
      assert.ok(byName.has("ix_crew_tasks_status"));
      // One crew thread belongs to at most one task. Enforced, not merely indexed.
      assert.strictEqual(byName.get("ix_crew_tasks_crew")?.unique, 1);

      const reportIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(crew_reports)
      `;
      assert.ok(reportIndexes.some((index) => index.name === "ix_crew_reports_task"));
    }),
  );

  it.effect("rejects a second task for the same crew thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });

      const insert = (taskId: string) => sql`
        INSERT INTO crew_tasks (
          task_id, parent_thread_id, crew_thread_id, project_id, base_ref,
          branch, worktree_path, provider, status, created_at, updated_at
        ) VALUES (
          ${taskId}, 'bridge-1', 'crew-1', 'project-1', NULL,
          'crew/one', '/tmp/one', 'claude', 'open', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z'
        )
      `;

      yield* insert("task-1");
      const second = yield* Effect.result(insert("task-2"));
      assert.strictEqual(second._tag, "Failure");
    }),
  );
});
