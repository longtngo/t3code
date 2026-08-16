# Thread-load windowing + bounded backfill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the design first: `docs/superpowers/specs/2026-07-08-thread-load-windowing-design.md`.

**Goal:** Cap the initial thread-open snapshot (opt-in per subscribe input) and backfill older turns in the background up to a bounded client ceiling, killing the 99 MB single-frame load without regressing scrollback.

**Architecture:** Server `getThreadDetailById` gains optional turn-window bounds; `subscribeThread` accepts `windowTurns`/`maxRows` and returns `oldestLoaded`/`hasMoreHistory`; a new unary RPC `getThreadHistoryPage` serves older turn-pages. The web client raises its activity cap to a ceiling, changes `syncServerThreadDetail` from wholesale-replace to per-collection merge/upsert, and runs a paced background backfill loop stored on the existing subscription entry. Windowing is opt-in: no window params ⇒ full snapshot (mobile/other clients unchanged).

**Tech Stack:** Effect (Schema, SQL, Stream), TypeScript, Zustand (web store), LegendList (virtualized timeline), vite-plus test runner (`describe`/`it` from `"vite-plus/test"`).

## Global Constraints

- Windowing is **opt-in per subscribe input**: `getThreadDetailById`/`subscribeThread` with no `windowTurns`/`maxRows` MUST return the full thread (backward compat — mobile + the 3 server reactor callers rely on this).
- New contract fields MUST be `Schema.optional` (additive both directions).
- Per-collection ordering, NOT a uniform `(created_at,id)` keyset: activities `compareActivities` (sequence-first), messages/plans `(created_at,id)`, checkpoints `checkpoint_turn_count`.
- Scalar/head thread fields (title/session/latestTurn) still **replace** from a snapshot; only the four collections merge-by-id. `getThreadHistoryPage` returns **collections only** (no head).
- `hasMoreHistory` = a real EXISTS-older-than-boundary check, never "page filled its limit".
- Backfill: single page in flight, paced, **paused when `document.hidden`**, cancelled on subscription dispose; stops on `hasMoreHistory===false` OR ceiling reached.
- Verify gate: `pnpm run verify` (= `typecheck && lint && test && test:browser`). Run per-package test with `vp test run <file>` from the package dir.
- Fork trunk is `personal`; land via squash-merge to `personal` (no npm release).

---

### Task 1: Contract — window inputs, snapshot fields, history-page RPC

**Files:**

- Modify: `packages/contracts/src/orchestration.ts` (`OrchestrationSubscribeThreadInput` ~:456-467; `OrchestrationThreadDetailSnapshot` ~:469-473; `OrchestrationRpcSchemas` ~:1286-1315; add new schemas near `OrchestrationReplayEvents*` ~:1278-1284)
- Test: `packages/contracts/src/orchestration.test.ts` (or the existing contract test file — grep for one; else create)

**Interfaces (Produces — later tasks consume these exact names):**

- `OrchestrationHistoryCursor = { requestedAt: IsoDateTime; turnId: string | null; checkpointTurnCount: number | null }`
- `OrchestrationSubscribeThreadInput` adds optional `windowTurns?: number`, `maxRows?: number`
- `OrchestrationThreadDetailSnapshot` adds optional `oldestLoaded?: OrchestrationHistoryCursor`, `hasMoreHistory?: boolean`
- `OrchestrationThreadHistoryPageInput = { threadId: ThreadId; beforeTurn: OrchestrationHistoryCursor; maxTurns: number; maxRows: number }`
- `OrchestrationThreadHistoryPageResult = { messages; activities; proposedPlans; checkpoints; oldestLoaded?: OrchestrationHistoryCursor; hasMoreHistory: boolean }`
- `OrchestrationRpcSchemas.getThreadHistoryPage = { input, output }`

- [ ] **Step 1: Write the failing test** — assert the new schemas decode/encode and that optional fields default correctly.

