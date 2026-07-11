# Mobile foreground thread sync (stale-after-screen-off) — 2026-07-10

## Goal

On the t3code **web app in a mobile browser**, opening a thread, turning the
screen off for a few minutes, then returning shows a **stale thread** — messages
that arrived while the screen was off are missing until a manual page refresh.
The app should pull the missed messages by itself when it returns to the
foreground.

Success = returning to the foreground on the open (active) thread reliably
catches it up to the latest messages, with no manual refresh, and without
churning a healthy connection on every trivial tab focus.

## Background — root cause (validated against live code)

Recovery on reconnect is already **lossless**. `connection.reconnect()`
(`environmentConnection.ts`) → `client.reconnect()` → `transport.reconnect()`
(`wsTransport.ts:337-357`) replaces the socket **in place**; it does **not**
re-run `attachThreadDetailSubscription`. The open thread re-subscribes via the
transport's persistent stream loop (`wsTransport.ts:261-328`): when the old
socket closes the stream errors, the loop re-sends the **request object captured
at first attach** (`wsRpcClient.ts:424-429`) on the new session. That request
carries `fromSequenceExclusive = lastAppliedSequence` as it was **at attach
time**, so:
- a thread open long enough to have applied events resumes incrementally from
  its high-water mark;
- a **freshly-opened** thread (attached at `lastAppliedSequence = 0` →
  `fromSequenceExclusive = undefined`, `service.ts:445-446`) gets a **full
  snapshot** on reconnect.

Either way the catch-up is lossless — the snapshot reflects the latest state and
the `sequence > lastAppliedSequence` dedup (`service.ts:476`) handles the
incremental overlap. So *if* a reconnect fires on return, the active thread
catches up. The bug is that on a mobile thaw **nothing reliably fires it**:

1. **The resume-reconnect is gated behind a "we observed a `hidden` event first"
   flag.** `subscribeBrowserResumeReconnects` (`service.ts:1967-1976`):
   ```ts
   if (document.visibilityState === "hidden") { lastBrowserHiddenAt = Date.now(); return; }
   if (document.visibilityState === "visible" && lastBrowserHiddenAt !== null) { … reconnect }
   ```
   When a mobile OS **freezes / discards** the page on screen-off (Page Lifecycle
   `freeze`, or bfcache), the JS often never processes a clean `hidden`
   transition, so `lastBrowserHiddenAt` stays `null` and the return-to-`visible`
   branch **skips reconnect entirely** — it never even reaches the staleness
   check. This code listens to `visibilitychange` + `pageshow` but **not** the
   Page Lifecycle `resume` event that fires on thaw.

2. **The `focus`-based coordinator does not cover it.**
   `WebSocketConnectionCoordinator` (`WebSocketConnectionSurface.tsx:113`) only
   reconnects when `shouldAutoReconnect(status, "focus")` is true, which requires
   the UI to *already* be `reconnecting`/`exhausted` (`:36-56`). A socket that
   still *looks* connected (a zombie/half-open socket after the radio slept) is
   ignored.

The reconnect that already exists (`reconnectEnvironmentConnectionsAfterBrowserResume`,
`service.ts:1941`) is correctly gated by `!isHeartbeatFresh()` — it just isn't
being *reached* because of gate (1).

**Validated premises (Hard Rule 8):**

| Premise | Evidence | Result |
|---|---|---|
| Reconnect re-subscribes the open thread (lossless catch-up) via the transport stream loop replaying the captured request — incremental from HWM, or full snapshot for a fresh thread | `wsTransport.ts:261-328,337-357`, `wsRpcClient.ts:424-429`, `service.ts:445-446,476` | ✅ confirmed |
| The return-to-visible reconnect is skipped when no `hidden` was recorded | `service.ts:1972` (`lastBrowserHiddenAt !== null` AND-gate) | ✅ confirmed |
| `isHeartbeatFresh()` is a staleness signal on `performance.now()`, refreshed by any inbound frame, 15s window | `wsTransport.ts:359-363`, `wsRpcProtocol.ts:506-513` | ✅ confirmed |
| The `focus` coordinator won't fire on a "still-connected"-looking socket | `WebSocketConnectionSurface.tsx:36-56,113` | ✅ confirmed |

## Approach (chosen)

**Fix the trigger; keep the existing staleness gate.** Two minimal changes in
`subscribeBrowserResumeReconnects` / `reconnectEnvironmentConnectionsAfterBrowserResume`:

1. **Drop the `lastBrowserHiddenAt !== null` precondition** on the
   return-to-visible branch (**this is the load-bearing fix**). A missed `hidden`
   must no longer disable recovery — on any return to `visible` we evaluate the
   freshness gate directly. `lastBrowserHiddenAt` is removed **entirely**, at all
   four sites: the module var (`service.ts:172`), the `hidden`/`visible` branches
   (`:1969,:1972-1973`), the `pageshow` handler condition (`:1979-1980`), and the
   `resetEnvironmentServiceForTests` reset (`:2330`). The resulting handlers:
   - `handleVisibilityChange`: `if (document.visibilityState === "visible") reconnect(...)`.
   - `handlePageShow`: `if (event.persisted) reconnect(...)` — a non-persisted
     `pageshow` is a full reload with a fresh connection, so it needs no resync
     (this preserves the current no-op on initial load; the freshness gate would
     skip it anyway).
   `isHeartbeatFresh()` is the sole, sufficient gate.

