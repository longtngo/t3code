# Crew Orchestration Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One bridge thread dispatches autonomous crewmate agent threads into their own git worktrees, receives their reports without paying a turn per `progress`, and tears them down.

**Architecture:** A sidecar service with its own two tables, its own repository and its own supervisor layer. No `decider.ts` or `projector.ts` changes. Reports reach the bridge through `appendSessionNote` where the provider supports it and a wake turn otherwise; crew rows reach the client through one unary RPC on the shipped `useResourceQueue` pattern, not the shell stream.

**Tech Stack:** Effect (effect-smol), Effect/Schema contracts, `node:sqlite` via `SqlClient`, Effect MCP server, React + Jotai-style atoms in `packages/client-runtime`, vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-crew-orchestration-design.md` (revision 17). Read it alongside this plan — every task cites the section it implements, and the spec carries the measurements behind each decision.

## Global Constraints

- **Branch:** `feat/crew-orchestration`, worktree `~/.t3/worktrees/t3code/crew-orchestration`. Never write to `~/.t3/userdata`.
- **Migration id is 51.** Ids 1-33 and 35-50 are applied; 34 is a permanent gap and reusing it silently no-ops on a real database (spec §4).
- **Every test is parameterised over a correct and a deliberately-defective implementation in the same file, and asserts the defective arm's own specific wrong value positively.** Never `it.fails`, never `.not.toBe` with a `try/catch` — both are green when a fixture throws. One defect per arm for an enumerated bullet. A clause whose _correct_ arm is red against the spec is a defect in the spec: fix the spec first (spec §11).
- **Run web tests from `apps/web`, not the repo root** (AGENTS.md: the root config has no `.wasm?inline` handling). Server tests from `apps/server`.
- **`pnpm verify` before merging to `personal`** — the whole script, formatting step included. CI does not run on this fork.
- **No dev server on production ports.** Ports derive from the worktree path; read the real ones from the `[dev-runner]` line.
- **`crewRole` is `"bridge" | "crewmate" | "crewmate-closed" | null`** and is spread into the shell only when present (`...(role ? { crewRole: role } : {})`), matching `linkedPullRequest`. Emitting `crewRole: null` on ordinary threads turns an existing `ProjectionSnapshotQuery.test.ts` assertion red.
- **Cap default 4**, env `T3CODE_CREW_MAX_CONCURRENT_TASKS`; `0`/`00`/` 0` disable, `-1`/`abc`/`""` fall back to 4.
- **Bounds:** `prompt` ≤ 8 KiB, `note` ≤ 1 KiB, `text` ≤ 1 KiB, 200 non-answer rows per task, `crew_status` returns ≤ 50 rows per task.

---

## File Structure

**New:**

| File                                                          | Responsibility                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/server/src/persistence/Migrations/051_CrewTasks.ts`     | the two tables and their indexes                                     |
| `apps/server/src/crew/CrewRepository.ts`                      | typed reads/writes over `crew_tasks` / `crew_reports`                |
| `apps/server/src/crew/derive.ts`                              | the pure rendering ladder (spec §4)                                  |
| `apps/server/src/crew/CrewService.ts`                         | dispatch, teardown, `list`; the service the RPC and the toolkit call |
| `apps/server/src/crew/CrewSweep.ts`                           | the 60s delivery loop, the terminal rule, the zombie stop            |
| `apps/server/src/mcp/toolkits/crew/tools.ts`                  | the five MCP tools and their failure schemas                         |
| `packages/contracts/src/crew.ts`                              | row/snapshot schemas and the crew error types                        |
| `packages/client-runtime/src/state/crew.ts`                   | the `crew.list` query atom                                           |
| `apps/web/src/state/crew.ts`, `apps/web/src/hooks/useCrew.ts` | the web atom binding and the poll hook                               |
| `apps/web/src/components/CrewPanel.tsx`                       | the panel, shared by both sidebars                                   |