```ts
// in the contracts test file, using the project's Schema decode helper (mirror an existing schema test)
import * as Schema from "effect/Schema";
import {
  OrchestrationSubscribeThreadInput,
  OrchestrationHistoryCursor,
  OrchestrationThreadHistoryPageInput,
} from "./orchestration.ts";

it("subscribe input accepts window params and stays optional", () => {
  const bare = Schema.decodeUnknownSync(OrchestrationSubscribeThreadInput)({ threadId: "t_1" });
  expect(bare.windowTurns).toBeUndefined();
  const windowed = Schema.decodeUnknownSync(OrchestrationSubscribeThreadInput)({
    threadId: "t_1",
    windowTurns: 15,
    maxRows: 2000,
  });
  expect(windowed.windowTurns).toBe(15);
});

it("history cursor + page input round-trip", () => {
  const cur = {
    requestedAt: "2026-07-01T00:00:00.000Z",
    turnId: "turn_9",
    checkpointTurnCount: 12,
  };
  const decoded = Schema.decodeUnknownSync(OrchestrationHistoryCursor)(cur);
  expect(decoded.turnId).toBe("turn_9");
  const page = Schema.decodeUnknownSync(OrchestrationThreadHistoryPageInput)({
    threadId: "t_1",
    beforeTurn: cur,
    maxTurns: 25,
    maxRows: 3000,
  });
  expect(page.maxTurns).toBe(25);
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd packages/contracts && npx vp test run src/orchestration.test.ts` → FAIL (`OrchestrationHistoryCursor` not exported).

- [ ] **Step 3: Implement the schemas.** Mirror the existing `Schema.Struct` / `Schema.optional` / `NonNegativeInt` / `IsoDateTime` / `TrimmedNonEmptyString` idioms already in the file.

```ts
export const OrchestrationHistoryCursor = Schema.Struct({
  requestedAt: IsoDateTime,
  turnId: Schema.NullOr(TrimmedNonEmptyString),
  checkpointTurnCount: Schema.NullOr(NonNegativeInt),
});
export type OrchestrationHistoryCursor = typeof OrchestrationHistoryCursor.Type;

// OrchestrationSubscribeThreadInput: add inside the existing Struct
//   windowTurns: Schema.optional(NonNegativeInt),
//   maxRows: Schema.optional(NonNegativeInt),

// OrchestrationThreadDetailSnapshot: add inside the existing Struct
//   oldestLoaded: Schema.optional(OrchestrationHistoryCursor),
//   hasMoreHistory: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(Effect.succeed(false))),

export const OrchestrationThreadHistoryPageInput = Schema.Struct({
  threadId: ThreadId,
  beforeTurn: OrchestrationHistoryCursor,
  maxTurns: NonNegativeInt,
  maxRows: NonNegativeInt,
});
export type OrchestrationThreadHistoryPageInput = typeof OrchestrationThreadHistoryPageInput.Type;

export const OrchestrationThreadHistoryPageResult = Schema.Struct({
  messages: Schema.Array(OrchestrationMessage),
  activities: Schema.Array(OrchestrationThreadActivity),
  proposedPlans: Schema.Array(OrchestrationProposedPlan),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  oldestLoaded: Schema.optional(OrchestrationHistoryCursor),
  hasMoreHistory: Schema.Boolean,
});
export type OrchestrationThreadHistoryPageResult = typeof OrchestrationThreadHistoryPageResult.Type;

// OrchestrationRpcSchemas: add entry (mirror replayEvents)
//   getThreadHistoryPage: { input: OrchestrationThreadHistoryPageInput, output: OrchestrationThreadHistoryPageResult },
```

Also add `getThreadHistoryPage: "orchestration.getThreadHistoryPage"` to the method-name const map (mirror `subscribeThread` at ~:32).

- [ ] **Step 4: Run test to verify it passes** — same command → PASS. Then `npx vp run typecheck` in `packages/contracts`.

- [ ] **Step 5: Commit** — `git add packages/contracts/src/orchestration.ts* && git commit -m "feat(contract): thread-window subscribe params + getThreadHistoryPage RPC"`

