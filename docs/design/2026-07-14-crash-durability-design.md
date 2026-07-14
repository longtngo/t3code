# Prevent server OOM crashes + make long-running work survive restart — 2026-07-14

> **Implementation outcome (branch `fix/server-oom-crash-durability`, gate-green,
> not yet merged/deployed):** Shipped the crash cure (Step 2a drain-pump), the
> Step 1 gauge, and the deleted-thread read-model eviction. **Dropped** the
> git-fetch quieting as unwarranted (measured: 1 error/boot, not a storm).
> **Deferred** Step 2b (WS heartbeat), foreground-turn resume, and the remaining
> secondary leaks to follow-up branches. Details:
> `~/reports/t3code/2026-07/2026-07-14/2026-07-14-server-oom-crash-durability.md`.

## Goal

The user's long-running agent work keeps dying "because the t3code service
rebooted." Two asks:

1. **Prevent the crash/reboot where possible.** The service is OOM-crashing.
2. **Make long-running work durable** so it survives a restart.

> Consolidated from five independent passes: a leak hunt, a restart-durability
> map, a blind `/rca` (given only the raw symptom), and **two rounds of adversarial
> design review**. Round 2 overturned the first draft's primary fix — recorded
> below so the reasoning isn't lost.

## Premises — validated live (Hard Rule 8)

Two independent investigations reached the **same mechanism** from the log + code.