**Modified:** `Migrations.ts` · `packages/contracts/src/{orchestration,rpc,index}.ts` · `ProjectionSnapshotQuery.ts` (three shell-mapping sites) · `ProviderSessionReaper.ts` · `ws.ts` · `auth/RpcAuthorization.ts` · `server.ts` · `server.test.ts` · `serverRuntimeStartup.ts` · `packages/client-runtime/package.json` (`exports`) · `Sidebar.tsx` · `LegacySidebar.tsx` · `CommandPalette.tsx` · `provider/{Services,Layers}/ProviderTurnStallWatchdog.ts` · `integration/orphanedProviderSessionStartup.integration.test.ts` · `push/WebPushRelay.ts` · `relay/AgentAwarenessRelay.ts` · `apps/web/src/hooks/useThreadCompletionNotifications.ts`

Task order is dependency order. Tasks 1-4 are self-contained and land first; 5-7 need them; 8-10 are the surfaces; 11 is the gate.

---

### Task 1: Migration 51 and the crew repository

**Files:**

- Create: `apps/server/src/persistence/Migrations/051_CrewTasks.ts`
- Create: `apps/server/src/crew/CrewRepository.ts`
- Modify: `apps/server/src/persistence/Migrations.ts:172` (append the entry)
- Test: `apps/server/src/persistence/Migrations/051_CrewTasks.test.ts`

**Interfaces:**

- Consumes: `SqlClient.SqlClient` from the layer context.
- Produces: `crew_tasks(task_id TEXT PK, parent_thread_id TEXT NOT NULL, crew_thread_id TEXT NOT NULL, project_id TEXT NOT NULL, base_ref TEXT, branch TEXT NOT NULL, worktree_path TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`; `crew_reports(report_id TEXT PK, task_id TEXT NOT NULL, state TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL, noted_at TEXT, reply_to TEXT)`. Indexes `ix_crew_tasks_parent(parent_thread_id)`, `ix_crew_tasks_crew(crew_thread_id) UNIQUE`, `ix_crew_tasks_status(status)`, `ix_crew_reports_task(task_id, created_at)`.

- [ ] **Step 1: Write the failing migration test**

```ts
// 051_CrewTasks.test.ts
import { migrationEntries } from "../Migrations.ts";

// The ids deployed before this change. A literal, never derived from
// migrationEntries — derived, the predicate below is `every(id => true)` and
// passes on id 34 inserted in sorted position (spec §11).
const LEGACY = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32, 33, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
]);

it("LEGACY is the deployed set, not a truncated paste", () => {
  expect(LEGACY.size).toBe(49);
});

it("every id is legacy or above the applied high-water mark", () => {
  const ids = migrationEntries.map(([id]) => id);
  expect(ids.every((id) => LEGACY.has(id) || id > 50)).toBe(true);
});

it.each([
  ["correct: id 51", [...LEGACY, 51], true],
  ["defect: id 34 in sorted position", [...LEGACY, 34], false],
  ["defect: id 50 reused", [...LEGACY, 50], true], // caught by the uniqueness test below
])("%s", (_label, ids, expected) => {
  expect(ids.every((id) => LEGACY.has(id) || id > 50)).toBe(expected);
});

it("ids are unique and strictly ascending", () => {
  const ids = migrationEntries.map(([id]) => id);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort((a, b) => a - b)).toEqual(ids);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/server && ../../node_modules/.bin/vp test run src/persistence/Migrations/051_CrewTasks.test.ts`
Expected: FAIL — `Cannot find module './051_CrewTasks.ts'` once the import is added, or the high-water assertion fails because entry 51 does not exist yet.

- [ ] **Step 3: Write the migration**