---

### Task 2: Server — windowed `getThreadDetailById` + `hasMoreHistory`

**Files:**

- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` (`getThreadDetailById` ~:1919-2056; the four row queries ~:788/809/829/899; mirror the turn-count-bounded precedent `getFullThreadDiffContext` ~:1835-1846)
- Test: the existing ProjectionSnapshotQuery test file (grep `getThreadDetailById` under `apps/server/src/**/*.test.ts`; else the layer's test)

**Interfaces (Produces):**

- `getThreadDetailById(threadId, options?: { windowTurns?: number; maxRows?: number })` → returns `{ value: OrchestrationThread; oldestLoaded: OrchestrationHistoryCursor | undefined; hasMoreHistory: boolean }` (extend the current return; keep `.value` shape).
- Helper `resolveWindowBoundary(threadId, windowTurns, maxRows)` → `{ boundaryRequestedAt, boundaryTurnId, boundaryCheckpointTurnCount } | null` (null ⇒ whole thread fits / no window).

**Implementation direction:** When `options` is undefined OR both bounds absent → run the existing four unbounded queries unchanged, return `oldestLoaded: undefined, hasMoreHistory: false` (FULL behavior — Global Constraint). When windowed:

1. `resolveWindowBoundary`: select the newest `windowTurns` turns from `projection_turns WHERE thread_id = ? ORDER BY requested_at DESC, turn_id DESC LIMIT ?`; then walk them accumulating each turn's row-count (messages+activities+plans for that turn_id) and stop early when the running total would exceed `maxRows`; the last included turn defines the boundary `(requested_at, turn_id, checkpoint_turn_count)`. Mirror the turn-scoping in `getFullThreadDiffContext` (~:1835).
2. Each collection query adds a boundary predicate: messages/activities/plans `WHERE thread_id = ? AND (turn_id IN (<window turn ids>) OR (turn_id IS NULL AND created_at >= :boundaryRequestedAt))`; checkpoints `WHERE thread_id = ? AND checkpoint_turn_count >= :boundaryCheckpointTurnCount`. Keep each query's existing ORDER BY.
3. `hasMoreHistory` = `EXISTS(SELECT 1 FROM projection_turns WHERE thread_id = ? AND (requested_at, turn_id) < (:boundaryRequestedAt, :boundaryTurnId))` (a real older-turn check).

- [ ] **Step 1: Write failing tests** (seed a thread with, say, 40 turns of 1 message + 3 activities each; use the test file's existing seed helpers).

```ts
it("no window options → full thread unchanged", () =>
  Effect.gen(function* () {
    const q = yield* ProjectionSnapshotQuery;
    const full = yield* q.getThreadDetailById(threadId);
    expect(full.value.messages.length).toBe(40);
    expect(full.hasMoreHistory).toBe(false);
  }).pipe(runInLayer));

it("windowed to latest 15 turns caps rows and reports hasMoreHistory", () =>
  Effect.gen(function* () {
    const q = yield* ProjectionSnapshotQuery;
    const win = yield* q.getThreadDetailById(threadId, { windowTurns: 15, maxRows: 2000 });
    expect(win.value.messages.length).toBe(15);
    expect(win.hasMoreHistory).toBe(true);
    expect(win.oldestLoaded?.turnId).toBeDefined();
  }).pipe(runInLayer));

it("maxRows caps before windowTurns when a turn is huge", () =>
  Effect.gen(function* () {
    // seed one turn with 5000 activities, then assert window stops at it
  }).pipe(runInLayer));
```

- [ ] **Step 2: Run → FAIL** (`getThreadDetailById` doesn't accept options / returns old shape).
- [ ] **Step 3: Implement** per the direction above; keep the row→contract mapping identical to today (reuse the existing mappers so `OrchestrationMessage`/`Activity`/`Plan`/`CheckpointSummary` shapes are unchanged).
- [ ] **Step 4: Run → PASS**; `npx vp run typecheck` in `apps/server`.
- [ ] **Step 5: Commit** — `feat(server): windowed getThreadDetailById + hasMoreHistory`

---

### Task 3: Server — `getThreadHistoryPage` query

**Files:**

- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` (add method next to `getThreadDetailById`)
- Test: same server test file