2. **Add the Page Lifecycle `resume` event** as a **defensive** foreground
   trigger, registered on **`document`** (next to `handleVisibilityChange` at
   `service.ts:1985`) — **not** on `window` where `pageshow` lives; `freeze`/
   `resume` fire on `document`, and TypeScript will *not* catch a wrong target
   (`"resume"` isn't in `DocumentEventMap`, so it silently falls to the untyped
   string overload). This is belt-and-suspenders for the Chrome/Android
   frozen-then-thawed sub-case where the tab may already read `visible` on thaw
   (no transition fires). It is not co-equal to fix (1): the primary mobile case
   (screen-off → screen-on) is covered by the un-gated `visibilitychange` alone,
   which fires even on iOS Safari (where `resume` is not implemented). The 2s
   cooldown collapses a `pageshow`+`visibilitychange`+`resume` triple-fire on one
   thaw to a single reconnect.

The resync itself is unchanged: for each environment connection whose socket is
**not fresh** (`!isHeartbeatFresh()`), call `connection.reconnect()`, which
re-attaches the open thread's subscription from its high-water mark and streams
the missed events. The existing `BROWSER_RESUME_RECONNECT_COOLDOWN_MS` (2s)
cooldown stays, preventing repeat reconnects when several foreground events fire
together (e.g. `pageshow` + `visibilitychange` + `resume` on one thaw).

**Why the freshness gate is correct and non-churny (the "active thread only"
intent).** The user's need is that the *open* thread catches up without churn.
`!isHeartbeatFresh()` delivers exactly that:
- A truly-alive socket (frames within 15s — the app-level ping keeps them
  flowing) is left alone → **no reconnect churn on a healthy tab focus**, and it
  needs none: TCP already delivered the buffered events, which are applied on
  thaw. Skipping is correct.
- A socket that saw no frame for the multi-minute screen-off is **stale** →
  reconnect fires → the open thread resyncs from its high-water mark.

Reconnecting is per-connection and gated on staleness, so in the common
single-connection mobile session it touches only the connection carrying the
active thread — matching the "sync active thread only" scope.

**Coordinator split (intentional — don't add a third path).** There are two
foreground-reconnect owners, covering complementary cases:
`WebSocketConnectionCoordinator` (`WebSocketConnectionSurface.tsx`) reconnects
the *primary* connection on `focus`/`online` **only when the UI already shows
`reconnecting`/`exhausted`** (`shouldAutoReconnect`); this service path handles
the "zombie socket that still looks connected" case, gated on
`!isHeartbeatFresh()`, iterating **all** connections. This fix extends the
service path (headless, unit-testable) rather than the React coordinator — the
right home for the freshness gate + all-connection iteration.

## Alternatives considered

- **Unconditional reconnect on every foreground event (no freshness gate).**
  Rejected: `focus`/`visibilitychange` fire on every trivial tab switch; an
  ungated reconnect would churn a healthy socket (fresh WS handshake +
  resubscribe) on every focus. The freshness gate prevents this at zero
  correctness cost (a fresh socket already delivered the events).
- **A dedicated "catch-up since sequence N" RPC over the existing socket
  (no reconnect).** Rejected for this scope: it cannot recover a **zombie /
  half-open** socket (the RPC would hang, not error), so it would still need a
  reconnect fallback + a timeout race — more surface for no gain over
  reconnect-from-high-water-mark, which handles both the alive and dead cases
  with one primitive.
- **Narrow the resync to only `refCount > 0` (active) thread connections.**
  Rejected: the existing resume reconnect intentionally resyncs *all* stale
  connections (keeps the sidebar thread list fresh too), and reconnecting a
  connection resyncs its open thread anyway. Narrowing would regress
  sidebar-freshness with no benefit for the reported symptom. The freshness gate
  already keeps the blast radius to *stale* connections only.
- **Wire the app-level ping `onHeartbeatTimeout` to force a reconnect.**
  Out of scope (broader connection-reliability change, not foreground sync).
  Captured as a non-blocking improvement suggestion.

## Files / modules touched

- `apps/web/src/environments/runtime/service.ts` — remove the
  `lastBrowserHiddenAt` gate + its bookkeeping; add the `resume` event listener
  in `subscribeBrowserResumeReconnects`.
- `apps/web/src/environments/runtime/service.threadSubscriptions.test.ts` —
  regression tests for the missed-`hidden` path and the `resume` trigger.

## Tradeoffs and known limitations

- **Residual <15s half-open edge.** If the socket goes half-open *within* the
  last 15s before thaw, `isHeartbeatFresh()` can briefly read true and the
  foreground reconnect is skipped for that window; recovery then relies on the
  app-level ping. This does **not** affect the reported multi-minute scenario
  (a minutes-old last frame is never fresh). Hardening the ping-timeout →
  reconnect path is the non-blocking follow-up below.
- Removing `lastBrowserHiddenAt` also removes the (already vestigial) ability to
  measure background duration; nothing else reads it.

## Follow-ups deferred (non-blocking)

- Wire the app-level ping `onHeartbeatTimeout` (currently telemetry-only,
  `wsRpcProtocol.ts:377-383`) to force a transport reconnect, so a half-open
  socket self-heals even without a foreground event. Closes the residual
  <15s edge and the "tab left open on a flaky link" case.
