# WS Subscription Recycle — bounding the RpcServer per-subscription fiber-stack leak

**Date:** 2026-07-18
**Branch:** `fix/ws-subscription-recycle`
**Status:** Design — reviewed (correctness + simplicity), SHIP-WITH-FIXES applied below

## Goal

Stop the t3code server OOM crash caused by an **unbounded per-subscription fiber
continuation-stack** in Effect's `RpcServer` streaming layer. Long-lived,
high-volume WebSocket subscriptions (`subscribeThread`, `subscribeShell`,
`subscribeTerminalMetadata`) accumulate one fiber `_stack` frame per streamed
element for the entire life of the subscription, producing a sustained
~1.7 GB/hr monotonic heap climb during long autonomous sessions until the process
hits `--max-old-space-size` and crashes.

The prior mitigation (raising the V8 old-space ceiling 12 GB → 24 GB) is
**delay-only, not a fix** — an unbounded leak hits whatever ceiling is set (16 h
run confirmed the crash at 24 GB). This is the real fix.

## Root cause (empirically pinned + source-confirmed)

**Mechanism.** Effect `RpcServer` (`effect/unstable/rpc`, `4.0.0-beta.78`) handles
each streaming subscription request in its **own forked request fiber**
(`RpcServer.js:234`, tracked in `client.fibers`). That fiber runs
`Stream.runForEachArray(stream, sendChunk)` (`RpcServer.js:290`) to send each
streamed element to the client. The fiber's continuation `_stack` grows by one
frame **per streamed element** and is never trimmed for the life of the
subscription. When the stream **completes**, the fiber exits, is removed from
`client.fibers` (`RpcServer.js:238` `onExit`), and its `_stack` is GC'd — a clean
`Exit(success)` response is sent to the client (`RpcServer.js:362-368`).

**Evidence (high confidence):**
- 4+ live heap snapshots across sessions: `_stack` fan-out 517K → 690K → 1.09M
  frames, ~3 GB+ retained after forced GC, dominated by ~6 big fibers.
- Fiber spans are **per-subscription** (`ws.rpc.orchestration.subscribeThread`,
  `subscribeShell`, `subscribeTerminalMetadata`) — confirming per-request fibers,
  not a shared per-connection fiber.
- Empirically **"frees on unsubscribe"** — ending a subscription frees its fiber
  stack. The effect source confirms the mechanism (`onExit` → removed → GC).
- 9 isolated raw-`Stream` repros stayed flat → the growth lives in the RpcServer
  transport send-loop, not our stream pipeline.

The independent RCA here **is** the multi-snapshot forensic pin (stronger than a
fresh hypothesis); my own investigation and the effect-source read agree fully.

## The fix: event-count recycle → clean completion → client resubscribe

Cap each targeted subscription stream at **N emitted elements**. On reaching N the
stream **completes cleanly** (an `Exit(success)`, produced by `Stream.take`),
which makes the RpcServer request fiber exit and free its accumulated `_stack`.
The client transport treats a clean completion as a **resubscribe-and-resync
trigger**, re-issuing the subscription immediately on the same socket and catching
up on anything missed. Peak per-fiber stack is bounded to N frames; it is freed
and rebuilt from zero on every recycle, so the heap can no longer climb without
bound.

