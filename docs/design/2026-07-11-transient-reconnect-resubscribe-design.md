# Recover lost stream subscriptions on a transient socket reconnect — mobile thread stale after screen-off — 2026-07-11

## Goal

On the web app in a **mobile browser**, open a thread, screen off a few minutes,
return: the thread must catch up to messages that arrived while away, **on its
own**, with no manual reload.

This is the second attempt. The first fix (`05ead4c9f`, foreground reconnect
gated on `!isHeartbeatFresh()`) shipped and **did not work** — root cause was
misdiagnosed. This design is built on a re-diagnosis that was independently
reproduced by a second investigator (`/rca` subagent) and then verified against
the installed + patched Effect source.

## Root cause (verified)

The Effect RPC library (`effect@4.0.0-beta.78`, patched) runs its **own** active
pinger inside `makeProtocolSocket` — a `Ping` every ~5 s with a ~10 s timeout
(`node_modules/.pnpm/effect@…/…/rpc/RpcClient.ts:1043,1161`). On a dead mobile
socket the ping times out and the run fails with
`SocketError{ SocketOpenError, "ping timeout" }` (`:1099-1101`).

Because the client sets **`retryTransientErrors: true`**
(`packages/client-runtime/src/wsRpcProtocol.ts:561`), that error is **swallowed**
— `tapCause` returns `Effect.void` for a `SocketOpenError` and does **not**
broadcast a `ClientProtocolError` (`RpcClient.ts:1112-1118`) — and
`Effect.retry` silently reopens the socket (`:1132`). The retry re-runs only the
**receive loop** (`socket.runRaw`); it does **not** re-send anything.

The higher RpcClient layer holds each subscription in an `entries` map, sends it
**once** at request time (`RpcClient.ts:~488,530`), and only ever clears entries
on **shutdown** (`clearEntries` via scope finalizer, `:308-326`). There is **no**
re-send on reconnect and **no** disconnect handler that fails in-flight streams.

Net effect after a mobile thaw: the socket silently reconnects to a **fresh,
healthy** state (Ping/Pong flowing), but the `subscribeThread` stream is
**orphaned** — never re-sent to the new connection, and never failed. The server
side of the new socket has no thread subscription, so **zero events arrive**; the
client stream just waits forever.

This single mechanism explains every observation:

- **No recovery even after minutes idle** — the silent reconnect keeps the socket
  fresh, so no further ping-timeout ever fires; nothing re-triggers recovery.
- **The prior `!isHeartbeatFresh()` foreground fix skips reconnect** — the
  heartbeat is _genuinely fresh_ on the reconnected socket (`lastHeartbeatPongAt`
  is refreshed by the Ping/Pong; `wsTransport.ts:412-414`). Freshness is not a
  proxy for _subscription_ liveness once the socket silently reconnects.
  (The frequent small frames measured live via CDP — `len=12`→`len=28` every
  ~4–5 s — are this Effect Ping/Pong, not subscription traffic.)
- **The app's own re-subscribe loop stays parked** — `WsTransport.subscribe`
  (`wsTransport.ts:261-328`) only re-subscribes when the stream _errors_; the
  transient-swallow path never fails the stream Queue, so it waits on
  `runningStream.completed` forever.
- **Switching threads does not recover** — `attachThreadDetailSubscription`
  short-circuits on the warm cache: `if (entry.unsubscribe !== NOOP) return true`
  (`service.ts:432`) — it believes the (orphaned) subscription is still live.
- **Only a full reload recovers** — a brand-new transport sends a fresh
  `subscribeThread` on a fresh socket.
- **The bug reproducing at all is evidence** the death is the _ping-timeout /
  `SocketOpenError`_ path (swallowed) and not a clean close (`SocketCloseError`,
  `RpcClient.ts:1109`), which is _not_ swallowed → would self-recover.

### Validated premises (Hard Rule 8)

