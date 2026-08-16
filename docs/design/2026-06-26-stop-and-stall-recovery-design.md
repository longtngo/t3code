# Stop & stall-recovery robustness on a tool-wedged turn — 2026-06-26

## Goal

Make Stop (and the stall watchdog) actually work when an agent turn is blocked on a
long-running / hung foreground tool (e.g. `wc -l` on a multi-GB file). Today such a turn:

1. **false-trips** the `ProviderTurnStallWatchdog` (it thinks the provider went silent), and
2. is **unkillable** — neither the watchdog's `thread.session.stop` nor the user's Stop button
   has any effect; the session spins "Working…" until the whole server is restarted.

This was diagnosed live (thread `0323b89f`, turn `f0155aef`, 2026-06-26 20:22–21:16 UTC). A
Bash `command_execution` went in-flight at 20:22:58 and never returned; the watchdog tripped 3×
(false), recovery "exhausted" at 20:47, the Stop button did nothing, and the turn only ended at
21:16 when `t3-rebuild` SIGKILLed the server.

## Three independent bugs

- **A — Watchdog false-trips on a tool-blocked turn.** `shouldTrip` infers "a tool is in-flight"
  from `entry.lastEventType ∈ {item.started, item.updated}`
  (`ProviderTurnStallWatchdog.ts:51,241`). But `recordTurnActivity` overwrites `lastEventType` on
  **every** non-ignored event (`ProviderRuntimeIngestion.ts:881`), and `thread.token-usage.updated`
  is _not_ ignored — it landed **1 ms after** the in-flight `item.updated` (20:22:59.182 →
  .183), erasing the in-flight marker. 16 min later the guard is blind → false trip.

- **B — A wedged turn is unkillable; the stop path deadlocks.** `stopSessionInternal`
  (`ClaudeAdapter.ts:2839`) calls `Fiber.interrupt(streamFiber)` (2877) **before** `query.close()`
  (2880). The stream fiber is parked in the SDK async-iterator's `.next()` awaiting a message from
  the wedged subprocess; `Fiber.interrupt` awaits that fiber, whose pending Promise never settles
  → `close()` is **never reached**. The SDK's own teardown (`close()` → stdin-EOF → SIGTERM →
  SIGKILL after 5 s, verified in `sdk.mjs`) therefore never starts. The reactor
  (`ProviderCommandReactor.ts:1009`) `await`s `providerService.stopSession` **with no timeout**
  before flipping the projection to `stopped` (1012), so the session stays `running` forever and
  the spinner never clears.

- **C — The Stop button never escalates.** `onInterrupt` (`ChatView.tsx:3356`) only dispatches
  `thread.turn.interrupt` → `query.interrupt()`, a _cooperative_ control message the busy
  subprocess can't read mid-tool. There is no fallback to a hard stop.

## Verified premises (Hard Rule 8)

- **A1 ✓** Every `item.*` runtime event carries a stable `itemId` (e.g. `toolu_01…`); the hung
  command's `item.started` (20:22:58) has **no** matching `item.completed` — verified in the live
  provider log.
- **A2 ✓** Foreground-tool itemTypes observed in the stream are exactly
  `{command_execution, file_change, dynamic_tool_call, collab_agent_tool_call}`. `assistant_message`
  streams via `content.delta` and does **not** emit `item.started`, so tracking open _tool_ items
  never masks a genuine mid-generation SDK wedge.
- **A3 ✓** `recordTurnActivity` (`ProviderRuntimeIngestion.ts:834`) is the single chokepoint that
  builds `TurnActivitySnapshot`; it can carry an open-tool-item set with no new event source.
- **B1 ✓ (corrects a falsified premise).** The original idea — "wrap the injected
  `ChildProcessSpawner` to capture the child handle" — is **false** for the session path: the
  session `queryOptions` (`ClaudeAdapter.ts:3326`) injects **no** spawner; the SDK spawns the
  subprocess itself. The real, verified mechanism is the SDK's own `close()`, which performs
  stdin-EOF → SIGTERM → `kill("SIGKILL")` after 5 s (confirmed in the bundled `sdk.mjs`). So Bug B
  needs no custom spawn — only to stop deadlocking before `close()` runs.