**Why event-count, not duration:** the `_stack` grows per *streamed element*, so
element-count is the direct, correct lever. An idle subscription over a long
duration has a tiny stack and must not be churned; a busy subscription over a
short duration has a huge stack and must be recycled. Event-count is
**self-targeting** — it fires only on the high-throughput streams that actually
leak, and never on idle/low-volume ones. Duration would be the wrong axis (churns
idle subs pointlessly, and doesn't bound a burst that fills the stack fast).

**Load-bearing premises (both validated before design):**

1. **Ending a subscription's stream cleanly frees its fiber `_stack`.**
   ✅ Confirmed by effect source (`RpcServer.js:238` `onExit` removes the fiber
   from `client.fibers` → GC) *and* empirically ("frees on unsubscribe").

2. **The client resubscribes-and-resyncs on CLEAN completion, but STOPS on a
   non-transport error.** ✅ Confirmed at `packages/client-runtime/src/wsTransport.ts`:
   the `for(;;)` subscribe loop (`:262-335`) `await`s `runningStream.completed`,
   which **resolves** on `Exit.success` (`:450-501` `onExit`) → the loop falls
   through and **re-invokes the RPC method immediately** (no backoff). A
   non-transport error instead hits the `catch` and `return`s (`:316`) — the loop
   **stops, no resubscribe**.
   ⇒ **The recycle MUST complete cleanly (`Exit.success`).** `Stream.take(n)` ends
   with success — correct. Never use `Queue.shutdown` / interrupt / a failing
   cause, which would silently stop client updates.

**Resync is lossless for all three targeted methods:**
- `subscribeThread` — client re-issues with `fromSequenceExclusive` and dedups on
  `sequence > lastAppliedSequence`; server replays past the cursor or falls back
  to a windowed snapshot (`apps/web/src/environments/runtime/service.ts:441-489`).
- `subscribeShell` — `onResubscribe` resets the bootstrap gate; server re-emits a
  full `snapshot` applied wholesale (`packages/client-runtime/src/environmentConnection.ts:168-192`).
- `subscribeTerminalMetadata` — server emits a full metadata `snapshot` first on
  every subscribe (`apps/server/src/terminal/Layers/Manager.ts:2200-2204`),
  idempotent by construction.

## Scope — which streams get the recycle

**Targeted (not central).** Wrap exactly the three confirmed-leaking methods whose
client resync is confirmed lossless: `subscribeThread`, `subscribeShell`,
`subscribeTerminalMetadata`.

**Excluded:**
- `subscribeTerminalEvents` (raw PTY byte output) — can be high-volume, but was
  **not** in the forensics and its output is **not** losslessly replayable on
  re-subscribe (bytes emitted during the resubscribe gap would be lost).
  Recycling it risks visible terminal corruption. Left unbounded.
- `subscribeServerConfig`, auth/other low-volume streams — never approach the
  bound; unverified resync. No benefit, so untouched.

Central injection in `observeRpcStream*` was rejected: although event-count is
self-targeting (low-volume streams never hit N), it would leave a *latent*
correctness risk for any unverified method that ever crossed N (e.g.
`subscribeTerminalEvents`). Targeted wrapping has zero latent risk and documents
intent at the exact leak sites.

## Implementation

New standalone helper, `apps/server/src/recycleSubscriptionStream.ts` (beside
`ws.ts` / `wsRpcServerProtocol.ts` — the WS-transport layer it belongs to, and the
conceptual twin of `orchestration/Layers/boundedSubscriberStream.ts`, which bounds
the *same* subscription streams on the other axis, capacity-lag):

```ts
import * as Stream from "effect/Stream";

export const DEFAULT_WS_SUBSCRIPTION_MAX_EVENTS = 20000;
// A too-small limit turns the recycle into a tight snapshot-only resubscribe loop
// (take(1) emits only the snapshot frame → immediate resubscribe → 100% CPU, no
// live updates). Floor any enabled value so a fat-fingered env can't wedge the server.
export const MIN_WS_SUBSCRIPTION_MAX_EVENTS = 100;

/**
 * Resolve the per-subscription recycle limit from the raw env string.
 * - `"0"` → 0, an explicit kill-switch (mirrors the `T3CODE_HUB_GAUGE_MS === "0"`
 *   idiom; `parsePositiveIntEnv` alone can't express disable — it maps 0 to
 *   `undefined` → default, which would leave the recycle silently ON).
 * - unset / non-numeric / negative → default.
 * - any positive value → clamped up to the floor.
 */
export const resolveSubscriptionRecycleLimit = (raw: string | undefined): number => {
  if (raw === "0") return 0;
  if (raw === undefined) return DEFAULT_WS_SUBSCRIPTION_MAX_EVENTS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WS_SUBSCRIPTION_MAX_EVENTS;
  return Math.max(parsed, MIN_WS_SUBSCRIPTION_MAX_EVENTS);
};

/**
 * Cap a long-lived subscription stream at `maxElements` emitted elements, ending
 * it *cleanly* (Exit.success via `Stream.take` → `Cause.done()`) so the effect
 * RpcServer request fiber completes and frees its accumulated continuation
 * `_stack` (one frame per streamed element). The client transport treats the
 * clean completion as a resubscribe-and-resync trigger, so updates continue
 * seamlessly. `maxElements <= 0` disables (identity — no recycle).
 */
export const recycleSubscriptionStream = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  maxElements: number,
): Stream.Stream<A, E, R> =>
  maxElements > 0 ? Stream.take(stream, maxElements) : stream;
```

Wiring in `apps/server/src/ws.ts`:
- Module scope (matching the file's existing const-tunable style — `RESUME_MAX_MISSED_EVENTS`, `DEFAULT_SUBSCRIBE_WINDOW_TURNS`, …), read the env **once**:
  `const WS_SUBSCRIPTION_MAX_EVENTS = resolveSubscriptionRecycleLimit(process.env.T3CODE_WS_SUBSCRIPTION_MAX_EVENTS);`
- At each of the three sites, wrap the **constructed** stream (the `Stream.concat(...)`
  the handler returns for thread/shell; the `Stream.callback(...)` for
  terminalMetadata) in `recycleSubscriptionStream(stream, WS_SUBSCRIPTION_MAX_EVENTS)`.
  Placement relative to the `observeRpcStream*` instrumentation is immaterial — the
  instrumentation operators (`Stream.tap`/`onExit`/`withSpan`) are 1:1 passthroughs,
  so `take(N)` bounds the RpcServer send-loop fiber to N frames wherever it sits, as
  long as it is on the stream that becomes the handler's return value (confirmed by
  the correctness review).

**Config-disable correctness (review fix, medium).** `parsePositiveIntEnv("...") ??
DEFAULT` cannot produce 0 — `parsePositiveIntEnv` maps `"0"`/non-positive to
`undefined`, so `?? DEFAULT` would leave the recycle ON when an operator sets
`...=0` to disable it in an incident. The `resolveSubscriptionRecycleLimit` resolver
handles the `"0"` sentinel explicitly (as `T3CODE_HUB_GAUGE_MS` does), making the
`maxElements <= 0` identity branch actually reachable. Extracting the resolver as a
pure function is also what lets the kill-switch + floor logic be unit-tested — the
exact axis both reviews flagged.

**Streamed elements are batch frames, not raw events (calibration nuance).**
`subscribeThread`'s live tail coalesces events via `Stream.groupedWithin` (20 ms /
64-event batches), so each element the RpcServer counts is a *batch frame*;
`subscribeShell` is per-event. Either way `take(N)` bounds the fiber to N *frames*
— the memory bound holds regardless; only recycle *frequency* differs per path.

