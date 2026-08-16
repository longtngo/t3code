# Mobile connection resilience: quiet UX + tolerant reconnect

**Date:** 2026-06-27 **Branch:** `feat/mobile-conn-resilience` **Status:** Design (in review)

## Goal

Using the t3code **web app in a mobile browser over Tailscale**, the connection blips constantly
(radio loss, tab backgrounding, tunnel renegotiation). Today every blip immediately spams a
"Disconnected from T3 Server / Reconnecting…" toast followed by a "Reconnected" toast — even when
the drop self-heals in under a second. After 8 retries (~2 min) the client gives up and shows
"Retries exhausted" with a manual Retry button. A message typed while disconnected fails outright.

Make the front end **quiet and lossless** on a flaky link, and make reconnect **never give up** —
without weakening any correctness guarantee.

## Background: what we already have (verified)

The connection is more resilient than it looks; this reframes the work as mostly UX, not transport.

- **App-level heartbeat already runs in prod.** Effect's RPC layer (`RpcClient.makeProtocolSocket`)
  sends `{_tag:"Ping"}` every 5s; the server replies `Pong` natively _before_ RPC routing
  (`effect` `RpcServer` switch); on a missed Pong the client proactively tears down and reconnects
  in ~10s — catching the mobile "zombie socket" where no close event fires. The client's raw-Pong
  listener (`wsRpcProtocol.ts:236-245`) and `isHeartbeatFresh()` (`wsTransport.ts:274-278`) are fed
  by this in production (the test harness `wsRpcHarness.ts:145` merely re-implements it).
- **Reconnect is lossless.** `WsTransport.subscribe` auto-resubscribes and re-fetches a snapshot;
  the server also exposes `replayEvents(fromSequenceExclusive)` + sequenced events. No data is lost
  on a drop — the pain is UX noise + the retry cliff, not correctness.
- **Eager reconnect triggers** already exist on `online`/`focus`/`visibilitychange`/`pageshow`
  (`WebSocketConnectionSurface.tsx:204-221`, `environments/runtime/service.ts:1761-1789`).

## Load-bearing premises — validated against live code (Hard Rule 8)

| Premise the design depends on                                                                                                                             | Evidence (file:line)                                                                                                                                                                 | Result                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| Server dedupes commands by `commandId`; replaying an already-accepted command returns the cached receipt with no re-execution → **outbox replay is safe** | `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:144-156` (`getByCommandId` → `accepted` returns `{sequence}`; rejected → `OrchestrationCommandPreviouslyRejectedError`) | ✅ confirmed                    |
| Optimistic chat bubbles reconcile **by message id** → a kept "queued" bubble auto-clears when the server echoes the same `messageId`                      | `apps/web/src/components/ChatView.tsx:2761-2787` (removes optimistic msgs whose id ∈ server `messages`)                                                                              | ✅ confirmed                    |
| `maxRetries: null` yields infinite retry at the capped delay (`Schedule.forever`) — prong 2 is a one-line data change                                     | `packages/client-runtime/src/wsRpcProtocol.ts:269-273` (`backoff.maxRetries === null ? Schedule.forever : Schedule.recurs(...)`, delay `getReconnectDelayMs(...) ?? 0`)              | ✅ confirmed                    |
| Send path & failure revert is the right outbox seam; `commandId` is a fresh client UUID                                                                   | `ChatView.tsx:3329` (`dispatchCommand({type:"thread.turn.start", commandId: newCommandId(), …})`), `.catch` revert at `3347-3379`                                                    | ✅ confirmed                    |
| `isQueuedSend` (existing) is **server-side turn-stacking**, not a network queue → outbox does not duplicate it                                            | `ChatView.tsx:3174-3175` (`phase==="running" && provider===claudeAgent`)                                                                                                             | ✅ confirmed — distinct concept |
| `WS_RECONNECT_MAX_RETRIES = DEFAULT_RECONNECT_BACKOFF.maxRetries!` breaks when set to `null`                                                              | `apps/web/src/rpc/wsConnectionState.ts:13-14`                                                                                                                                        | ✅ confirmed — must decouple    |

## Approach (chosen)

Two prongs, four work items. All FE work is in `apps/web` (confirmed: the user is on the web app in
a mobile browser; the native app shows only quiet inline status and is not the source of the noise).

### Prong 1 — quiet, lossless front end