```ts
// 051_CrewTasks.ts
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS crew_tasks (
      task_id TEXT PRIMARY KEY NOT NULL,
      parent_thread_id TEXT NOT NULL,
      crew_thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      base_ref TEXT,
      branch TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS ix_crew_tasks_parent ON crew_tasks (parent_thread_id)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS ix_crew_tasks_crew ON crew_tasks (crew_thread_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS ix_crew_tasks_status ON crew_tasks (status)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS crew_reports (
      report_id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      state TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      noted_at TEXT,
      reply_to TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS ix_crew_reports_task ON crew_reports (task_id, created_at)`;
});
```

Register it in `Migrations.ts`: import as `Migration0051` and append `[51, "CrewTasks", Migration0051],`.

- [ ] **Step 4: Assert the migration executes, not only that the ids parse**

Add to the test file: run the migrator against an in-memory database and assert both tables exist via `PRAGMA table_info`, and that `ix_crew_reports_task` appears in `PRAGMA index_list(crew_reports)`. Follow `042_ProjectionThreadLinkedPullRequest.test.ts` for the harness.

- [ ] **Step 5: Write `CrewRepository.ts`** with `insertTask`, `getTaskByCrewThreadId`, `getTasksByParentThreadId`, `countOpenTasks`, `closeTask`, `insertReport`, `selectUnnoted` (`WHERE noted_at IS NULL ORDER BY (state = 'progress'), created_at`), `stampNoted(reportId)` returning `changes()`, and `countNonAnswerReports(taskId)`. Row schemas live in `packages/contracts/src/crew.ts`.

- [ ] **Step 6: Run the tests, then commit**

```bash
cd apps/server && ../../node_modules/.bin/vp test run src/persistence/Migrations/051_CrewTasks.test.ts src/crew/
git add apps/server/src/persistence apps/server/src/crew packages/contracts/src/crew.ts
git commit -m "feat(crew): add crew_tasks and crew_reports, migration 51"
```

---

### Task 2: `crewRole` on the thread shell, and its producer

**Files:**

- Modify: `packages/contracts/src/orchestration.ts` (add to `OrchestrationThreadShell`)
- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` (three shell-mapping sites, ~`:2302`, `:2453`, `:2740`)
- Test: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.crewRole.test.ts`

**Interfaces:**

- Consumes: migration 51's `crew_tasks` (Task 1).
- Produces: `crewRole?: "bridge" | "crewmate" | "crewmate-closed"` on `OrchestrationThreadShell`, read by Task 3 (reaper) and Task 10 (notifications).

**Why three values and not two:** the reaper must exempt only live crew threads, while notification suppression must hold _through_ teardown — teardown closes the row at step 1 and archives the thread at step 7, and `stopSession` at step 5 sits between them, so a `status='open'` scope has already dropped the role in the window where the push fires (spec §3).

- [ ] **Step 1: Write the failing producer test**

```ts
const arms = [
  ["bridge parenting an open task", "bridge"],
  ["crewmate owning an open task", "crewmate"],
  ["crewmate whose task closed", "crewmate-closed"],
  ["bridge whose only task closed", undefined],
  ["a thread with no crew row", undefined],
] as const;

it.each(arms)("%s -> %s", async (_l, expected) => {
  const shell = await getThreadShellById(threadId);
  expect(shell.crewRole).toBe(expected);
});