**Default N rationale.** Measured ~6.2 KB retained per stack frame (3.07 GB / 517K
frames). N = 20000 bounds a single fiber's peak to ~124 MB before recycle; with ~6
concurrent big fibers in a single-session climb, peak ≈ 0.7 GB, freed each recycle —
comfortably under any ceiling. N is large enough that recycles (and their
bounded-snapshot resyncs) are infrequent. Env-tunable so the default can be adjusted
without a redeploy.

**No lost-event window on recycle (confirmed by correctness review).** The
projection read-model is updated *inside the committed transaction, before* the
event is published to the hub (`OrchestrationEngine.ts:202-243`). So on the recycle
gap (old subscription scope closes → new subscribe), any event a subscriber could
have seen is already in the read model; the new subscribe reads a fresh snapshot +
`snapshotSequence` and the live tail filters `sequence > snapshotSequence` — the
same durable-read guarantee that makes first-connect safe. Holds for thread/shell
(durable projection) and terminalMetadata (authoritative in-memory snapshot).

**New-completion surface.** `subscribeThread`/`subscribeShell` **already** recycle
on clean completion in production via `boundedSubscriberStream`'s drop-behind path,
so the take adds *zero* new client contract for them. `subscribeTerminalMetadata` is
the one method gaining a genuinely-new mid-life clean completion; it is covered by
the same method-agnostic `wsTransport` resubscribe loop and its resync is idempotent
(full metadata snapshot on every subscribe). (Verified: the web/mobile clients share
the `packages/client-runtime` `WsTransport`.)