- **B2 ✓** `close()` is non-blocking (ends stdin, arms timers) and starts the SIGKILL clock
  regardless of subprocess state — so calling it _first_ and bounding the fiber-interrupt is
  sufficient to guarantee teardown.
- **C1 ✓** Once Bug B makes `thread.session.stop` actually terminate and flip the projection, the
  Stop control has a working hard-stop to escalate to.

## Approach

### A — track open foreground-tool items, not "last event type"

Add `openToolItemIds: ReadonlySet<string>` to `TurnActivitySnapshot`. In `recordTurnActivity`:

- on `item.started` whose `itemType ∈ FOREGROUND_TOOL_ITEM_TYPES` → add its `itemId`;
- on `item.completed` (any status) for a tracked `itemId` → remove it;
- `turn.started` initialises an empty set; terminal types delete the whole entry (unchanged).

`shouldTrip` replaces the `IN_FLIGHT_LAST_EVENT_TYPES.has(lastEventType)` check with
`entry.openToolItemIds.size === 0`. This is immune to interleaved `token-usage` / `content.delta`
events and precisely models "the turn is blocked waiting on a foreground tool result." A genuine
SDK wedge (tool completed, no follow-up inference; or a wedge with no tool open) still has an empty
set → still trips, as intended. `lastEventType` is retained for telemetry only.

`FOREGROUND_TOOL_ITEM_TYPES = {command_execution, file_change, dynamic_tool_call, collab_agent_tool_call}`.

`itemId` is `Schema.optional` on `ProviderRuntimeEventBase` (contracts), so add/remove is **guarded
on `itemId` presence** — a malformed item event without an id simply isn't tracked rather than
leaking. Any residual stale id is bounded to the turn: the snapshot entry is deleted on the turn's
terminal event (and by the 1 h TTL prune), so it can never permanently silence a thread.

### B — bound every cooperative await on the stop/interrupt paths (adapter only)

Both cooperative awaits on the Claude stop/interrupt paths are unbounded, and either can hang
forever when the subprocess is wedged in a tool. Both are fixed in `ClaudeAdapter`:

1. **`interruptTurn` (the VERIFIED, reproduced blocker).** It `await`ed `query.interrupt()`, which
   awaits an SDK control-response the wedged subprocess never sends. It runs on the single reactor
   command worker, so a hang there also stalls every later command — including the watchdog's and
   the user's `session.stop`. This is the path the user's Stop button hits. **Bound it**
   (`Effect.timeoutOption`): the control message was already written, so abandoning the await just
   means the cooperative interrupt didn't land — Bug C's escalation then issues a hard
   `session.stop`. A new test hangs against the pre-fix code and passes against the fix.
2. **`stopSessionInternal` (evidence-supported hardening).** It interrupted the SDK stream fiber
   **before** calling `query.close()`. `close()` is what arms the SDK's own stdin-EOF → SIGTERM →
   SIGKILL(~5 s) teardown, so it must run first; the `Fiber.interrupt` is now also bounded so it
   can never deadlock on a stream parked in the wedged subprocess's `.next()`. Production evidence
   supports this being a real blocker (the session did not die at the watchdog's first stop, so
   teardown blocked _before_ `close()`), though a faithful unit fake interrupts the parked fiber
   cleanly, so this part is treated as hardening rather than a separately-reproduced bug.

Once both adapter methods return promptly, the reactor reaches its existing
`setThreadSession({status:"stopped", activeTurnId:null})` step and the projection flips — so **no
reactor change is needed**. The design review's rejected reactor-level `timeout`+`ensuring` wrapper
would also be _less safe_ (flipping the projection while teardown still drains risks a
projection-vs-provider split-brain). Letting the projection flip only after the adapter finishes is
simpler and correct.

### C — make Stop escalate

Client-side escalation in the Stop control (`ChatView.tsx onInterrupt`), state held **locally in
the component** (a `useRef` keyed by thread id) — no new global-store state:

