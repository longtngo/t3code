# Reboot-survivable background-task recovery heartbeat — 2026-06-07

## Problem

A long-lived **background task** (Claude Agent SDK `Bash run_in_background` watcher, or a
background `Agent`/Task) running on an otherwise **idle** thread can leave the thread wedged
forever. The existing wake path (`maybeWakeThreadForCompletedTask`,
`orchestration/Layers/ProviderRuntimeIngestion.ts:1263`) only resumes an idle thread **when a
`task.completed` runtime event arrives**. If that event never arrives, the thread waits forever.

Two concrete ways the event never arrives:

1. **Server restart (BE/FE rebuild — the reported case).** The t3code server process restarts;
   the SDK subprocess and its in-flight background tasks die with it. No `task.completed` is ever
   emitted. Nothing persisted survives the restart to notice the orphaned task.
2. **Idle-session reap mid-task.** `ProviderSessionReaper` stops a session after 30 min idle
   (`ProviderSessionReaper.ts`). A thread "idle" except for a background watcher looks reapable;
   reaping it kills the live watcher — same silent death.
3. **SDK silently drops the task** while the session stays alive (the bug report's literal
   hypothesis: a ~59-min watcher reaped by the SDK with no `task_notification`).

Confirmed by investigation: **no persisted record exists** that a thread had a background task in
flight (no table, no `task_id → thread` map), and **no startup reconciliation** walks pre-restart
threads. The new `ProviderTurnStallWatchdog` (shipped earlier today) only watches _active turns_,
not idle threads waiting on a background task — so it does not cover this.

## Requirement (from the user)

> The solution needs to be stable across BE and FE rebuild so the background heartbeat service can
> survive server reboot.

So the recovery state **must be persisted** (survive a process restart), and a startup +
periodic **heartbeat** must reconcile it. Confirmed decisions:

- **Recovery action:** auto-resume & continue (inject a wake message; matches the existing
  `task.completed` wake precedent).
- **Detection scope:** both the dead-process/reboot trigger **and** a stale-timeout backstop.
- **Build:** end-to-end now.

## Design

### 1. Persist in-flight background tasks (new table)

Migration `033_PendingBackgroundTasks`:

```sql
CREATE TABLE IF NOT EXISTS pending_background_tasks (
  task_id            TEXT PRIMARY KEY,
  thread_id          TEXT NOT NULL,
  started_at         TEXT NOT NULL,   -- ISO; when task.started was ingested
  last_seen_at       TEXT NOT NULL,   -- ISO; refreshed on task.progress
  recovery_attempts  INTEGER NOT NULL DEFAULT 0,
  summary            TEXT,            -- last known summary (from task.progress), nullable
  output_file        TEXT             -- nullable
);
CREATE INDEX IF NOT EXISTS idx_pending_background_tasks_thread
  ON pending_background_tasks(thread_id);
```

A dedicated table (not a column on `provider_session_runtime`) because the cardinality is
task-not-thread (a thread can have multiple background tasks) and the lifecycle is independent.

Persistence stack mirrors `ProviderSessionRuntime`:

- `persistence/Services/PendingBackgroundTask.ts` — `Schema.Struct` row + repository `Context.Service`
  (`upsert`, `getByTaskId`, `listByThreadId`, `list`, `deleteByTaskId`, `incrementAttempts`).
- `persistence/Layers/PendingBackgroundTask.ts` — `SqlSchema`-based SQL impl.
- Registered in `persistence/Migrations.ts` as entry `[33, "PendingBackgroundTasks", Migration0033]`.

A thin domain wrapper is **not** needed (unlike `ProviderSessionDirectory`, there is no driver/instance
decoding); the recovery watchdog and ingestion talk to the repository directly. (Design review to
confirm: repository-only vs. directory wrapper. Leaning repository-only for simplicity.)

### 2. Ingestion writes the rows