| Premise | Status | Evidence |
|---|---|---|
| Crashes are a **V8 heap-OOM abort** + launchd auto-restart — not an external kill or machine reboot | **CONFIRMED (2× independent)** | 49× `FATAL … heap out of memory` (V8 abort); launchd bare `KeepAlive=true` + `ThrottleInterval=5` relaunches in ~5 s. Not jetsam (128 GB RAM, no pressure). `launchctl` last-exit **-9 is a red herring** — it's the 09:32 `t3-rebuild kickstart -k`, not the recurring killer |
| **Unbounded leak**, not a spike | **CONFIRMED** | Ceiling raised 4→12 GB (Jul 9) only moved OOM from ~2.4 h to **13–21 h** uptime; heap climbs ~1 GB/h; GC works (RSS dips) |
| Restart amplifies damage | **CONFIRMED** | 160 restarts / 49 OOM this window; each SIGKILLs in-flight work |
| Background-task recovery **already works**; foreground turns are abandoned | **CONFIRMED** | `BackgroundTaskRecoveryWatchdog` (migration 033) fired **240×** (e.g. thread `1c3fbd3f` — the user's own thread) resuming orphaned bg-tasks. `BootTurnReconciler` only stops+interrupts foreground turns. **Recovery isn't the problem — the crash loop is; it resumes work, then OOMs again before it finishes** |
| Resume/dedup primitives exist | **CONFIRMED** | `resumeCursor` re-applied on next `startSession`; durable `orchestration_events`; SQL `orchestration_command_receipts` dedup deterministic `commandId`s across boots |

### Leak source — localized and confirmed by mechanism

**The global event hub is `PubSub.unbounded`, and a WS subscription's take-loop is
coupled to a blockable socket write.**
- `eventPubSub = PubSub.unbounded<OrchestrationEvent>()` (`OrchestrationEngine.ts:97`);
  **every** domain event publishes here (`:223`). **Verified.**
- **Every** consumer subscribes to this one hub: the correctness-critical internal
  reactors (`ProviderCommandReactor.ts:1312`, `CheckpointReactor.ts:837`,
  `ProviderRuntimeIngestion.ts:2122`, `ThreadDeletionReactor.ts:94`,
  `AgentAwarenessRelay.ts:472`) **and** each WS thread client
  (`ws.ts:1046`, filtering to its thread *after* dequeue). **Verified.**
- Effect `PubSub.unbounded` retains a message until **every** current subscriber
  has taken it. A WS subscriber whose socket write blocks (dead mobile socket, no
  close frame — heavy Tailscale/screen-off churn here) **backpressures its own
  take-loop → stops draining → the hub retains all threads' events for it forever**
  → 12 GB over 13+ h.
- **This dissolves the earlier "only 2 live sockets yet ~1 GB/h" paradox:** the
  fingerprint is a stalled *subscription take-loop*, not live TCP socket count.

**Secondary leaks (real, smaller — opportunistic):** command read model never
evicts deleted/archived threads (`OrchestrationEngine.ts:94`, `projector.ts:333-345`);
adapter `turns[]` arrays; never-pruned per-thread `Semaphore` maps. **Ruled out
(verified bounded):** provider session bindings (SQLite row count, not a map);
git-fetch cache (Effect `Cache` cap 2048 + TTL); DEFLATE window (freed on disconnect).

## Approach — the minimal set that solves the user's actual complaint

Both review rounds converged: **the crash loop is the whole problem; recovery
already works.** So the build is deliberately scoped to *stop the crash*, plus the
cheap independent cleanups. Bigger durability work is deferred until measured.

### Ship 1 — Non-disruptive leak gauge + git-fetch noise cleanup (cheap, independent, first)

- **Gauge (confirms the leak at zero disruption).** There is ~1 heap-telemetry
  line in the entire log. Add periodic logging on an existing sweep timer:
  `PubSub.size(eventPubSub)` + active-subscriber count, `process.memoryUsage().heapUsed`
  / `v8.getHeapStatistics()` ratio, and WS subscription open/close markers. Watch
  hub size + heapUsed climb → confirms the firehose-retention leak directly.
  (On-demand heap snapshot kept only as a fallback if the gauge does *not*
  implicate the hub → would point at the secondary #2/#3.)
- **Git-fetch quieting.** The upstream-status fix (`5a5ff6099`) **is deployed** and
  correctly fail-*fasts* (`GIT_TERMINAL_PROMPT=0`), but ~38k `could not read
  Username` failures still fire (post-boot) against an auth-requiring remote
  (`sparse-attn-lab`), spamming the 52 MB log (which would obscure the gauge reads)
  and burning CPU. Cheap fix: cache the auth-failure and back off long / let the
  user exclude the repo. Not the OOM cause; fully independent.

### Ship 2 — Prevent the crash (the cure): decouple WS drain from the socket, + reap dead sockets

Round-2 review proved the first draft's "bound the hub / drop-on-overflow" wrong on
two counts, both now designed around:
- **The hub must stay unbounded.** Effect's drop policy is fixed at *construction*
  and applies to **all** subscribers — a `sliding`/`dropping` hub would silently
  starve the internal reactors (a dropped `turn-start-requested` → a turn committed
  but never driven). No per-subscriber policy exists.
- **Silent drop-while-connected is unrecoverable.** The client *deliberately* does
  no gap-detection (`service.ts:474`) and only resyncs on **reconnect** — a
  mid-stream drop diverges it permanently (stuck spinner / missing tool result).

**2a — Per-WS decoupled draining pump (the real cure).** Structurally guarantee
that **no WS subscriber can ever pin the hub**, without touching the hub's policy:
a per-connection fiber that **always** takes from `PubSub.subscribe(eventPubSub)`
immediately and offers into a per-connection **non-blocking bounded buffer**; the
socket writer drains that buffer. Because the take-loop is decoupled from the
(blockable) socket write, it never stalls → the hub always reclaims. On buffer
overflow (dead or slow socket) **close the connection** — never silently drop — so
the client reconnects and catches up via the *existing* `fromSequenceExclusive`
resync (`ws.ts:1067`). This covers **both** trigger classes (dead socket *and*
slow-but-alive), keeps the hub unbounded (reactors never lose events), and never
diverges the client. Buffer size is a tunable knob.

**2b — Server-side heartbeat + idle-socket reaper (complementary hygiene).** Node's
HTTP server has no idle-timeout and there is no server-side ping today (only
client-side, `wsRpcProtocol.ts:508`). Add periodic ping + pong-deadline; on miss,
close the socket so its scope releases — reclaiming a dead subscriber *proactively*,
before its 2a buffer even fills. **Invariant (state in code):** reaping a socket is
read-path only and **never** affects an in-flight turn (turns are driven off the
command queue by `ProviderCommandReactor`, fully decoupled from any WS socket) — a
false reap costs only a reconnect + resync. Heartbeat interval/deadline are knobs.

**2c — Secondary-leak evictions (opportunistic, low-risk, same or follow-up PR):**
evict deleted/archived threads from the command read model; cap adapter `turns[]`;
prune per-thread `Semaphore` maps on session stop.

Not crashing is the best restart-survival, so this is the priority. After it ships,
**observe the Ship-1 gauge for a few days** — confirm heapUsed plateaus and hub size
stays bounded before doing anything else.

### Deferred (data-gated) — foreground-turn resume

Background-task-bearing threads already recover (the common case — the user's own
long threads spawn bg-tasks and *did* recover 240×). A plain foreground turn with
no bg-task row is still abandoned on restart — but after Ship 2 removes the OOM
loop, the only remaining trigger is a **deploy or OS reboot** (rare, human-timed),
and whether residual foreground abandonment actually hurts *this* workload is
**unmeasured**. So this is deferred to its own branch, built **only if** the Ship-1
gauge/telemetry shows real residual foreground abandonment after the crash stops.

When built, it must (recorded now so the round-1 correctness fixes aren't lost):
- Run as a **post-reactor sweep** (not from the pre-reactor `BootTurnReconciler`,
  whose dispatch is published before reactors subscribe → dropped, C2) **with an
  explicit "reactors subscribed" barrier** (subscriptions are lazy via `forkScoped`
  — post-reactor placement alone isn't sufficient, round-2 MEDIUM-4), or route
  recovery through the eager `subscribeDomainEvents`.
- Persist a recovery-intent row keyed to the interrupted turn (migration; reuse
  `pending_background_tasks` with a `kind` column), increment attempts **before**
  dispatch, and delete the row **only on a terminal turn event** — never on
  dispatch — so a *slow* post-resume OOM actually hits the attempt cap (C1). The
  **existing bg-task path shares this delete-on-dispatch flaw** and should be fixed
  in the same change, or "one unified mechanism" is a misnomer.
- Attempt-keyed idempotent `commandId` (double-boot-safe via the receipt store, C3);
  one owner per thread with explicit per-thread dedup in the sweep (C4); per-provider
  stale-cursor → cold-start-with-notice (C6).
- Plus: frequent event-checkpointing so a resumed turn re-derives done-work.

### Not building — memory-pressure guard

Documented as a fallback recipe only, **not shipped**. It is insurance for a leak
that Ship 2 *fixes*; a default-off feature is dead code plus a restart-loop surface.
If Ship 2 measurably fails to hold, the recipe is: own `v8.getHeapStatistics()` loop
(not `ProcessResourceMonitor`, which samples RSS via `ps`); soft threshold + idle
(no active turn, no pending approval/input) → `process.exit(0)` (launchd restarts);
hard ceiling gated on **post-GC occupancy / N consecutive breaches** (not an
instantaneous sawtooth peak); maintenance-mode aware (or it races `rebuild-t3code`);
relies on the plist's bare `KeepAlive=true`. Its env knobs are **not** added until
it exists.

## Alternatives considered

- **Raise `--max-old-space-size` again.** Rejected — already 4→12 GB; only delayed
  OOM and lengthens the GC pause.
- **Make the hub `sliding`/`dropping`.** Rejected — starves the internal reactors
  (round-2 CRITICAL-1); the hub must stay unbounded.
- **Per-WS bounded queue that silently drops middle events.** Rejected — the client
  has no mid-stream gap detection, so it diverges permanently (round-2 CRITICAL-2).
  Overflow must *disconnect* (→ reconnect-resync), not drop.
- **Heartbeat reaper (2b) as the sole cure.** Insufficient alone — a slow-but-alive
  client still pins the unbounded hub (round-2 HIGH-3 / simplicity review). 2a is
  what closes the invariant; 2b is hygiene.
- **Ship foreground-turn resume now.** Deferred — recovery already works for the
  common case; it's the largest/riskiest chunk and would gate an urgent, high-
  confidence crash fix behind a speculative one whose need is unmeasured.
- **Always-on memory guard.** Rejected — masks the leak Ship 2 fixes.

## Files touched (Ship 2 finalized after the Ship-1 gauge reads)

- `ws.ts` + `OrchestrationEngine.ts` — per-WS draining pump + bounded buffer +
  overflow-disconnect (2a); heartbeat/idle reaper (2b); gauge (Ship 1).
- `projector.ts` / adapters / `terminal/Layers/Manager.ts` — secondary evictions (2c).
- VCS status-fetch path — git-fetch quieting.
- New knobs (2a buffer size, 2b heartbeat interval/deadline) + docs.

## Tradeoffs & limitations

- **2a overflow disconnects a slow client**, which then resyncs — a brief catch-up,
  not data loss (events are durable). A persistently bad link may reconnect-loop
  (bounded, tunable via buffer size) — still far better than OOM.
- **Runtime note:** the "no idle-timeout" premise is the **Node** path (prod runs
  `node dist/bin.mjs` per the plist — confirmed). `server.ts` also has a **Bun**
  branch whose WS server has a default `idleTimeout`; 2b is only strictly needed
  under Node. Verify before assuming universality.
- **Deferred foreground resume** means a *deploy/OS-reboot* during a foreground-only
  turn still abandons it until that follow-up ships — acceptably rare post-Ship-2.

## Follow-ups deferred

- Foreground-turn resume (data-gated, above); detached long-external-subprocess
  reattach; queued-command persistence; memory-guard (recipe recorded).