1. First Stop click → dispatch `thread.turn.interrupt` (graceful, unchanged), record that this
   thread was interrupted, and arm a short escalation timer (~6 s).
2. If the turn is still running (existing running-state signal: `session.status === "running"` /
   `isLatestTurnSettled`) when the timer fires **or** the user clicks Stop again → dispatch
   `thread.session.stop` (a real, fast hard-stop via Bug B). Clear the local state/timer when the
   turn ends or the active thread changes.

The auto-timer is deliberate, not speculative: the user's literal complaint is that a _single_
Stop press did nothing, so a single press must eventually force-stop without requiring a second
click. The manual second-click path shares the same handler (≈free). Escalation is client-side
because the trigger ("stop it now") and the running-state both live in the client and the server
already exposes a working `thread.session.stop`. The button relabels "Stop" → "Force stop" after
the first interrupt for feedback.

## Alternatives considered

- **Bug B via a custom `spawnClaudeCodeProcess` to capture the child and SIGKILL it directly.**
  Rejected as primary: heavier (must faithfully replicate the SDK's default spawn — stdio, env,
  signal forwarding) for no gain, since `close()` already guarantees SIGKILL. Kept as a follow-up
  only if `close()`-based teardown proves insufficient in practice.
- **Bug B via `abortController` in query options.** The forwarded abort only force-kills after the
  SDK's graceful window, i.e. the same `close()` path — no advantage over calling `close()`, and it
  doesn't address the `Fiber.interrupt` deadlock that is the actual blocker.
- **Bug A: keep `lastEventType` but also ignore `token-usage`/`content.delta`.** Fragile —
  any future passive event reintroduces the clobber. Open-tool tracking models the real condition.
- **Bug A: let the watchdog recover hung tools too (force-kill after a long tool timeout).**
  Out of scope and risky (kills legitimate long tools). The user's now-working Stop button is the
  correct escape hatch for "my command is taking too long." Watchdog stays scoped to SDK wedges.
- **Bug C: server-side escalation.** More robust to client disconnect but more complex; deferred.
  The watchdog already provides a server-side stop for the disconnect/idle case.

## Files touched

- A: `apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts` (snapshot type),
  `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` (`recordTurnActivity`),
  `apps/server/src/provider/Layers/ProviderTurnStallWatchdog.ts` (`shouldTrip`) + tests.
- B: `apps/server/src/provider/Layers/ClaudeAdapter.ts` (`stopSessionInternal` ordering+bound) +
  test. (No reactor change — see Approach B.)
- C: `apps/web/src/components/ChatView.tsx` (local escalation) + test.

## Tradeoffs / limitations

- Bug B's hard stop ends the provider session; the conversation resumes via continuation on the
  next message (same as the watchdog's existing recovery). Acceptable for an explicit Stop.
- SIGKILL orphans the hung tool's own child (e.g. the runaway `wc`); it reparents to init and
  exits on its own. t3code is unwedged regardless. Process-group kill is a possible later refinement.
- A genuinely infinite-looping foreground tool is intentionally NOT auto-recovered by the watchdog;
  Stop (Bug C) is the escape hatch.

## Follow-ups deferred

- Optional process-group / descendant kill so a runaway tool child dies with its parent.
- Optional server-side Stop escalation for the client-disconnect case.
- (Surface during sanitize per Hard Rule 6; drain before any release.)

## Test plan

- A: watchdog unit test reproducing `item.started(command_execution)` → `item.updated` →
  `thread.token-usage.updated` → silence; assert **no** trip while the tool item is open, and a
  normal trip once it `item.completed`s and the turn then goes silent.
- B: adapter test that a stop with a parked/never-settling stream fiber returns promptly (within
  the bound) and invokes `query.close()` — i.e. the interrupt no longer gates teardown.
- C: ChatView test that a second Stop click (or the timer) while running dispatches
  `thread.session.stop` after the initial `thread.turn.interrupt`.
- Full suite (typecheck + lint + unit + browser) green before merge (Hard Rule 7).