In `ProviderRuntimeIngestion.processRuntimeEvent`, keyed off the **background** discriminator
(`eventTurnId === undefined`, the same rule the wake path uses — turn-scoped tasks are plan
subtasks, not "check back later" watchers):

- `task.started` (background) → `repository.upsert({ taskId, threadId, startedAt: now, lastSeenAt: now, recoveryAttempts: 0, summary: null, outputFile: null })`.
- `task.progress` (background) → refresh `lastSeenAt = now` (and `summary` if present). Upsert-on-conflict so a progress without a preceding started still records.
- `task.completed` / `task.stopped` (background) → `deleteByTaskId(taskId)`. This is the normal happy path: the existing wake fires and the row is cleared, so recovery never triggers.

All writes are best-effort: wrap in `Effect.catchCause` + `logWarning` so a persistence hiccup never
breaks event ingestion (mirrors the wake path's catch).

### 3. Recovery heartbeat (`BackgroundTaskRecoveryWatchdog`)

New service mirroring `ProviderSessionReaper`:
`provider/Services/BackgroundTaskRecoveryWatchdog.ts` (tag) +
`provider/Layers/BackgroundTaskRecoveryWatchdog.ts` (impl). `start(): Effect<void, never, Scope>`.

**Boot fence.** At layer construction, capture `bootedAtMs = yield* Clock.currentTimeMillis`. This is
the reboot signal: any pending row whose `started_at < bootedAtMs` was written by a **previous
process** (the SDK subprocess that owned it is provably dead). No per-row epoch tagging or
instance-id needed — process boot time cleanly partitions "prior boot" from "this boot".

**Sweep** (forked, `Schedule.spaced(sweepIntervalMs)`, runs immediately on start so startup
reconciliation = the first tick):

For each pending row:

1. Resolve the thread shell (`ProjectionSnapshotQuery.getThreadShellById`). If missing/archived → delete row (orphaned record), continue.
2. **Skip if the thread is busy/blocked** — don't interrupt real work:
   `session.activeTurnId != null` OR `hasPendingApprovals` OR `hasPendingUserInput`. (Leave the row;
   re-evaluate next sweep.)
3. Determine orphaned:
   - **Trigger A — prior boot (reboot/crash):** `Date.parse(startedAt) < bootedAtMs`. Definitively
     orphaned; the owning process is gone.
   - **Trigger B — stale backstop (same boot):** `Date.parse(startedAt) >= bootedAtMs` **and**
     `now - Date.parse(lastSeenAt) >= staleThresholdMs`. Covers the SDK-silently-dropped-task case.
     Conservative default threshold to avoid false-tripping legitimately long, quiet watchers.
4. If orphaned and the thread is idle:
   - If `recoveryAttempts >= maxAttempts` → log give-up, **delete** the row (stop retrying), continue.
   - Else `incrementAttempts`, then **auto-resume**: dispatch `thread.turn.start` with a wake message,
     then `deleteByTaskId`.

**Recovery message** (distinct from the happy-path wake so the agent knows to re-verify rather than
trust a completion it never saw):

```
Background task <taskId> was interrupted before it reported completion
(<reason: server restart | prolonged silence>).
<Last known summary: …>  <Output file: …>
Re-check whether the work it was waiting on actually finished, then continue.
```

Dispatch via the orchestration engine, exactly like `maybeWakeThreadForCompletedTask`
(`thread.turn.start` with a deterministic `commandId`/`messageId` derived from `taskId` +
`recoveryAttempts` for idempotency). Because we only recover **idle** threads (no active turn), the
two-phase stop→resume dance the stall watchdog needed is **not** required here — `turn.start` runs
immediately, and if the thread's session is down (post-reboot), the dispatch path's existing
`recoverSessionForThread` resumes it. Dispatch wrapped in a timeout + `catchCause` so a wedged
subprocess can't wedge the sweep.

**Config** (mirror the reaper — module consts + env overrides, no contract changes):

- `DEFAULT_SWEEP_INTERVAL_MS = 60_000`
- `DEFAULT_STALE_THRESHOLD_MS = 2 * 60 * 60_000` (2 h) — Trigger B only
- `DEFAULT_MAX_RECOVERY_ATTEMPTS = 3`
- env: `T3CODE_BG_TASK_RECOVERY=0` (disable), `T3CODE_BG_TASK_STALE_THRESHOLD_MS`.

### 4. Reaper guard (remove a contributing cause)

In `ProviderSessionReaper.sweep`, **skip reaping a session whose thread has a pending background
task** (`repository.listByThreadId(threadId)` non-empty). Rationale: a thread with a live background
watcher is _not_ truly idle; reaping its session kills the watcher (Trigger 2 above). This both
prevents the premature kill and keeps the watcher's session alive so the normal `task.completed`
wake can still fire. (If the session genuinely needs reaping later, the recovery watchdog's Trigger B
backstop still covers a wedged task.)

### Why this satisfies "survive reboot"

The pending-task rows are in SQLite, written as tasks start and deleted as they complete. They
outlive any process restart. On the next boot, the heartbeat's **first sweep** sees every row whose
`started_at` predates the new boot and auto-resumes those threads — the durable record + startup
reconciliation that was entirely missing before.

## Alternatives rejected

- **Reuse `provider_instance_id` as the boot signal** — it's a _config routing_ key (driver instance),
  not a per-process identity; it does not change across restarts. Process boot time is the correct
  partition.
- **Track in-memory only (like the stall watchdog)** — fails the explicit requirement; in-memory
  state dies with the process, which is exactly the failure being fixed.
- **Add a column to `provider_session_runtime`** — wrong cardinality (multiple tasks per thread) and
  couples two independent lifecycles.
- **Live-session liveness probe instead of boot-time partition** — more coupling to adapter internals;
  boot-time `started_at` comparison is simpler and strictly sufficient for the reboot case, with the
  reaper guard + Trigger B covering the same-boot cases.

## Scope / non-goals (v1)

- Surface-only / "Continue?" UI affordance (user chose auto-resume).
- Reviving the dead task process itself (impossible — recovery re-runs the agent so it re-checks).
- Telemetry counters to tune the stale threshold from real trips (follow-up).

## Revised design (after adversarial review)

Two adversarial design reviews (correctness/races + simplification) surfaced one showstopper and
several correctness issues. Revisions:

- **[CRITICAL C1] The `eventTurnId === undefined` write discriminator is inverted.** Verified against
  the SDK + adapter: a background task's `task_started` fires _while the launching turn is still
  active_, so `base` (`ClaudeAdapter.ts:2404-2409`) stamps the launching `turnId`. `eventTurnId` is
  only `undefined` at _completion_ (after the turn ends). There is **no `is_backgrounded` flag** on
  `task_started`/`task_notification` (only on `task_updated.patch`). "Background-ness" is a
  completion-time property. **Fix:** record a row for **every** `task.started` (keyed by `taskId`),
  delete on **every** `task.completed`/`stopped` (by `taskId`). Turn-scoped tasks (plan subtasks,
  foreground subagents) self-delete at completion and are never recovered because the watchdog only
  acts on **idle, turn-less** threads (a thread mid-turn has `activeTurnId != null` → skipped). Over-
  recording is safe and cheap.
- **[M3] Boot fence uses a per-process `boot_id`, not timestamp comparison.** Mint one random UUID at
  startup (`RuntimeBootId` service), stamp it on every row at write time. Trigger 1 prior-boot =
  `row.boot_id !== currentBootId` — immune to clock skew and the "started just before the watchdog
  captured bootedAt" race. Eliminates the dependency on `started_at < bootedAtMs`.
- **[M2] Dispatch ordering = increment attempts → dispatch `turn.start` → delete row.** On dispatch
  **success** delete the row (so a successful recovery doesn't accumulate attempts across reboots —
  M6 resolves naturally: the resumed turn creates fresh rows with the new `boot_id`). On dispatch
  **failure** leave the row + log; next sweep retries, bounded by the attempt cap. Recovery `messageId`
  is deterministic (`user:task-recovery:${taskId}:${attempt}`).
- **[M5 / Trigger 2 risk] Two recovery triggers, mapped to the user's two choices:**
  - **Trigger 1 — dead session (no false positives):** `row.boot_id !== currentBootId` (reboot/crash)
    **OR** same-boot but the thread's current `session.status` is not live (`!== "ready"`/running —
    session crashed/was reaped). Strong signal; the owning session is provably gone.
  - **Trigger 2 — stale-timeout backstop (user-requested, documented false-positive):** same-boot +
    session still live + `now - last_seen_at >= staleThresholdMs` (default 2 h). Covers the report's
    "SDK silently dropped a live-session watcher" hypothesis. **Caveat:** can re-prompt a legitimately
    long, quiet watcher; the recovery message tells the agent to re-verify, and a late real completion
    would double-wake. Accepted tradeoff (the user opted into the backstop); conservative threshold +
    `T3CODE_BG_TASK_STALE_THRESHOLD_MS` override; deferred telemetry will tune it.