**Interfaces (Produces):**

- `getThreadHistoryPage(input: OrchestrationThreadHistoryPageInput)` → `OrchestrationThreadHistoryPageResult` (four collections + `oldestLoaded` + `hasMoreHistory`).

**Implementation direction:** Symmetric to Task 2 but paging OLDER than the input cursor. Resolve the next `maxTurns` turns `WHERE thread_id = ? AND (requested_at, turn_id) < (:beforeTurn.requestedAt, :beforeTurn.turnId) ORDER BY requested_at DESC, turn_id DESC LIMIT :maxTurns`, cap by `maxRows` as in Task 2, select the four collections for those turns (same predicates, checkpoints by `checkpoint_turn_count` in `[newBoundaryTurnCount, beforeTurn.checkpointTurnCount)`), compute the new `oldestLoaded` + `hasMoreHistory` EXISTS check. Return collections only (no thread head).

- [ ] **Step 1: Write failing test** — after Task 2 window (15 turns), page older 10 turns; assert 10 messages returned, ids disjoint from the window, `oldestLoaded` older than before, `hasMoreHistory` reflects remaining turns; a final page returns `hasMoreHistory:false`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS; typecheck.**
- [ ] **Step 5: Commit** — `feat(server): getThreadHistoryPage older-turn paging query`

---

### Task 4: Server — wire window params into the `subscribeThread` snapshot frame

**Files:**

- Modify: `apps/server/src/ws.ts` (snapshot branch ~:1061; the `getThreadDetailById` call ~:1062; snapshot frame build)
- Test: `apps/server/src/ws.test.ts` (or the existing subscribeThread test — grep `subscribeThread` under server tests)

**Interfaces (Consumes:** Task 1 input fields, Task 2 return shape. **Produces:** snapshot frame with `oldestLoaded`/`hasMoreHistory`.)

**Implementation direction:** In the snapshot branch, pass `{ windowTurns: input.windowTurns, maxRows: input.maxRows }` to `getThreadDetailById`, and spread `oldestLoaded`/`hasMoreHistory` into the emitted `{ kind: "snapshot", snapshot: { snapshotSequence, thread, oldestLoaded, hasMoreHistory } }`. The `fromSequenceExclusive` resume path (~:1029-1059) is untouched. When the client sends no window params, behavior is byte-identical to today.

- [ ] **Step 1: Write failing test** — subscribe with `{threadId, windowTurns:15, maxRows:2000}` → first stream item `kind==="snapshot"` has `snapshot.thread.messages.length===15` and `snapshot.hasMoreHistory===true`; subscribe with `{threadId}` → snapshot has full messages and `hasMoreHistory` falsy.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS; typecheck.**
- [ ] **Step 5: Commit** — `feat(server): subscribeThread honors window params + returns hasMoreHistory`

---

### Task 5: Server — `getThreadHistoryPage` RPC handler

**Files:**

- Modify: `apps/server/src/ws.ts` (add a unary handler; mirror the existing `getFullThreadDiff`/`replayEvents` handler wiring + `ORCHESTRATION_WS_METHODS` usage)
- Test: server ws test file

**Interfaces (Consumes** Task 3 query. **Produces** the RPC endpoint.)

- [ ] **Step 1: Write failing test** — call the `getThreadHistoryPage` RPC with a cursor from a prior windowed snapshot; assert older collections returned + `hasMoreHistory` correct.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — thin handler delegating to `ProjectionSnapshotQuery.getThreadHistoryPage`; mirror the auth/error handling of the neighboring unary handlers.
- [ ] **Step 4: Run → PASS; typecheck.**
- [ ] **Step 5: Commit** — `feat(server): getThreadHistoryPage RPC handler`

---

### Task 6: Client store — merge/upsert + raised activity ceiling + prepend