**1A. Grace period — silence brief blips.** In `WebSocketConnectionCoordinator`
(`apps/web/src/components/WebSocketConnectionSurface.tsx`, the toast effect ~lines 270–368), gate
the disconnect/offline/reconnecting toast behind a quiet window so a drop that recovers quickly
surfaces **nothing** — neither the disconnect toast nor the "Reconnected" success toast.

- Consts: `WS_OUTAGE_GRACE_MS = 3_000`, `WS_OFFLINE_GRACE_MS = 0` (a browser `offline` event is
  authoritative — surface immediately; a silent socket drop on Tailscale usually self-heals <3s).
- Refs: `outageStartedAtRef` (when the contiguous outage began), `outageSurfacedRef` (did we show a
  toast?), `graceTimerRef` (pending grace timeout), plus a small `graceTick` state to re-run the
  effect when the timer fires. Extend the unmount cleanup to clear `graceTimerRef`.
- The success-toast block runs **only if `outageSurfacedRef` was true**. The `exhausted` branch uses
  grace 0 (always surfaces) — though with prong 2 it becomes effectively unreachable.
- **Pure, testable helpers** (mirrors `shouldAutoReconnect`/`shouldRestartStalledReconnect`):
  - `shouldSurfaceOutage(status, nowMs, outageStartedMs, graceMs): boolean` — `true` if
    `reconnectPhase === "exhausted"`, else `outageStartedMs !== null && nowMs - outageStartedMs >= graceMs`.
  - `outageGraceMs(uiState): number` — `offline → WS_OFFLINE_GRACE_MS`, else `WS_OUTAGE_GRACE_MS`.

**1B. Ambient connection indicator.** A small always-present status dot so the user has at-a-glance
awareness without toast spam (lets toasts stay rare). New
`apps/web/src/components/sidebar/SidebarConnectionStatus.tsx` styled after the existing sidebar
indicators (`SidebarResourceQueue.tsx`, `SidebarLocalModels.tsx`); reads `useWsConnectionStatus()` +
`getWsConnectionUiState()`: green=connected, amber pulsing=reconnecting/connecting, red=offline.
Hover/press shows detail (last connected/disconnected, next-retry countdown — same data the toast
uses). Mount in `AppSidebarLayout.tsx`/`Sidebar.tsx`; because the sidebar collapses on mobile, also
surface a compact dot in the always-visible top area (sidebar toggle / header). Dot styling
precedent: `apps/mobile/src/features/connection/ConnectionStatusDot.tsx`.

**1C. Offline outbox — queue user input, flush on reconnect.** New
`apps/web/src/rpc/commandOutbox.ts` holding `QueuedCommand[]` = `{command, enqueuedAt, status}`,
persisted to `localStorage` (mirror `composerDraftStore.ts`) so it survives a backgrounded-tab
reload. API: `enqueueCommand`, `flushOutbox(send)`, `useOutbox()`, `isQueueableCommand`. **Scope to
user-input commands** — `thread.turn.start` (primary), plus the natural extensions
`thread.approval.respond` / `thread.userInput.respond`. Do **not** auto-queue destructive ops
(delete/revert/stop): offline, those keep today's fail behavior (avoids surprising replays).

- Integrate in `ChatView.tsx onSend`: build the command envelope, then `dispatchOrQueueCommand` —
  if `getWsConnectionUiState() !== "connected"`, enqueue and **keep** the optimistic bubble (mark it
  `queued`) instead of the current revert; if connected, send and on a _transport-disconnect_ error
  enqueue + keep the bubble (other errors behave as today).
- Flush coordinator: a small component mounted in `routes/__root.tsx` next to
  `WebSocketConnectionCoordinator` (line 147), observing `wsConnectionStatusAtom` → `connected`.
  Replay queued commands FIFO via `dispatchCommand`; dequeue on success (idempotent via
  `commandId`); stop+retry next reconnect if transport drops again; drop + surface an error on a
  _rejected_ receipt. Cap the queue (e.g. 50).
- UX: the optimistic bubble renders a quiet "Queued · sends when reconnected" badge while pending;
  it auto-clears via the existing id reconciliation (`ChatView.tsx:2767`) when flushed events arrive.

### Prong 2 — connection tolerance: never give up reconnecting