- **[M6] Attempt cap is per-boot in effect** — delete-on-success means a successful reboot recovery
  leaves no row, so independent reboots don't accumulate toward give-up. The cap only bounds repeated
  _dispatch failures_ within a boot.
- **[M7] Wedged recovery turns** are covered by the already-shipped `ProviderTurnStallWatchdog`
  (active-turn stall). The reaper guard + stall watchdog together prevent an indefinite session pin.
- **[m11] NaN/defect guards** mirror `ProviderSessionReaper` (`Number.isNaN(Date.parse(...))` skip +
  `Effect.catch`/`catchDefect` inside the repeated sweep so one bad row can't kill the fiber).
- **[Simplification R3] Schema trimmed** to `(task_id PK, thread_id, boot_id, started_at,
last_seen_at, recovery_attempts)`. Dropped `summary`/`output_file` — the recovery message is
  deliberately "re-verify whether the work finished," so stale context adds noise. `last_seen_at` is
  refreshed on `task.progress` (needed by Trigger 2).
- **[Simplification R4] Repository-only, no directory wrapper** — rows are inert scalars; no
  driver/instance decoding like `ProviderSessionDirectory` needs.
- **[Simplification R1 — considered, declined] Fold into `ProviderSessionReaper`?** The reaper
  iterates provider _bindings_; recovery iterates _tasks_ (different domains, different intervals).
  Kept separate for clearer lifecycle/testing; the reaper guard is a one-line read of the task repo.

Net shape: migration `033` + `PendingBackgroundTaskRepository`; a `RuntimeBootId` service; ingestion
writes (started → upsert, progress → touch `last_seen_at`, completed/stopped → delete) co-located
with the existing `task.completed` wake at `ProviderRuntimeIngestion.ts:~1773`; a
`BackgroundTaskRecoveryWatchdog` (Trigger 1 + Trigger 2); a reaper guard.

## Test plan

- **Repository**: upsert/get/list/listByThreadId/delete/incrementAttempts round-trips (in-memory SQLite).
- **Ingestion writes**: background `task.started` inserts a row; `task.progress` refreshes
  `last_seen_at`; `task.completed`/`stopped` deletes; turn-scoped (eventTurnId set) tasks are ignored.
- **Recovery watchdog**: Trigger A (prior-boot row → resume + delete), Trigger B (same-boot stale →
  resume), fresh same-boot row left alone, busy thread (active turn / pending approval / pending
  input) skipped, archived/missing thread → row deleted, attempt cap → give-up + delete, happy path
  (row already deleted by completion) → no resume.
- **Reaper guard**: a session with a pending background task is not reaped; without one it still reaps.
- Full `apps/server` suite + `tsgo --noEmit`.

```

```