**Files:**

- Modify: `apps/web/src/store.ts` (`MAX_THREAD_ACTIVITIES` :132; `writeThreadState` ~:580-660; `mapThread` ~:250-261; `syncServerThreadDetail` ~:1144-1159; add a `prependThreadHistory` reducer; reuse `compareActivities` ~:847-862)
- Test: `apps/web/src/store.test.ts` (grep existing store tests for the template)

**Interfaces (Produces):**

- `MAX_THREAD_ACTIVITIES = 3000` (raised ceiling; other caps unchanged).
- `syncServerThreadDetail(...)` now merges the four collections by id (per-collection comparator) while **replacing** scalar/head fields.
- `prependThreadHistory(environmentId, threadId, page: { messages; activities; proposedPlans; checkpoints })` — upserts older rows into the four collections, dedup by id, re-sort per-collection, apply the ceiling caps.

**Implementation direction:** Extract a `mergeById(existing, incoming, idOf, comparator, cap)` helper (union by id, incoming wins on conflict, sort, `slice(-cap)`). In `writeThreadState`/`mapThread`, for the four collections use `mergeById` instead of wholesale array assignment; keep scalar/head fields (`title`, `session`, `latestTurn`, `threadShellById`, etc.) as direct replace. Activities sort with `compareActivities`; messages/plans by `(created_at, id)`; checkpoints by `checkpoint_turn_count`. Deletion pruning now relies on events (`thread.reverted`, thread-removal) — do NOT add new pruning.

- [ ] **Step 1: Write failing tests.**

```ts
it("syncServerThreadDetail merges collections by id instead of replacing", () => {
  let s = applySync(initialState, threadWith({ activities: [act("a1", 1), act("a2", 2)] }));
  s = applySync(s, threadWith({ activities: [act("a2", 2), act("a3", 3)] })); // a later snapshot
  const acts = activitiesOf(s, threadId);
  expect(acts.map((a) => a.id)).toEqual(["a1", "a2", "a3"]); // a1 retained, not wiped
});

it("prependThreadHistory adds older rows and keeps sequence order", () => {
  let s = applySync(initialState, threadWith({ activities: [act("a10", 10)] }));
  s = prepend(s, threadId, {
    activities: [act("a8", 8), act("a9", 9)],
    messages: [],
    proposedPlans: [],
    checkpoints: [],
  });
  expect(activitiesOf(s, threadId).map((a) => a.id)).toEqual(["a8", "a9", "a10"]);
});

it("head fields still replace on a new snapshot", () => {
  let s = applySync(initialState, threadWith({ title: "old" }));
  s = applySync(s, threadWith({ title: "new" }));
  expect(threadOf(s, threadId).title).toBe("new");
});
```

- [ ] **Step 2: Run → FAIL** (`cd apps/web && npx vp test run src/store.test.ts`).
- [ ] **Step 3: Implement** the `mergeById` helper, rewire `writeThreadState`, add `prependThreadHistory`, raise the cap.
- [ ] **Step 4: Run → PASS; typecheck** (`apps/web`).
- [ ] **Step 5: Commit** — `feat(web): merge-upsert thread detail + prepend history + raise activity ceiling`

---

### Task 7: Client service — send window params + background backfill loop

**Files:**

- Modify: `apps/web/src/environments/runtime/service.ts` (`ThreadDetailSubscriptionEntry` ~:107-125; `subscribeThread` call ~:425; snapshot handler; dispose ~:469-482)
- Modify: `apps/web/src/environments/runtime/environmentApi.ts` (add a `getThreadHistoryPage` client call, mirror `getTurnDiff` ~:72)
- Test: `apps/web/src/environments/runtime/service.test.ts` (grep existing subscription tests)

**Interfaces (Consumes** Task 4 snapshot fields, Task 5 RPC, Task 6 `prependThreadHistory`.)

**Implementation direction:**