// The defect arm: derive the role without the status split.
it("DEFECT: one status scope for both arms leaks the role in the teardown window", async () => {
  const shell = await getThreadShellByIdUnscoped(closedCrewmateThreadId);
  expect(shell.crewRole).toBe(undefined); // the wrong value this defect produces
});
```

- [ ] **Step 2: Run it and watch it fail** — `crewRole` does not exist on the type yet.

- [ ] **Step 3: Add the contracts field**

```ts
crewRole: Schema.optionalKey(Schema.Literals(["bridge", "crewmate", "crewmate-closed"])),
```

- [ ] **Step 4: Fill it at all three sites, spread only when present**

```ts
...(crewRole !== undefined ? { crewRole } : {}),
```

Derive with one correlated read per snapshot, not a new service — a service costs 248 errors, or 43 across 8 test files once the layer is wired (spec §3). Measured cost of the read is 0.0396 ms against 0.564 ms for one of `getShellSnapshot`'s five existing queries.

- [ ] **Step 5: Run the new test and the existing snapshot suite**

Run: `cd apps/server && ../../node_modules/.bin/vp test run src/orchestration/Layers/ProjectionSnapshotQuery`
Expected: PASS, including the pre-existing `assert.deepEqual(shellSnapshot.threads, …)` which goes red if you emit `crewRole: null`.

- [ ] **Step 6: Typecheck all five packages, then commit**

```bash
../../node_modules/.bin/vp typecheck   # from apps/server; repeat in contracts, client-runtime, apps/web, apps/mobile
git commit -am "feat(crew): expose crewRole on the thread shell"
```

---

### Task 3: The reaper exemption

**Files:**

- Modify: `apps/server/src/provider/Layers/ProviderSessionReaper.ts` (one `continue` in the guard chain at `:54-142`)
- Test: `apps/server/src/provider/Layers/ProviderSessionReaper.crew.test.ts`

**Interfaces:** Consumes `crewRole` (Task 2). Produces nothing.

**This is the mechanism that protects a `progress` note.** `appendSessionNote` queues into an in-process `Queue` and does not touch the binding's `lastSeenAt`, so an idle bridge is the reaper's ideal target — and the reaper is 125 of 169 session stops in ten days on this machine (spec §4). Do **not** implement it via `recordTaskLiveness`/`backgroundLiveness`: that registry is in-memory and empty after a restart, it stops the bridge auto-settling, and it changes `WebPushRelay`'s category filter.

- [ ] **Step 1: Write the failing test, three arms plus a control**

```ts
// The fixture must go through the real ProjectionSnapshotQuery shell mapping.
// A hand-built shell that sets crewRole itself passes on the state that loses
// the note: "the exemption is absent" and "crewRole is never populated" are
// behaviourally identical (spec §11).
it.each([
  ["bridge with an open task", "bridge", "exempt"],
  ["crewmate with an open task", "crewmate", "exempt"],
  ["crewmate whose task closed", "crewmate-closed", "reaped"],
  ["a non-crew thread", undefined, "reaped"],
])("%s -> %s", async (_l, _role, outcome) => {
  /* drive the real sweep */
});
```

- [ ] **Step 2: Run it — expect the two `exempt` arms to fail** (today's reaper stops everything idle).

- [ ] **Step 3: Add the guard**, after the `backgroundLiveness` guard and before the pending-background-task lookup:

```ts
if (thread?.crewRole === "bridge" || thread?.crewRole === "crewmate") {
  yield *
    Effect.logDebug("provider.session.reaper.skipped-crew-thread", {
      threadId: binding.threadId,
      crewRole: thread.crewRole,
    });
  continue;
}
```

- [ ] **Step 4: Run the test (PASS), then invert it** — replace the guard with `if (false)` and confirm 2 of 3 arms go red. A guard never seen to matter is not evidence.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(crew): exempt live crew threads from the session reaper"
```

---

### Task 4: The rendering ladder

**Files:**

- Create: `apps/server/src/crew/derive.ts`
- Test: `apps/server/src/crew/derive.test.ts`

**Interfaces:** Produces `derive(task, session): CrewRendering` where `CrewRendering` is `"closed" | "blocked-on-human" | "errored" | "interrupted" | "working" | "idle-no-report" | "starting" | "unknown"`, consumed by Task 8's RPC payload.

- [ ] **Step 1: Write the test that actually discriminates**

```ts
// Reachability-of-every-rendering is the wrong quantifier: it ranges over
// outputs, so `unknown` becoming reachable makes it MORE satisfied. Enumerate
// the input enum instead (spec §11).
const BY_STATUS = {
  error: "errored",
  interrupted: "interrupted",
  running: "working",
  starting: "working",
  ready: "idle-no-report",
  idle: "idle-no-report",
  stopped: "idle-no-report",
} as const;

it.each(Object.entries(BY_STATUS))("session %s renders %s", (status, expected) => {
  expect(derive(openTask, { ...session, status })).toBe(expected);
});

it("no session record renders starting", () => {
  expect(derive(openTask, null)).toBe("starting");
});

it("unknown is produced by no real status", () => {
  const produced = Object.keys(BY_STATUS).map((s) => derive(openTask, { ...session, status: s }));
  expect(produced.filter((r) => r === "unknown")).toEqual([]);
});

it("DEFECT: a ladder missing `stopped` produces unknown for it", () => {
  expect(deriveWithoutStopped(openTask, { ...session, status: "stopped" })).toBe("unknown");
});
```

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement the ladder** — blocking, then fault, then liveness, then the fallback; key on `OrchestrationSessionStatus` (seven members) and **not** `ProviderSessionStatus` (five, sharing `running`, `ready` and — the one that would silently mis-key rule 2 — `error`).