`packages/client-runtime/src/reconnectBackoff.ts` — `maxRetries: 7 → null`. The socket retry policy
already branches to `Schedule.forever` (verified), and `getReconnectDelayMs` caps null-config delays
at 64s, so reconnection becomes an infinite 1s→2s→…→64s loop. Combined with the existing eager
reconnect on focus/online, a returning phone always recovers and the "Retries exhausted" dead end
disappears. Ripple cleanups:

- `wsConnectionState.ts:13-14` — `WS_RECONNECT_MAX_RETRIES`/`_MAX_ATTEMPTS` read
  `DEFAULT_RECONNECT_BACKOFF.maxRetries!`, which becomes `null!` and breaks. Decouple (display-only)
  or remove; `applyDisconnectState` then stays `waiting` (never `exhausted`) for in-range retries.
  Keep the `exhausted` type/branch as a defensive fallback so persisted states/tests don't break.
- `WebSocketConnectionSurface.tsx` — `formatReconnectAttemptLabel` drops the `/max` denominator (a
  growing "Attempt 47/8" is meaningless/alarming). Recommend the surfaced toast read simply
  "Reconnecting in Xs…". The `exhausted` toast branch + `shouldAutoReconnect` exhausted clauses
  become effectively dead but stay as safety nets.

## Alternatives considered

- **Transport degradation WS→SSE→long-poll + auto-upgrade** — _rejected_. Investigated against
  Effect's RPC source: there is **no SSE/long-poll client transport** (only socket + one-POST-HTTP);
  HTTP streaming needs a framed serialization (we use JSON), so the HTTP path can't carry the ~11
  live subscriptions without an ndjson migration; there's no built-in fallback/upgrade. Decisive:
  Tailscale is a full L3 WireGuard tunnel — it does **not** block WebSockets, and over radio loss SSE
  and long-poll die exactly as much as WS. It targets WS-_blocking_ networks (corp proxy/captive
  portal), not this user's problem. L–XL effort for ~zero benefit here. If a WS-hostile network ever
  becomes a real requirement, the cheap path is a single NDJSON-over-HTTP fallback (~M) — not
  SSE/long-poll. (User confirmed: skip.)
- **Wire a new app-level heartbeat for faster dead-socket detection** — _rejected as redundant_. The
  effect RPC layer already does this in prod (~10s). Optional low-value follow-up only: surface
  `onPong`/`onPingTimeout` via `RpcClient.ConnectionHooks` for cleaner telemetry.
- **Server idle-timeout backstop (Bun top-level `idleTimeout`)** — _deferred_. A harmless one-liner;
  user deselected it. The app-level heartbeat is the authoritative liveness layer on both runtimes.
- **Debounce only the manual-reconnect path / shorten toast timeout** — _rejected_. Doesn't address
  the immediate-surface root cause; the grace period is the correct mechanism.

## Experiments

None required — the decision space was settled by reading Effect's RPC source + the t3code code
(documented above). Grace-window and queue-cap values are sensible defaults, tunable later.

## Files touched

- `apps/web/src/components/WebSocketConnectionSurface.tsx` — grace period + pure helpers + label (1A, 2)
- `apps/web/src/components/WebSocketConnectionSurface.logic.test.ts` — helper tests
- `apps/web/src/components/sidebar/SidebarConnectionStatus.tsx` (new) + mount in `AppSidebarLayout.tsx`/`Sidebar.tsx` (1B)
- `apps/web/src/rpc/commandOutbox.ts` (new) + `commandOutbox.test.ts` (new); integrate in `ChatView.tsx`; flush coordinator in `routes/__root.tsx` (1C)
- `packages/client-runtime/src/reconnectBackoff.ts` — `maxRetries: null` (2)
- `apps/web/src/rpc/wsConnectionState.ts` — decouple/remove `WS_RECONNECT_MAX_*`, label cleanup (2)
- Test updates: `packages/client-runtime/src/reconnectBackoff.test.ts`, `apps/web/src/rpc/wsConnectionState.test.ts`

## Tradeoffs & known limitations

- **3s grace = up to 3s of "silent" outage** before the user sees a toast. Intentional: the ambient
  dot still reflects state immediately, and the outbox makes input lossless, so the toast is pure
  escalation for sustained outages.
- **Infinite retry on a permanently-dead server** = a forever 64s-spaced reconnect loop. Cheap and
  intended for mobile; the eager focus/online triggers make it instant on return.
- **Outbox scope = user-input commands only.** Destructive ops still fail offline by design.
- **localStorage persistence** is per-origin; clearing site data drops the queue (acceptable).