1. Pass `windowTurns: INITIAL_WINDOW_TURNS (15)`, `maxRows: INITIAL_WINDOW_ROWS (2000)` on the `subscribeThread` call.
2. Add to the entry: `oldestLoaded`, `hasMoreHistory`, `backfillRunning`. On the snapshot item, store them and kick `runBackfill(entry)` if `hasMoreHistory`.
3. `runBackfill(entry)`: while `entry.hasMoreHistory` and the activity count `< MAX_THREAD_ACTIVITIES` (ceiling) and `!entry.disposed`: if `document.hidden`, await a visibility event before continuing; call `getThreadHistoryPage({ threadId, beforeTurn: entry.oldestLoaded, maxTurns: 25, maxRows: 3000 })`; `useStore.getState().prependThreadHistory(envId, threadId, page)`; set `entry.oldestLoaded = page.oldestLoaded; entry.hasMoreHistory = page.hasMoreHistory`; `await delay(BACKFILL_PAGE_DELAY_MS ≈ 150)`. Single page in flight (the loop is sequential). On dispose (~:469-482) set `entry.disposed = true` so the loop exits.

- [ ] **Step 1: Write failing tests** (mock the RPC): snapshot with `hasMoreHistory:true` triggers sequential `getThreadHistoryPage` calls until `hasMoreHistory:false`; a `dispose()` mid-loop stops further calls; loop stops when the activity ceiling is hit even if `hasMoreHistory` still true; no window params are sent when a caller opts out (default sends them).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS; typecheck.**
- [ ] **Step 5: Commit** — `feat(web): windowed subscribe + paced background history backfill`

---

### Task 8: Integration + guard tests

**Files:**

- Test: an integration test co-located with the server ws tests (full subscribe→snapshot→backfill), plus a browser test if the timeline prepend needs coverage (`apps/web/src/components/chat/MessagesTimeline.*test*`).

**Covers (design guards):**

- End-to-end: windowed subscribe on a large seeded thread → small snapshot (no full-history frame) → backfill converges to the ceiling window; a no-window subscribe still returns the full thread (**C1 opt-in guard**).
- **C2 deletion pruning**: after the merge change, a `thread.reverted` event still trims reverted rows (assert a reverted message id is gone).
- Prepend-doesn't-jump: with LegendList `maintainVisibleContentPosition` (`MessagesTimeline.tsx:296`), a prepend keeps the anchored row visible (assert scroll offset stable or the anchored item stays mounted).

- [ ] **Step 1: Write the integration + guard tests** (concrete, per above).
- [ ] **Step 2: Run → FAIL where not yet wired.**
- [ ] **Step 3: Fix any wiring gaps surfaced.**
- [ ] **Step 4: Run the FULL gate** — `pnpm run verify` from repo root; expect 0 failures.
- [ ] **Step 5: Commit** — `test: thread-window integration + opt-in/pruning/prepend guards`

---

## Self-review notes

- Spec coverage: window (T2/T4), row cap (T2), turn-id per-collection selection (T2/T3), opt-in (T2/T4/T8), getThreadHistoryPage (T1/T3/T5/T7), merge-upsert + comparators + head-replace (T6), raised ceiling (T6), backfill loop + pause-when-hidden + cancel-on-dispose + ceiling stop (T7), hasMoreHistory EXISTS (T2/T3), null-turn_id rows (T2), scroll anchoring reuse (T8), event-only pruning (T8). `haveNewest` intentionally omitted (deferred per spec).
- Type consistency: `OrchestrationHistoryCursor`, `oldestLoaded`, `hasMoreHistory`, `getThreadHistoryPage`, `prependThreadHistory`, `MAX_THREAD_ACTIVITIES=3000`, `INITIAL_WINDOW_TURNS=15`/`INITIAL_WINDOW_ROWS=2000`/`maxTurns=25`/`maxRows=3000` used consistently across tasks.
- No placeholders in test code; server SQL steps give exact predicates + the `getFullThreadDiffContext` precedent to mirror (Effect-SQL bodies are written by the implementer against the real file, per subagent-driven-development).