- [ ] **Step 4: Run (PASS). Step 5: Commit** `"feat(crew): derive a task's rendering from its session"`.

---

### Task 5: The crew MCP toolkit

**Files:**

- Create: `apps/server/src/mcp/toolkits/crew/tools.ts`
- Modify: `packages/contracts/src/crew.ts` (five error types)
- Test: `apps/server/src/mcp/toolkits/crew/tools.test.ts`

**Interfaces:** Consumes `CrewRepository` (Task 1). Produces `crew_dispatch`, `crew_status`, `crew_teardown`, `crew_answer`, `crew_report`.

**Every error type declares its `failure:` schema _and_ overrides `message`.** Declaring alone yields `""` to the agent, which is strictly worse than the generic internal error it is avoiding — the server returns `error instanceof Error ? error.message : INTERNAL_TOOL_ERROR_MESSAGE` (spec §1). Precedent: `packages/contracts/src/previewAutomation.ts:644-646`.

- [ ] **Step 1: Write one test per §8 refusal row, asserting the agent-visible text**

```ts
it.each([
  ["crew_dispatch", "cap", /cap of 4/],
  ["crew_dispatch", "nested", /already a crewmate/],
  ["crew_dispatch", "thread", /archived|deleted|missing/],
  ["crew_dispatch", "provider", /OpenCode/],
  ["crew_dispatch", "browser-access", /browser access/],
  ["crew_dispatch", "disk", /free space/],
  ["crew_dispatch", "payload", /8 KiB/],
  ["crew_teardown", "no-row", /no open task/],
  ["crew_answer", "no-row", /no open task/],
  ["crew_answer", "already-answered", /already answered/],
  ["crew_report", "no-row", /no open task/],
  ["crew_report", "cap", /200/],
  ["crew_report", "bad-state", /answer/],
])("%s.%s message names the reason", async (tool, reason, pattern) => {
  const result = await callTool(tool, refusingInput(reason));
  expect(result.message).not.toBe("");
  expect(result.message).toMatch(pattern);
});

it("DEFECT: a TaggedErrorClass with no message override yields the empty string", () => {
  expect(new CrewCapReachedNoOverride({ open: 4 }).message).toBe("");
});
```

- [ ] **Step 2: Run it and watch it fail. Step 3: Implement the five tools.**

`crew_status` is scoped **per direction** — `parentThreadId = caller` returns that bridge's tasks and their reports; `crewThreadId = caller` returns the crewmate's own task and the answers addressed to it. A single `parentThreadId` scope returns nothing to a crewmate, which makes the nudge unreadable in the answer direction. Bound the output to 50 rows per task, most recent first: unbounded it returns 4 × 200 × 1 KiB = 0.78 MiB, the magnitude the coalesced payload was deleted for.

Enforcement keys on `McpInvocationContext.threadId`, which is server-resolved and absent from every tool schema. `projectId` comes from the calling thread, never from input — which is why there is no cross-project refusal.

- [ ] **Step 4: Run (PASS). Step 5: Commit** `"feat(crew): add the crew MCP toolkit"`.

---

### Task 6: The delivery sweep

**Files:**

- Create: `apps/server/src/crew/CrewSweep.ts`
- Modify: `apps/server/src/serverRuntimeStartup.ts` (fork the sweep)
- Test: `apps/server/src/crew/CrewSweep.test.ts`

**Interfaces:** Consumes `CrewRepository` (1), `ProviderService.appendSessionNote` / `listSessions` / `stopSession`, `ProjectionTurnRepository.getPendingTurnStartByThreadId`. Produces nothing importable.

**The six steps, verbatim from spec §5** — select `WHERE notedAt IS NULL ORDER BY (state='progress'), createdAt` across every task regardless of status; thread guard; turn guard for non-`progress`; append; wake; stamp last. Three things it is easy to get wrong, each of which shipped once:

1. **At most one `thread.turn.start` per _destination thread_ per pass.** A second dispatch destroys the first — `replacePendingTurnStart` clears every pending row for the thread before inserting. The destination is the bridge for a report and the crewmate for an `answer`; keying the pass on the bridge silently loses the operator's answer.
2. **A wake carries a payload only for a report the append did not place**; everything else it carries is _named_, and the destination reads it with `crew_status`. Per report, not per pass.
3. **Every row terminates.** When the thread guard fails for any of its three reasons — missing, deleted, archived — stamp `notedAt` and log `crew.deliver.abandoned`, at any task status, on the first sweep. There is no grace period: nothing in the schema counts sweeps.