## Follow-ups deferred (non-blocking)

- **localStorage persistence of the outbox** (cross-reload auto-resend). v1 is in-memory; `composerDraftStore.ts` already preserves the _text_ across a tab reload, so nothing is lost — only auto-resend-after-reload is deferred (and a hard tab-kill is arguably a moment to let the user reconfirm before auto-firing a turn).
- Surface `onPong`/`onPingTimeout` via `RpcClient.ConnectionHooks` for cleaner heartbeat telemetry.
- Optional Bun top-level `idleTimeout` backstop in `apps/server/src/server.ts`.

---

## Stage 6 — design review: findings & resolutions

Three adversarial reviewers (correctness / simplicity / compatibility) ran against this doc + live
code. **Exit reason:** one round; findings were concrete and converged — no new classes of issue
expected from a second round on a design this size. Triage below (Apply / Defer / Reject). The
items here **supersede** the initial approach where they differ; the Stage 7 plan encodes the final.

### Critical correctness fix — verified against Effect source (Hard Rule 8)

**A unary send issued while disconnected HANGS (does not reject) under `maxRetries: null`.** Verified
in `effect` `RpcClient.js`: `Effect.retry(retryPolicy)` (line 675) wraps the _connection run_, not
individual requests; `send` (680-690) fails fast only when `currentError` is set, which `tapCause`
(662-663) skips for transient `SocketOpenError` when `retryTransientErrors: true` (our config); and
there is **no resend** of pending requests on reconnect (`requestClientMap` only routes responses).
So infinite retry means a send during an outage never settles until the next session-swap
(`WsTransport.reconnect()` on focus/online/visibility disposes the old runtime → in-flight
`runPromise` rejects — the bounding safety net).