| Premise                                                                                                                                                           | Probe                                                                | Result       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------ |
| Effect pinger fails with `SocketOpenError("ping timeout")` on a dead socket                                                                                       | installed `RpcClient.ts:1043,1099-1101,1161` read                    | ✅ confirmed |
| `retryTransientErrors:true` swallows that error (no `ClientProtocolError`) then retries the receive loop                                                          | `RpcClient.ts:1112-1118,1132`; app sets it at `wsRpcProtocol.ts:561` | ✅ confirmed |
| Subscriptions sent once; `entries` cleared only on shutdown; not re-sent/failed on reconnect                                                                      | `RpcClient.ts:308-326,488,530` read                                  | ✅ confirmed |
| App re-subscribe loop only fires on stream error                                                                                                                  | `wsTransport.ts:261-328` read                                        | ✅ confirmed |
| Thread-switch cannot recover (warm-cache short-circuit)                                                                                                           | `service.ts:432` read                                                | ✅ confirmed |
| The app's recovery machinery is **built** for `ping timeout` / `SocketOpenError` (currently dead code)                                                            | `transportError.ts` pattern list                                     | ✅ confirmed |
| `retryTransientErrors:true` was set **incidentally** (Vite/pnpm migration), not a deliberate reconnect decision                                                   | `git log -S` → `b440dd181` (#2899)                                   | ✅ confirmed |
| Effect patch adds `onPing`/`onPingTimeout`/`onDisconnect`/`onConnect` hooks; app wires only `onConnect`/`onDisconnect` (deflate latches), **not** `onPingTimeout` | patch diff + app grep                                                | ✅ confirmed |

## Design-review outcome (3 opus reviewers) — CRITICAL amendment

The review found that **naive B (the flag flip alone) is broken in the production
stream wire format** — it would re-orphan the stream and reproduce the bug (a
third failure). It must ship as **B+** below. Review verdicts:

- **CRITICAL — abandon race (confirmed in code by the reviewer AND directly):**
  In `msgpack-deflate-stream` the send wrapper is
  `abandonSendOnDisconnect(connectedLatch.whenOpen(send), disconnectLatch)`
  (`wsRpcProtocol.ts:573-591`). During the reconnect window `onDisconnect` has
  set `disconnectLatch` **open** and `connectedLatch` **closed**, so a fresh
  re-subscribe send races `connectedLatch.whenOpen(send)` (blocks) against
  `disconnectLatch.await` (resolves immediately) → **abandoned instantly** with
  `"send abandoned: socket disconnected before the frame was written"`. That
  message is **not** in `transportError.ts` patterns, so the subscribe loop hits
  `!isTransportConnectionErrorMessage` and **`return`s — exiting permanently**
  (`wsTransport.ts:313-316`). And the loop's 250 ms retry
  (`DEFAULT_SUBSCRIPTION_RETRY_DELAY`) always fires before Effect's 1000 ms socket
  reopen (`reconnectBackoff.ts:20`), so the first re-subscribe **always** lands in
  that window. → **Fix: classify the abandon condition as transport-retryable**
  (add `/\bsend abandoned\b/i` to `TRANSPORT_ERROR_PATTERNS`) so the loop keeps
  cycling until `connectedLatch` reopens and the send lands. This also fixes a
  _latent_ form of the same bug on clean closes today.
- **CRITICAL — test would false-green:** the client-runtime harness forces JSON
  (`wsTransport.test.ts:128-132`), where `isStreamFormat=false` disables the
  abandon path. The regression test **must** run in `msgpack-deflate-stream` with
  a binary mock socket and disconnect _between_ the surfaced error and the socket
  reopen — otherwise it validates nothing.
- **Cleared:** connection-status UX (Risk #1) is **not** a regression — the status
  atom is fed by _socket_ lifecycle events that fire on the Effect reconnect
  regardless of the flag (`apps/web/src/rpc/wsTransport.ts:26-36`), and the thread
  banner sanitizes transport errors to `null`. Deflate desync (Risk #2) is **not**
  a new path — the latches/`close(4000)` backstop are keyed to the socket
  lifecycle, unchanged by the flag; the re-subscribe send flows through the exact
  `sendMutex`/`connectedLatch.whenOpen` machinery built to order it safely.
- **Defer warm-cache fix:** under B+ the transport loop self-heals (keeps cycling,
  never exits), so `entry.unsubscribe` stays a live non-NOOP and the
  `service.ts:432` short-circuit is _correct_. The warm-cache fix only matters if
  the loop exits — which B+ prevents. It catches a _different_ failure mode
  (non-transport stream error) → standalone follow-up, out of scope here.
- **Keep the prior foreground fix (`05ead4c9f`)**, demoted to a latency
  optimization (different layer/signal; recovers a dead socket immediately on
  foreground instead of waiting out the ~10 s ping-timeout). No revert churn.
- **Provenance correction:** `retryTransientErrors:true` was introduced in
  `b3e8c0334` ("T3 Code Mobile [WIP]"), not `b440dd181` (which only _moved_ it).
  Conclusion (incidental, not a deliberate reconnect decision) stands.

## Approach (chosen): B+ — surface transient drops AND make re-subscribe survive the reconnect window

1. Set **`retryTransientErrors: false`** (`wsRpcProtocol.ts:561`). A ping-timeout
   then surfaces as a `ClientProtocolError`, which `Exit.fail`s the RpcClient
   stream `entries` (`RpcClient.ts:780-786`), which makes `WsTransport.subscribe`'s
   loop see a transport error (`isTransportConnectionErrorMessage` matches
   `ping timeout` / `SocketOpenError`) and **re-subscribe** on the reconnected
   socket. Effect's own `Effect.retry` still reopens the socket underneath (the
   `retry` is unconditional; `retryTransientErrors` only gates whether the error
   is broadcast first), so the socket reconnects **and** the app re-establishes
   its subscriptions on it.
2. **Classify the abandon condition as transport-retryable** — add `/\bsend
abandoned\b/i` to `TRANSPORT_ERROR_PATTERNS` (`transportError.ts`) so the
   re-subscribe that races the reconnect window is retried (every 250 ms) until
   `connectedLatch` reopens and the send lands, instead of exiting the loop.

Recovery is automatic and mechanism-driven: ~ping-timeout after a thaw the socket
reopens and the app re-subscribes from the thread's cursor (lossless; the
listener-side `sequence > lastApplied` dedup handles overlap), with **no**
dependence on a DOM foreground event, the freshness flag, or a thread switch.

Why this is the right fix, not a hack:

- The app's recovery for these exact errors already exists and is **designed in**
  (`transportError.ts` lists `ping timeout` / `SocketOpenError`); it is dead only
  because `retryTransientErrors:true` hides the error one layer below. Flipping to
  `false` **re-enables the intended behavior**.
- The `true` value was introduced incidentally by the build-tooling migration,
  not to solve a reconnect problem — so we are not re-opening a closed issue.
- Recovery is **automatic and mechanism-driven**: ~ping-timeout after a thaw the
  app re-subscribes, with **no** dependence on a DOM foreground event, the
  freshness flag, or a thread switch.

**Also fix the warm-cache short-circuit** (`service.ts:432`) as defense in depth:
if a subscription is ever suspect (its stream has ended/failed), re-opening the
thread should re-attach rather than trust `entry.unsubscribe !== NOOP`. Scope TBD
in review — include only if low-risk; otherwise capture as a follow-up (with B in
place, thread-switch is no longer the recovery path, so this is hardening).

### The prior foreground fix (`05ead4c9f`)

With B, the foreground reconnect is **no longer load-bearing** (recovery is
automatic). It is _not harmful_ under the corrected model (the Effect ping keeps
healthy sockets fresh, so `!isHeartbeatFresh()` only reconnects genuinely-dead
ones). Decision in review: keep it as a faster-foreground-recovery optimization,
or revert it to reduce surface. Leaning **keep** (no revert churn; it aids the
clean-close and fast-foreground cases) but explicitly note it is secondary.

## Alternatives considered

- **A — keep `retryTransientErrors:true`, re-issue subscriptions on the reconnect
  edge** (wire the patched `onPingTimeout` / a 2nd-edge `onConnect` to force the
  app's parked stream loops to re-subscribe). Preserves Effect's seamless
  socket-level reconnect (no UI "reconnecting" flash on a blip). Rejected as
  primary: more plumbing across the protocol→client→transport boundary, and it
  leaves the app's existing `transportError.ts` recovery dead/redundant — i.e. it
  fights the app's own design instead of restoring it. Kept as the fallback if
  review finds B regresses the connection-status UX.
- **Hybrid — B plus suppressing the transient `ClientProtocolError` from the
  connection-status UI** (so blips re-subscribe silently without a "reconnecting"
  flash). Consider only if review confirms a real UX regression from B; otherwise
  an honest brief reconnect indicator on an actual drop is acceptable.
- **My earlier watchdog + tiny `ping` RPC (discarded).** Invalid: there is
  already an active pinger, and the failed socket does not stay dead — it silently
  reconnects to a _fresh_ state. Pinging an already-fresh socket detects nothing.
- **Un-gate the foreground reconnect (fix C).** Recovers only on foreground and
  churns healthy sockets; does not address non-foreground / already-visible thaws.

## Risks / what the design review + tests must verify

1. **Connection-status UX**: does surfacing a transient `ClientProtocolError`
   flip the UI to "reconnecting" on every blip? Trace
   `wsConnectionState`/`WebSocketConnectionSurface`. If it flashes objectionably
   on brief drops, pivot to the hybrid.
2. **Context-takeover deflate window**: on the surfaced reconnect the app
   re-subscribes over the internally-reopened socket; confirm the per-connection
   deflate window is reset correctly (onConnect/onDisconnect latches) and the
   `stream-decode-desync` backstop (`close(4000)`) still holds. This is the
   highest-risk interaction.
3. **All stream types** (thread, shell, terminal, vcs) go through the same loop —
   confirm each re-subscribes cleanly, no duplicate side effects.
4. **`currentError` window**: `send` fails until `onOpen` clears `currentError`;
   confirm the app loop's retry/backoff converges (recovers within a few seconds),
   no thrash.
5. **No double reconnect**: the app re-subscribes over the same session (Effect
   reopened the socket internally); confirm it does not _also_ call
   `transport.reconnect()`.
6. **Existing tests**: `wsTransport.test.ts` / `wsRpcClient.test.ts` reconnect &
   resubscribe cases — expect some to change; update them to assert the corrected
   behavior (transient drop → resubscribe), do not paper over.
7. **Desktop** shares `wsRpcProtocol` — confirm no regression there.

## Test plan (TDD)

- **New/failing-first**: a client-runtime test that simulates a transient
  socket drop (ping-timeout / `SocketOpenError`) on a live stream subscription and
  asserts the stream is **re-subscribed** (not silently orphaned). This fails at
  `retryTransientErrors:true` and passes at `false`.
- Thread-subscription-level test (`service.threadSubscriptions.test.ts`):
  transient drop → the open thread resumes from its high-water mark.
- Warm-cache: re-attaching after the stream ended re-subscribes (if that fix is
  included).
- Full verify gate (typecheck + lint + unit + browser) across all workspaces.

## Files / modules likely touched

- `packages/client-runtime/src/wsRpcProtocol.ts` — `retryTransientErrors: false`
  (+ comment explaining why, referencing `transportError.ts`).
- `packages/client-runtime/src/wsTransport.test.ts` / `wsRpcClient.test.ts` — new
  transient-drop → resubscribe coverage; adjust any test asserting the old
  swallow.
- `apps/web/src/environments/runtime/service.ts` — optional warm-cache re-attach
  fix + its test.

## Follow-ups deferred (non-blocking)

- Consider a first-class `WsTransport.request()` timeout.
- Consider whether to wire the now-available `onPingTimeout` hook for telemetry
  (observability of transient drops), independent of recovery.
- Revisit whether `05ead4c9f`'s foreground reconnect should be simplified once B
  proves out in the field.