- [ ] **Step 1: Write the Delivery bullet from spec §11 as a parameterised suite**, including: `progress` on a Claude bridge starts no turn **and a second sweep selects zero rows and issues no second append**; four `done` reports in one sweep are all appended and start one turn; the note text reaches the destination by **exactly one channel**; a non-Claude bridge with N `progress` plus one `needs-decision` starts one turn and delivers all N+1; two consecutive sweeps with a fresh report each start two turns; an `answer` and a `done` report on one task in one pass wake two different threads; a report whose destination is missing or deleted terminates on the first sweep.

- [ ] **Step 2: Run it — expect red across the board.** **Step 3: Implement the sweep.**

Wrap `listSessions()` in `Effect.catchCause` and run the zombie scan in its own fiber: its `never` error channel hides three `die` paths, and one unguarded call takes delivery down for the rest of the boot. Log `crew.sweep.zombie-scan-failed` once per unbroken run of failures and stop after three consecutive.

- [ ] **Step 4: Run (PASS). Step 5: Commit** `"feat(crew): deliver reports on a 60s sweep"`.

---

### Task 7: Teardown, and the watchdog method it needs

**Files:**

- Modify: `apps/server/src/provider/Services/ProviderTurnStallWatchdog.ts` (add `clearRecoveryRecord` to the shape)
- Modify: `apps/server/src/provider/Layers/ProviderTurnStallWatchdog.ts` (expose the private `clearRecord`)
- Modify: `apps/server/src/crew/CrewService.ts`
- Modify: `apps/server/integration/orphanedProviderSessionStartup.integration.test.ts` (its inline stub of the shape breaks on the new member — one line)
- Test: `apps/server/src/crew/CrewService.teardown.test.ts`

**Interfaces:** Produces `clearRecoveryRecord(threadId: ThreadId): Effect.Effect<void>`.

**Seven steps, close first, none latches.** Step 1 `status='closed'` · 2 `clearRecoveryRecord` · 3 `revokeActiveMcpThread` · 4 `TerminalManager.close` · 5 `stopSession` (a missing binding is success) · 6 clear `worktreePath`/`branch` from thread meta · 7 archive the crewmate. Steps 3-7 commute; **step 1 runs first and step 2 precedes step 5**.

- [ ] **Step 1: Write the teardown suite, with the step-2 clause inverted**

```ts
// With step 2 stubbed to fail AND a recovery record awaiting a stop, the
// watchdog DOES resume the torn-down thread. That arm is the defect step 2
// retires, and it must go red on the correct implementation (spec §11).
it("step 2 stubbed to fail -> the watchdog resumes a stopped, archived, closed thread", async () => {
  const dispatched = await runTeardown({ step2: "fail" });
  expect(dispatched).toContain("thread.turn.start");
});
it("step 2 working -> no resume", async () => {
  const dispatched = await runTeardown({ step2: "ok" });
  expect(dispatched).not.toContain("thread.turn.start");
});
```

Plus: closes the row first; a `stopSession` error still frees the slot; an already-archived or deleted crewmate does not fail it; `worktreePath` is cleared; the zombie stop makes at most three attempts per thread per boot and **not** a fourth.

- [ ] **Step 2-4: Red, implement, green. Step 5: Commit** `"feat(crew): tear a task down without latching"`.

---

### Task 8: `crew.list` RPC and the client atom

**Files:** `packages/contracts/src/{rpc,index}.ts` · `apps/server/src/ws.ts` · `apps/server/src/auth/RpcAuthorization.ts` · `apps/server/src/server.ts` · `apps/server/src/server.test.ts` · `packages/client-runtime/src/state/crew.ts` · `packages/client-runtime/package.json` · `apps/web/src/state/crew.ts` · `apps/web/src/hooks/useCrew.ts`