## Tradeoffs and known limitations

- **Resync bandwidth per recycle.** On `subscribeThread`, the client re-issues
  with the `fromSequenceExclusive` captured at *first* attach, so after a long
  session each recycle's missed window is large → the server sends a **windowed**
  snapshot (bounded by `windowTurns`/`maxRows`, not the whole thread), deduped by
  the client. This is bounded and identical to the cost the client already pays on
  every reconnect. With N = 20000 it is rare and amortized. A follow-up could have
  the client refresh `fromSequenceExclusive` on re-issue to make each recycle a
  cheap incremental catch-up instead of a windowed snapshot — client-side change,
  out of scope here.
- **Not a framework fix.** The underlying effect `RpcServer` accumulation remains;
  we bound it at the app layer. If effect later trims the send-loop stack, this
  becomes a harmless cap. (Patching effect's streaming internals was rejected:
  high risk, must be re-applied on every upgrade.)
- **`subscribeTerminalEvents` still unbounded.** A pathological terminal streaming
  huge output over a very long session could still grow its fiber. Not observed in
  forensics; left as a monitored follow-up (needs a replayable/scrollback resync
  before it can be safely recycled).

## Alternatives considered

- **Duration bound** — rejected: wrong axis (doesn't correlate with stack size;
  churns idle subs; misses fast bursts).
- **Central injection in `observeRpcStream*`** — rejected: latent correctness risk
  for unverified methods that could cross N (esp. non-replayable
  `subscribeTerminalEvents`).
- **Patch effect `RpcServer` / `runForEachArray`** — rejected: framework-internals
  risk, re-apply-on-upgrade burden.
- **Raise the V8 ceiling further** — rejected: already proven delay-only; an
  unbounded leak hits any ceiling.
- **Restructure our stream pipeline (fewer `mapEffect`/`filter` stages)** —
  rejected: the accumulation is in effect's `runForEachArray` fiber, not our
  operators; restructuring wouldn't help.

## Follow-ups deferred

1. Client-side `fromSequenceExclusive` refresh on re-issue → cheaper incremental
   resync per recycle (currently a bounded windowed snapshot).
2. Evaluate a safe recycle for `subscribeTerminalEvents` (requires replayable
   terminal scrollback resync).
3. Optional: a metric/log counting recycles per method to observe real-world
   recycle frequency and tune N.
4. **Extend the recycle to the remaining long-lived streams** (review finding,
   deliberately out of scope here). The same per-element `_stack` growth exists on
   other `observeRpcStream(Effect)` subscriptions the forensics did *not* pin as
   dominant leakers:
   - `subscribeHostMetrics` (~1.5 s) and `subscribeLlmModels` (~4 s) — periodic
     **full-state** emitters, so idempotent and *safe* to recycle; low-volume, but
     `subscribeHostMetrics` crosses N ≈ 20000 in ~8 h, so it is a slow contributor
     worth adding after a resync-safety confirmation.
   - `subscribeVcsStatus` — verify resync-safety before recycling.
   - `terminalAttach` (raw PTY output) — **not** safely recyclable as-is: like
     `subscribeTerminalEvents`, its output is not losslessly replayable on
     re-subscribe. Needs a scrollback/replay resync first.
   The dominant monotonic climb (long autonomous sessions streaming every SDK
   event through `subscribeThread`/`subscribeShell`) is closed by this change; this
   item fully closes the leak *class* and each stream needs its own resync check.
