# Checkpoint git-timeout resilience — 2026-07-15

**Branch:** `fix/checkpoint-git-timeout-resilience` (off `personal`)
**Task:** 4th attempt at the recurring `git add -A` 30 s timeout in
`GitVcsDriver.checkpoints.captureCheckpoint` on `routing-TSP-algo`. Prevent the timeout where
possible; make long-running work durable across it.
**Review:** 3 adversarial reviewers (correctness / simplicity / Effect-API) + independent `rca`
subagent, all verified against live code. Their findings are folded in (see "Design-review
outcome" at the end).

## Goal

Stop transient host-overload episodes from turning idempotent git operations — above all
checkpoint capture — into hard, user-visible failures (a "capture failure" activity in the
thread + a checkpoint gap for that turn). Long research/experiment runs that saturate the shared
machine currently produce exactly this.

## Root cause (consolidated: primary investigation + independent `rca` subagent, verified vs code)

The two investigations **agree**; the one disagreement (a hypothesised shared git-execution slot
causing head-of-line blocking) was traced and **falsified** (the only semaphore in git+vcs is a
per-command `deltaMutex` for reading one command's trace2 file, `GitVcsDriverCore.ts:538` — no
shared execution slot couples repos).

- **Cause = transient host CPU/IO saturation.** During heavy workloads (the `routing-TSP-algo`
  research-team runs many CPU solvers, plus GPU training, browsers, MCP servers on a shared
  18-core laptop) git subprocesses cannot spawn+complete within their **flat wall-clock**
  timeout. Proof (server log + live repo):
  - **98** `git rev-parse --is-inside-work-tree` timeouts at **5000 ms** across **13 unrelated
    repos**, in same-second cross-repo bursts. That command does ~zero work (~50 ms) — 98 of
    them blowing 5 s across unrelated repos can only be a *host* problem.
  - Every relevant op runs **< 1.2 s idle**: `add -A` warm 0.66 s; full cold re-hash of all
    393 MiB tracked 1.16 s; empty-index cold hash 0.76 s; a 200-spawn `rev-parse` storm 0.18 s
    total (0.5 s worst). Hashing was never the bottleneck.
  - **608** checkpoint refs captured successfully vs **1** capture timeout in the log — the
    failure is rare and episodic, not steady-state.
- **t3code converts a transient overload into a hard failure.** `execute` wraps the whole
  spawn→exit in a flat `Effect.timeoutOption(timeoutMs)` (`GitVcsDriverCore.ts:766`,
  `DEFAULT_TIMEOUT_MS = 30_000` at `:42`) with **no retry**, so scheduling/starvation wait is
  charged against the work budget and a passing overload becomes a permanent op-failure. The
  failure is contained (`CheckpointReactor.ts:794-805` catches it, appends a "capture failure
  activity", continues) — non-fatal, but it surfaces a scary activity and leaves a checkpoint gap.
- **Self-inflicted amplifier (minor):** per-repo status pollers (`VcsStatusBroadcaster.makeRemoteRefreshLoop`,
  `:292-297`) repeat on the **exact** returned interval via `Schedule.identity().pipe(Schedule.addDelay(d))`
  with **no jitter**, so same-interval pollers stay phase-aligned and spawn git in **lockstep
  bursts** — the observed same-second cross-repo bursts.
- **All three prior fixes optimized hashing / git-work volume** (stat-cache real-index seed
  `d5e276e34`; untracked ≥10 MiB skip `f8015b6ef`). That is the **wrong axis** — confirmed by
  zero-work commands timing out identically. They only lower *which* repo tips first. This is why
  it recurs.

## Approach (chosen)

Two changes, in two separate commits. Change 1 is the cure; Change 2 removes the self-inflicted
trigger and is independently revertible.

### Change 1 (primary) — bounded, jittered retry of the whole `captureCheckpoint` operation

Wrap the **entire `captureCheckpoint` operation body** (`GitVcsDriver.ts:732-845`) in a single
`Effect.retry`, retrying **only** on transient failures. NOT per-`execute`-call, and NOT a
generic option threaded through the `execute` layer.

- **Why the whole-operation boundary (not per-command):** the CheckpointReactor worker is a
  **strictly serial single fiber** (`makeDrainableWorker` = `TxQueue.take → process → forever`,
  `packages/shared/src/DrainableWorker.ts:44-56`; one item at a time). A capture issues ~4-5
  `execute` calls, so per-command retry would cost up to `commands × attempts × timeout ≈
  4 × 3 × 30 s ≈ 360 s` of one capture holding the queue head and blocking every other thread's
  captures/baselines. Whole-op retry bounds it to `attempts × timeout` (~90 s worst) and gives a
  **fresh clean temp-index seed per attempt** (the seed copy happens inside the retried body,
  `GitVcsDriver.ts:755-762`), so no shared partial-index state across attempts.
- **Transient classification via the existing Vcs error tags (implementation correction).**
  The three design reviewers all assumed `captureCheckpoint` fails with `GitCommandError` and so
  recommended adding a structured `reason` field to it. **That premise is wrong:** capture runs
  through the `VcsProcess` execution path, whose error channel is already the *distinct tagged
  types* `VcsProcessTimeoutError` / `VcsProcessSpawnError` / `VcsProcessExitError` /
  `VcsOutputDecodeError` / … (`packages/contracts/src/vcs.ts:89-145`) — **not** `GitCommandError`.
  So no new field is needed: the transient discriminant already exists as tags. The retry
  predicate is a plain boolean `isTransientVcsError(e) => e._tag === "VcsProcessTimeoutError" ||
  e._tag === "VcsProcessSpawnError"` (structural `_tag` match — no schema dependency, no
  substring-matching, and `VcsProcessExitError`/decode/detection are correctly excluded). The
  earlier `reason`-on-`GitCommandError` change was reverted.
- **Policy (Effect v4.0.0-beta.78 verified):**
  `Schedule.exponential("500 millis").pipe(Schedule.jittered, Schedule.both(Schedule.recurs(recurs)))`
  — `Schedule.both` is the v4 AND-combinator (the v3 `Schedule.intersect` does **not** exist);
  `Schedule.jittered` scales each delay 0.8–1.2× using the default Random service (no `R` leak,
  no wiring). `recurs = max(0, attempts - 1)` (recurs(2) ⇒ 3 total attempts).
- **One env knob:** `T3CODE_GIT_RETRY_ATTEMPTS` via `parsePositiveIntEnv` (default **3**). That
  helper filters `> 0`, so `"0"` reads as unset → default; **disable by setting it to `1`**
  (recurs(0) = no retry). Base/cap delays stay hardcoded constants.
- **Fresh scope + no leaked children per attempt (verified):** `Effect.scoped` is inside the
  retried unit, so each attempt re-runs it → fresh spawn + fresh 30 s timeout. On timeout,
  `Effect.timeoutOption` → `raceAllFirst` → `fiberInterruptAll` **awaits** the loser's finalizer,
  which SIGTERMs git as a **process group** (`detached:true`) and awaits child exit *before* the
  timeout `GitCommandError` propagates. git's lockfile handler rolls back on SIGTERM, so an
  interrupted `add`/`update-ref` leaves the temp index + ref untouched and **no stale
  `<tempindex>.lock`**. Retry never overlaps the prior git process. **Guardrail:** retry must wrap
  the pipeline **outermost** and act on the **error channel only** (never `catchCause`), so a
  worker-drain/shutdown interrupt passes through as an interrupt and `processInputSafely`'s
  `Cause.hasInterruptsOnly` re-fail (`CheckpointReactor.ts:821-824`) still shuts down cleanly.
- **Give-up path unchanged:** on exhaustion the effect fails exactly as today → the existing
  "capture failure activity" path runs. Graceful under *sustained* overload.
- **Pre-flight resolve also retried.** `resolveGitCommonDir` (`git rev-parse --git-common-dir`)
  runs before the retried operation body (the temp-index path derives from it). Since a zero-work
  `rev-parse` is the command that most often times out under overload, it gets its own transient
  retry with the same policy — otherwise the fix's most likely trigger would escape it.

### Change 2 (secondary, isolated commit) — jitter the status-poller interval

Append `Schedule.jittered` to `makeRemoteRefreshLoop`'s repeat schedule
(`VcsStatusBroadcaster.ts:292-297`). One line, no new imports (Schedule already imported), no
`Random` wiring; applies the same ±20% factor so the ~13 pollers de-correlate instead of firing
git in lockstep. Value is burst/log-noise reduction, not the core cure — kept as its own commit
so it can be reverted independently. (The simplicity reviewer would defer it; included because it
is one verified-safe line that directly addresses the observed cross-repo bursts, which are part
of the "prevent timeouts where possible" goal.)

## Alternatives considered + rejection rationale

1. **Make `git add` cheaper again (the 4th hashing fix)** — REJECTED. Falsified: hashing is
   0.76 s; zero-work `rev-parse` also times out. The wrong axis the prior 3 attempts took.
2. **Just raise the timeout (30 s → 120 s) as the sole fix** — REJECTED. Delays, doesn't cure;
   fails anyway under sustained overload; makes true hangs slower to surface.
3. **Generic `retryTransient` option threaded through the `execute` layer + per-command retry** —
   REJECTED. Over-broad abstraction (one purpose, generic layer); and per-command retry multiplies
   latency on the serial worker (F3). Whole-`captureCheckpoint` retry is smaller *and* safer.
4. **Retry `diffCheckpoints` / status / detect in this branch** — DEFERRED to follow-ups. The
   reported pain is exclusively the capture-failure activity; status/detect self-heal via the
   poller's existing exponential failure-backoff (`VcsStatusBroadcaster.ts:56-65,278-289`).
5. **Substring-match the `detail` text for transientness** — REJECTED in favor of a structured
   `reason` field (F1); text-matching silently breaks on any message reword.
6. **Adaptive timeout excluding scheduling-wait** — REJECTED. Can't reliably observe a
   subprocess's queued-vs-running state; fragile. Retry is the robust equivalent.
7. **resctl-coordination / global git-spawn concurrency cap** — DEFERRED (follow-ups). t3code's
   own spawns are cheap idle (200-storm 0.18 s); defense-in-depth, not the cause.

## Load-bearing premise (Hard Rule 8) — validated

**Premise:** a retry succeeds because the overload is transient. **Evidence:** 608 successful
captures vs 1 timeout; timeouts occur in episodic same-second bursts (not sustained); every git
op runs < 1.2 s idle; a 200-spawn storm is 0.5 s worst-case idle. A retry after a short jittered
backoff will, with high probability, land after the burst passes. **VALIDATED.**

## Files touched

- `apps/server/src/vcs/gitRetry.ts` (new) — `isTransientVcsError` predicate, bounded jittered
  `makeTransientGitRetrySchedule`, `resolveGitRetryAttempts` (env `T3CODE_GIT_RETRY_ATTEMPTS`).
- `apps/server/src/vcs/GitVcsDriver.ts` — wrap `captureCheckpoint` body in the bounded jittered
  `Effect.retry` on the `isTransientVcsError` predicate (module-level `captureRetrySchedule`).
- `apps/server/src/vcs/VcsStatusBroadcaster.ts` — append `Schedule.jittered` (Change 2).
- `apps/server/src/vcs/gitRetry.test.ts` (new, `@effect/vitest` `it.effect`/`it.live`; zero
  `Effect.runPromise` per the `no-manual-effect-runtime-in-tests` lint): predicate classification;
  retry-on-transient(timeout/spawn)→success; no-retry-on-`exit`; bounded-attempts exhaustion →
  original failure preserved; `attempts=1` disables; real jittered schedule retries to success.
- (No contract change — the transient discriminant reuses existing `VcsProcess*Error` tags.)

## Tradeoffs & known limitations

- Under *sustained* overload, a retried capture holds the **serial** CheckpointReactor worker
  while it retries. The common case is `attempts × timeout` (~90 s at defaults) since each attempt
  stops at its first timeout; the pathological upper bound is `commands × timeout × attempts` if
  several commands each run just under the timeout per attempt (still ≤ the rejected per-command
  scheme). It is rare (1/608) and the alternative is an immediately-lost checkpoint; on exhaustion
  the existing failure path runs. Tunable down via `T3CODE_GIT_RETRY_ATTEMPTS`.
- **Predicate edges (accepted):** `VcsProcessSpawnError` also covers a genuinely permanent
  `ENOENT` (git binary missing) — retried pointlessly, but bounded (~3 fast attempts + backoff).
  Conversely a git child OOM-killed by the host (SIGKILL → exit 137) surfaces as
  `VcsProcessExitError` and is **not** retried, even though it is an overload symptom — a
  deliberate consequence of "never retry a real exit."
- Retry mildly increases git spawns under overload (≤3× capture) but they are ~timeout-spaced
  (sustained) or backoff-spaced past the burst (transient), not a new burst.
- Does not reduce the host load itself (the experiment workload is outside t3code) — retry rides
  over it. resctl-coordination (follow-up) could actively yield.
- **Wedged-git edge (pre-existing, not worsened):** there is no SIGKILL escalation
  (`forceKillAfter`) on the spawn finalizer, which blocks on child exit. A git stuck in
  uninterruptible IO that ignores SIGTERM would hang the finalizer → the timeout never resolves →
  retry can't fire. Rare; complementary hardening = set `forceKillAfter`. Follow-up.

## Follow-ups deferred

- SIGKILL-escalation (`forceKillAfter`) on the git spawn finalizer (covers the wedged-git edge).
- Retry the read-only ops too (`diffCheckpoints`, status/detect) — cut the 98-count `rev-parse`
  log noise and classify the other transient `reason: "io"` cases for retry.
- Global git-spawn concurrency semaphore; resctl-aware deferral of heavy captures under a heavy
  machine lease.
- Repo-config guidance for the user's repo (mark large binary `.npy` in `.gitattributes`).

## Design-review outcome (3 reviewers, 1 round, quiescent)

- **Correctness (F3):** per-command retry on the serial worker → up to 360 s head-blocking →
  moved to **whole-`captureCheckpoint`** retry. **(F1)** no structured transient signal → **add
  `reason`**. **(F2)** idempotency safety verified to rest on SIGTERM-rollback + finalizer-awaits-exit
  (now cited). **(F4)** predicate must stay on the error channel — guardrail recorded. F5/F6 accepted.
- **Simplicity:** drop the generic `execute` option and the read-only opt-ins (→ whole-capture
  wrap + follow-ups); one env knob only; noted `parsePositiveIntEnv`'s `>0` filter (disable via 1).
- **Effect-API (v4.0.0-beta.78):** `Effect.retry(self, { schedule, while })`; **`Schedule.both`
  not `intersect`**; `recurs(2)` ⇒ 3 attempts; `Schedule.jittered` = ±20%, default Random, no `R`
  leak; `while` a plain predicate keeps `E` unnarrowed; tests via `it.effect` + `TestClock.adjust`.

## Deploy note

The running server builds from the **main checkout** (`~/src/playground/t3code`), so deploying
needs merge-to-`personal` + `t3-rebuild`, which **restarts `com.t3code.server` — killing the very
long-running process this fix protects.** Do not auto-deploy: land on `personal`, gate-green, then
confirm timing with the user (deploy when their run is safe to interrupt).