**Measured at 143 lines over 12 files**, built end to end twice. Two traps, both reproduced: omitting the `server.test.ts` `Layer.mock` leaves the server package at **320 errors**; omitting the `client-runtime` `exports` entry typechecks clean in client-runtime and fails in web with `TS2307`. Both totality gates are compile-enforced, so the panel cannot silently be empty.

**Follow `useResourceQueue` exactly** — 60s idle, 5s while open, last snapshot latched. Copy three behaviours the precedent has: mount the section **whether or not it is expanded** (the repo's sidebar sections render the header always and rows only when expanded, so a poll inside the collapsed body means no cadence and no count); reset the latched snapshot to null when `environmentId` is null; and note that polling stops while the tab is hidden, self-healing on focus. Do **not** copy the discarded query error — `crew.list` has no in-band `available:false`, so surface an error state.

- [ ] **Step 1: Write the contracts test** — an old client decodes a snapshot without the RPC; the scope-map totality test accepts the new entry.
- [ ] **Step 2: Red. Step 3: Add the RPC, scope, handler, service layer, `Layer.mock`, atom, `exports` entry, web hook.**
- [ ] **Step 4: Typecheck all five packages; run `apps/server` `src/auth/RpcAuthorization.test.ts` and `apps/web` `src/hooks`.**
- [ ] **Step 5: Commit** `"feat(crew): read crew rows over a unary RPC"`.

---

### Task 9: The Crew panel

**Files:** `apps/web/src/components/CrewPanel.tsx` (new) · `Sidebar.tsx` · `LegacySidebar.tsx` · `CommandPalette.tsx`

**Mount in `Sidebar.tsx` first** — `legacySidebarEnabled` defaults to `false`, but `LegacySidebar.tsx` needs it too; factor the panel into one shared component. `Teardown` is also a command-palette entry, because neither sidebar renders on the Settings route and the palette has no registration API.

Actions: `Answer` (an unanswered `needs-decision` exists) · `Teardown` (`open`) · `Forget worktree` (`closed` only) · `Re-run teardown` (a `closed` row whose thread is still in a session) · `Open thread`. **There is no `Delete worktree`** — crew deletes nothing; reclaiming is teardown then `git worktree remove --force`, by hand.

**Crewmate text renders plain** — no markdown, links or images, length-clamped. Not because of `dangerouslySetInnerHTML` (`ChatMarkdown` pairs `rehypeRaw` with `rehypeSanitize`) but because that sanitize schema extends `protocols` with `"file"` for `href` and `src`.

- [ ] **Steps: test the panel's action availability per status, implement, drive the live UI in both sidebar modes, commit.**

---

### Task 10: Notification suppression on all three emitters

**Files:** `apps/server/src/push/WebPushRelay.ts` · `apps/server/src/relay/AgentAwarenessRelay.ts` · `apps/web/src/hooks/useThreadCompletionNotifications.ts`

All three read the same projection (`getThreadShellById` twice, the client shell stream once), so `crewRole` reaches all three. The web hook runs in the browser and cannot reach the server's log store, so assert it in a web unit test by the notification not being raised.

- [ ] **Step 1: Write both halves**

```ts
it("a crewmate thread settling raises no notification", …);
// Without this second clause a predicate that suppresses unconditionally passes,
// and so does the obvious inverted fixture (spec §11).
it("a non-crew thread settling still notifies on all three", …);
```

- [ ] **Steps 2-5: red, implement, green, commit** `"feat(crew): suppress completion notifications for crew threads"`.

---

### Task 11: Wire the cross-reference gate into verify

**Files:** `package.json` (add to the `verify` script) · `docs/superpowers/specs/tools/crew-xref.py` (already committed at `3b4ee9d31`)

- [ ] **Step 1:** Add `python3 docs/superpowers/specs/tools/crew-xref.py docs/superpowers/specs/2026-08-16-crew-orchestration-design.md` to `verify`.
- [ ] **Step 2:** Run `pnpm verify` end to end and paste the output.
- [ ] **Step 3: Commit.**

---

## Acceptance (spec §12)

Run with `T3CODE_CREW_MAX_CONCURRENT_TASKS=2` on non-production ports. All thirteen clauses name something an operator or a test can read; work through them in order and record the observable for each.