**Resolution (reshapes 1C):** the outbox **decides up-front from connection state and never issues a
doomed send.** Queue predicate: `status.hasConnected && getWsConnectionUiState(status) !== "connected"`
(connected before, now in an outage). This is robust regardless of request-hang semantics, and the
`hasConnected` clause also means a not-yet-connected state (e.g. browser tests before socket open)
→ _dispatch_ (today's behavior), so it can't silently mis-queue real sends (resolves compat item
10b without a blocking probe). The post-dispatch `.catch` becomes a _best-effort_ fallback only.

### Applied — correctness

- **(C-F1/F2, Compat-1/2) Fully decouple the reconnect display constants in the same change.**
  `WS_RECONNECT_MAX_RETRIES = DEFAULT_RECONNECT_BACKOFF.maxRetries!` becomes `null` at runtime and
  `WS_RECONNECT_MAX_ATTEMPTS = null + 1 = 1` (not a crash — a misleading `1`). Make them display-only
  literals (or remove) and stop `formatReconnectAttemptLabel` reading them. Update the two red tests:
  `reconnectBackoff.test.ts` (3 inverted assertions: `getReconnectDelayMs(7|100)` now `64_000`,
  `maxRetries` now `null`) and `wsConnectionState.test.ts:95-106` (drive `applyDisconnectState` to
  `exhausted` via an explicit finite config instead of the default).
- **(C-F10, Compat-12) No double-text.** The transport-disconnect path keeps the optimistic bubble as
  _queued_ and must NOT also run the existing draft-restore (`ChatView.tsx:3362-3373`). It's a third
  outcome distinct from success and hard-revert; preserve the "composer not re-dirtied" guard and
  reuse the existing transport-error classifier (`isTransportConnectionErrorMessage`/`formatErrorMessage`).
- **(C-F11) Hoist `const commandId = newCommandId()`** to send-time (next to `messageIdForSend`,
  `ChatView.tsx:3186`) so the queued envelope and the dispatch share one id (idempotency).
- **(C-F12/F13/F14) Flush is sequential + guarded + error-classified.** `for…of await` (FIFO, never
  `Promise.all`); a `flushingRef` re-entrancy guard; classify each failure with
  `isTransportConnectionErrorMessage` → transport: stop & re-queue the remainder for the next
  reconnect; terminal (rejected receipt / fresh invariant error, e.g. thread deleted while offline):
  **drop the head + surface an error** so a dead command can't wedge the FIFO queue forever.
- **(C-F6/F7/F8) Grace period via the simpler, race-free mechanism** (see Simplicity below) — removing
  the standalone timer removes the stale-fire / flapping / leak class entirely.

### Applied — simplicity (prong 1 was over-built)

- **1A grace period — derive from `status.disconnectedAt`, ride the existing `nowMs` tick.**
  `applyDisconnectState` already stamps a stable `disconnectedAt` per contiguous outage and clears it
  on open — that _is_ the outage-start. Drop `outageStartedAtRef`, `graceTimerRef`, and the new
  `graceTick` state; keep only `outageSurfacedRef` (to gate the success toast — no existing
  equivalent). Widen the existing 1s `nowMs` interval guard (`WebSocketConnectionSurface.tsx:223-236`)
  to tick whenever `getWsConnectionUiState(status) !== "connected"`. Pure helper becomes
  `shouldSurfaceOutage(status, nowMs, graceMs)` = `reconnectPhase==="exhausted" || (disconnectedAt!==null && nowMs - disconnectedAt >= graceMs)`.
  Net: **1 ref + a one-line guard widening**, same behavior, no separate timer to leak or stale-fire.
- **1B ambient indicator — one component + `title=` tooltip.** No separate "compact mobile variant"
  (render the same dot beside the existing `SidebarTrigger` at `Sidebar.tsx`, which is the
  always-visible element when the sidebar is off-canvas) and no stateful popover (the surfaced toast
  already carries sustained-outage detail; a `title=` with `formatConnectionMoment`/
  `formatRetryCountdown` covers at-a-glance). The RN `ConnectionStatusDot.tsx` is not portable — a
  `<span>` with three Tailwind color classes + `animate-pulse` is the whole thing.
- **1C outbox — in-memory, `turn.start` only.** Drop localStorage persistence for v1 (deferred;
  `composerDraftStore.ts` already preserves the text). Whitelist collapses to **`thread.turn.start`**
  (verified: `thread.userInput.respond` has 0 web call sites; `thread.approval.respond` has 1 —
  both speculative). Drop the 50-item cap (unreachable for human typing; keep it unbounded in-memory).
  Keep the rejected-receipt/terminal-error drop (real safety, per C-F14).

### Applied — compatibility / blast-radius

- **(Compat-9) Outbox stays OFF the `WsRpcClient` surface** — a standalone store calling the existing
  `dispatchCommand` — so the "adding to EnvironmentApi/WsRpcClient breaks 3 mocks" memory gotcha does
  not apply. Do not route flush through a new client method.
- **(Compat-11) Flush coordinator is a no-op when the queue is empty** so it can't inject unexpected
  `dispatchCommand` calls into the browser tests where it auto-mounts. Kept as a small mounted
  coordinator (idiomatic — matches `WebSocketConnectionCoordinator`/`SlowRpcAckToastCoordinator`),
  triggered on the connected transition, guarded by `flushingRef`.
- **(Compat-13) Extract a pure `decideSendDisposition({hasConnected, uiState, errorMessage})`** helper
  in a `ChatView.logic.ts`-style module for unit testing (mirrors the `shouldSurfaceOutage` convention).
- **(Compat-7) Confirmed mobile does NOT inherit infinite retry** (it uses `ManagedRelayClient`, not
  `WsTransport`); only web + desktop (web bundle) do — as intended.
- **(Compat-15/16) Verify gate is `pnpm verify` = typecheck+lint+test+test:browser** (no desktop
  smoke), and a fresh worktree already has what `test:browser` needs (global Playwright chromium
  cache + `mockServiceWorker.js`) — so the Electron/`path.txt` worktree gotcha does NOT block Stage 9.

### Deferred / Rejected (with rationale)

- **(Reject for v1) localStorage persistence, popover, queue cap, whitelist breadth** — see Simplicity;
  YAGNI for the stated problem, `composerDraftStore` covers text-loss.
- **(Keep, minimal-diff) the `exhausted` type + `shouldAutoReconnect` clauses + exhausted toast
  branch** — now structurally unreachable under `maxRetries: null`. The simplicity reviewer argued to
  delete the dead branch; I keep it as a small defensive fallback because deleting the enum member
  breaks `WebSocketConnectionSurface.logic.test.ts:70-83` (which constructs an `exhausted` state) and
  the churn outweighs removing a few lines. Deliberate trade: test-stability + defense over
  dead-code-deletion. (Only the `/max` label is changed.)
- **(Defer, C-F16) Queued badge disappears after navigating away from the thread** — cosmetic; the
  in-memory queue still flushes and the server echo re-creates the message. Noted limitation.
