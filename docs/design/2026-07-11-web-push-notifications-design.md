# Web Push background notifications (Android mobile-web PWA) — 2026-07-11

## Goal

Deliver an OS notification to the web PWA when a thread **finishes a turn** or
**starts asking the user a question**, *while the phone screen is off and no tab is
alive*. The existing foreground notifier (`apps/web/src/lib/notifier.ts`) fires the
W3C `Notification` API from the live page over the WebSocket stream — it cannot fire
when the tab is frozen (screen off / backgrounded), which is precisely the case the
user cares about. This adds a second, WebSocket-independent delivery pipe: the
**Web Push API** (server → FCM → the phone's always-on Google push channel → the
service-worker `push` event → `showNotification`).

Target surface is the **web PWA** (`apps/web`) on **Android Chrome**. (`apps/mobile`
is a separate React-Native app with its own APNs-via-relay path; out of scope.)

## Premise validation (Hard Rule 8) — DONE

A minimal end-to-end spike shipped the real delivery path (a `push` handler injected
into the app's own workbox service worker via `workbox.importScripts`), deployed it,
and sent a VAPID-signed push from the server host to the real phone. Result:

- FCM accepted the push (`201`).
- **The notification appeared on the locked Android with the screen off and no tab
  alive.** Tapping it currently does nothing — a `notificationclick` handler bug (the
  spike used `url:"/"` with a trivially-true match); this design fixes it.

So the load-bearing assumption — "Android Chrome delivers a Web Push to the SW with
the screen off on this device/network" — is **empirically confirmed**, not assumed.
No native app is required.

## Approach

A server-side reactor mirrors the existing `AgentAwarenessRelay` (which already taps
the orchestration event stream and does the same edge selection for the *mobile/APNs*
path), but sends **VAPID Web Push** to subscriptions stored in SQLite. The client adds
a per-device opt-in that subscribes via `PushManager` and registers the subscription
over RPC. The SW gains `push` + `notificationclick` handlers.

### Components

1. **VAPID keypair (server secret).** Generated once with
   `webpush.generateVAPIDKeys()` and persisted via `ServerSecretStore` using the
   `getOrCreate` pattern (cf. `cloud/environmentKeys.ts`), under new secret-name
   constants. The **public** key is exposed to clients (needed for
   `applicationServerKey`); the **private** key never leaves the server.

2. **`web-push` dependency (server).** Added to the server workspace `dependencies`
   (pure-JS; externalized like `node-pty`, NOT added to the bundle-prefix list). Used
   only inside the sender service; wrapped in `Effect.tryPromise`.

3. **Persistence — migration 034 `push_subscriptions`.** Follows the
   `PendingBackgroundTask` triplet (Migration + Service + Layer). Columns:
   `endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
   environment_id TEXT, created_at TEXT NOT NULL, last_success_at TEXT`. Repository:
   `upsert(subscription)`, `list()`, `deleteByEndpoint(endpoint)`.

4. **Contracts — RPC (mirror `WsGetResourceQueueRpc`).**
   - `push.getVapidPublicKey` → `{ publicKey: string }` (no-arg read).
   - `pushSubscriptions.register` → payload `{ endpoint, keys:{p256dh,auth},
     expirationTime? }`, success ack.
   - `pushSubscriptions.unregister` → payload `{ endpoint }`, success ack.
   Added to `WS_METHODS`, `Rpc.make` defs, the `RpcGroup.make` group, `EnvironmentApi`,
   and `createEnvironmentApi`.

5. **`WebPushSender` service.** `setVapidDetails` once; `send(subscription, payload)`
   wraps `webpush.sendNotification(sub, JSON.stringify(payload), {TTL, urgency:'high',
   topic})`. On `statusCode` 404/410 → delete the subscription (it's gone). On 429 →
   log + skip (best-effort; no retry storm). Uses the VAPID secret.

6. **`WebPushRelay` reactor.** Structural clone of `AgentAwarenessRelay`:
   - subscribes to `orchestrationEngine.streamDomainEvents`,
   - filters with the same edge predicate (turn state changes +
     `user-input.requested`/`resolved`),
   - debounces per-thread, reads `getThreadShellById(threadId)`,
   - keeps a per-thread `Ref` of the last-notified state and fires only on a real
     edge: **turn finished** = previous `running` → terminal
     (`completed`/`error`/`interrupted`); **asking a question** =
     `hasPendingUserInput` false → true,
   - builds the payload and fans out to all stored subscriptions via `WebPushSender`.
   - Registered in `OrchestrationReactor.start()` and layered in `server.ts` next to
     `AgentAwarenessRelay.layer`.

7. **Service-worker handlers (`public/push-sw.js`, via `workbox.importScripts`).**
   Kept from the spike (generateSW mode preserved, load-bearing `/assets` CacheFirst
   rule untouched). `push` → `showNotification(title, {body, tag: threadId,
   data:{url}})`. `notificationclick` → focus an existing tab already on that thread,
   else focus any tab and `navigate`, else `openWindow(url)` — **fixed** to use the
   real thread URL and exact-origin matching (the spike's bug).

8. **Client opt-in (settings).** Replaces the spike's debug button with a real
   "Enable push notifications on this device" control in `GeneralSettingsPanel`
   (beside "Task completion notifications"). Reuses `ensureWebNotificationPermission`,
   fetches the VAPID public key via RPC, subscribes on `navigator.serviceWorker.ready`'s
   `pushManager`, and registers the subscription. Toggling off unsubscribes +
   unregisters. Only rendered where the SW exists (`!isElectron && PROD`).

### Payload shape

`{ title, body, tag, url }`, JSON, end-to-end encrypted by web-push (aes128gcm):
- **finished:** title = thread title (or "T3 Code"), body = "Task finished".
- **asking:** title = thread title, body = "Waiting for your input".
- `tag` = `threadId` so a newer notification for the same thread replaces the older.
- `url` = the thread route (`/$environmentId/$threadId`) for click-through.

Lock-screen privacy: thread titles appear on the lock screen. For a single-user
self-hosted tool this is acceptable and useful; a future toggle could redact to
"T3 Code — task finished". Noted as a follow-up, not built now.

## Correctness concerns

### Double-notify vs the foreground path

Chrome enforces `userVisibleOnly: true` — every `push` **must** show a notification,
or Chrome eventually shows a generic one / penalises the origin. So we cannot silently
drop a push. Interaction with the foreground `Notification` path:

- **Screen off / backgrounded (the target case):** page is frozen → foreground path
  does nothing → only the push shows. No conflict. ✅
- **App open and focused on the same thread:** foreground path already suppresses
  (its `isViewingThread` check), but the push would still show an OS notification.
  Mitigation: the SW `push` handler checks `clients.matchAll({type:"window"})`; **if a
  visible, focused client is already on the target thread**, it shows nothing (Chrome
  tolerates omission when a visible client exists — the widely-used pattern). Otherwise
  it shows. This mirrors `isViewingThread` on the SW side.
- **App open but on a different thread / not focused:** push shows — correct, the user
  isn't looking at that thread.

The server fires the push unconditionally on the edge; suppression lives in the SW
(only the SW knows client focus/visibility). Server-side focus tracking is rejected as
over-engineering (§ Alternatives).

### Fire-once per edge

The reactor dedups on a per-thread `Ref` of last-notified state, exactly like
`AgentAwarenessRelay`'s published-identity dedup, so a re-emitted/re-projected shell
event doesn't double-send. `tag = threadId` is a second line of defence (coalesces).

### Subscription lifecycle

`pushManager` subscriptions can rotate/expire; the browser fires
`pushsubscriptionchange` (best-effort). v1 relies on the send-time 404/410 prune +
re-subscribe on next app open (the settings toggle re-registers idempotently by
`endpoint` PRIMARY KEY). A `pushsubscriptionchange` SW handler is a follow-up.

## Alternatives considered

- **injectManifest custom SW** (vs `workbox.importScripts`): rejected — would force
  hand-porting the load-bearing `/assets` CacheFirst rule + navigateFallback denylist;
  higher blast radius for zero benefit. importScripts keeps all caching for free
  (proven in the spike).
- **Hand-roll the Web Push protocol on `node:crypto`** (vs `web-push`): rejected — the
  aes128gcm ECE framing + VAPID JWT is the error-prone part; `web-push` is the tested
  reference impl and is pure-JS, so it carries no native-addon bundling risk. (Would
  only revisit if the server ever ships a single dependency-free bundle.)
- **Server-side "is the user viewing this thread" tracking to suppress push**:
  rejected for v1 — needs client presence/focus signalling plumbing; the SW-side
  `clients.matchAll` check covers the only case that matters (app open + focused)
  without it.
- **Reuse `AgentAwarenessRelay` directly** (vs a sibling reactor): rejected — it
  targets the cloud relay / APNs and is gated on relay creds; Web Push is a genuinely
  parallel egress. Clone the structure, don't overload the path.
- **Send push for every awareness edge** (message-sent, approvals, etc.): rejected for
  v1 — scope is the two edges the user named (finished, asking a question). More edges
  = notification spam. Easy to extend later.

## Files / modules touched

**Server**
- `apps/server/package.json` — add `web-push` (dep) + `@types/web-push` (dev). *(spike)*
- `apps/server/src/persistence/Migrations/034_PushSubscriptions.ts` — new.
- `apps/server/src/persistence/Migrations.ts` — register 034.
- `apps/server/src/persistence/Services/PushSubscription.ts` — new (Context.Service).
- `apps/server/src/persistence/Layers/PushSubscription.ts` — new (Layer.effect).
- `apps/server/src/push/WebPushKeys.ts` — VAPID getOrCreate over `ServerSecretStore`.
- `apps/server/src/push/WebPushSender.ts` — new (send + prune-on-410).
- `apps/server/src/push/WebPushRelay.ts` — new (reactor, clone of AgentAwarenessRelay).
- `apps/server/src/orchestration/Layers/OrchestrationReactor.ts` — start the relay.
- `apps/server/src/server.ts` — layer wiring + RPC handlers for the 3 methods.
- secret-name constants (near `cloud/config.ts`).

**Contracts**
- `packages/contracts/src/rpc.ts` — 3 RPC methods + group + EnvironmentApi entries.

**Web**
- `apps/web/public/push-sw.js` — kept from spike; `notificationclick` fixed. *(spike)*
- `apps/web/vite.config.ts` — `workbox.importScripts` kept from spike. *(spike)*
- `apps/web/src/lib/webPush.ts` — new (subscribe/unsubscribe/register helpers).
- `apps/web/src/environmentApi.ts` — `pushSubscriptions` + `push` namespaces.
- `apps/web/src/components/settings/SettingsPanels.tsx` — replace debug button with
  the real per-device toggle.

## Tradeoffs / known limitations

- **`userVisibleOnly` means no silent pushes** — acceptable; both edges are
  user-relevant.
- **Lock-screen shows thread titles** — acceptable for single-user; redaction toggle is
  a follow-up.
- **No `pushsubscriptionchange` handler in v1** — send-time prune + re-subscribe on app
  open covers it; SW handler is a follow-up.
- **All subscriptions get all threads' notifications** — fine for a single-user tool;
  per-environment scoping is stored but not filtered in v1.

## Follow-ups deferred

- `pushsubscriptionchange` SW handler for seamless key rotation.
- Lock-screen title-redaction toggle (privacy).
- Extending edges (approvals, errors) behind per-type toggles.
- Per-environment subscription filtering if multi-environment push becomes noisy.
- Server-side `pushSubscriptions.unregister` (v1 relies on client `unsubscribe()` +
  send-time 410-prune; add if deterministic immediate-stop is wanted).
- VAPID-key-rotation robustness (F5): re-subscribe the client when the stored
  `applicationServerKey` no longer matches the server key, and reconcile the toggle
  against server-side registration state (today it reflects only the browser
  subscription). Rare while keys are generated once.
- Subscription count cap per operator (F4 amplifier hardening) — low priority for a
  single-operator server.
- SW-side per-thread suppression refinement (v1 uses the coarser any-visible-client
  rule — see Review outcomes).

## Design review outcomes (round 1) — APPLIED

Three adversarial reviewers (correctness, simplicity, compatibility) verified against
live code. All findings triaged and applied; this section supersedes the sections
above where they differ. Exit: findings converged, no conflicts left unresolved.

### Correctness

- **[HIGH] Edge-detector, not change-detector.** Do NOT clone
  `agentAwarenessPublishIdentity` (fires on *any* awareness-state change → push spam),
  and do NOT reuse `resolveThreadAwarenessPhase` (no `interrupted` case; `running`
  check precedes `completed` so a still-`running` session never yields `completed`).
  Instead the reactor stores, per thread, the **previous `latestTurn.state`** and
  **previous `hasPendingUserInput`**, and fires by mirroring
  `apps/web/src/lib/notifier.ts` `classifyThreadCompletion` semantics directly:
  finished = `prev === "running"` && `next ∈ {completed,error,interrupted}`;
  asking = `hasPendingUserInput` explicitly-recorded-`false` → `true`.
- **[MED] Restart replays stale "asking" edge.** The dedup state is in-memory. On
  **first sight** of a thread, initialize prev-state = its *current* state and fire
  nothing; fire only on a subsequently-*observed* transition. Never treat an absent
  prior entry as an implicit `false`. (No boot-time snapshot seeding needed — this is
  simpler and avoids the boot-spam that `AgentAwarenessRelay`'s active-thread seeding
  would cause here.)
- **[MED] Double-notify with a live tab on another thread.** The foreground notifier
  fires for any non-viewed thread, so an alive+focused tab on thread A plus a push for
  thread B's completion = two notifications on that device. **Fix:** the SW `push`
  handler suppresses (shows nothing) whenever **any visible client** exists — not just
  one on the target thread. When a visible client exists the foreground path + app UI
  cover it; when none exists (screen off / backgrounded, the target case) the push
  shows. This is the sanctioned `userVisibleOnly` exemption (Chrome only penalises a
  silent push when *no* visible client exists) and is evaluated per-device against that
  device's own clients, so desktop-open + phone-asleep still yields exactly one
  notification per device. (This overrides the simplicity reviewer's suggestion to
  defer the `matchAll` check — the check stays because it is now correctness-bearing,
  but in its simpler any-visible form.)
- **[MED] Hung FCM send wedges the single-fiber reactor + unbounded queue growth.**
  `web-push` has no default socket timeout. Fan out with
  `Effect.forEach(subs, (s) => send(s).pipe(Effect.timeout("10 seconds"),
  Effect.catchCause(log)), { concurrency: 8, discard: true })`, and pass web-push's own
  `timeout` option too. Per-send isolation so one 4xx/5xx/410 never aborts the batch.
- **[LOW] VAPID/getOrCreate.** Client base64url-decodes the public key to a
  `Uint8Array` for `applicationServerKey` (the spike already does this). Server
  getOrCreate must be TOCTOU-safe (create + catch AlreadyExists → re-read, per
  `cloud/environmentKeys.ts`). `setVapidDetails` needs a valid `mailto:` subject.
- **[LOW] notificationclick match.** Compare `new URL(client.url)` origin+pathname
  exactly, not `.includes()`.
- **[verify during impl]** Drive one normal turn and log `latestTurn.state`
  transitions to confirm a mid-turn `missing→interrupted` placeholder can't produce a
  spurious "interrupted" finished-edge (shared with the foreground path, which isn't
  reported misfiring — but a server push is more intrusive, so confirm cheaply).

### Simplicity

- **Server 3 files → 1.** Collapse `WebPushKeys` + `WebPushSender` (Service) into a
  single `apps/server/src/push/WebPushRelay.ts` that mirrors `AgentAwarenessRelay`'s
  actual shape (one file: Service tag + `layer` at the bottom, inlined
  `setVapidDetails`/`sendNotification`/410-prune, exported *pure* edge classifier for
  tests). VAPID getOrCreate is a single exported fn (`getOrCreateVapidKeys(secrets)`),
  co-located, not a Service.
- **Persistence columns → 4:** `endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL,
  auth TEXT NOT NULL, created_at TEXT NOT NULL`. Drop `environment_id` (no v1 filter
  reads it) and `last_success_at` (no reader). Keep the Migration+Service+Layer triplet
  (hard repo convention).
- **RPC surface → 1 method.** The non-secret VAPID **public** key rides on
  `ServerConfig` (add `webPushVapidPublicKey?: string`, populated in `server.getConfig`
  assembly) — the settings panel already reads config, so no new RPC and no round-trip.
  Drop the `push.getVapidPublicKey` RPC. Defer `unregister`. Drop `expirationTime?`
  from the `register` payload. Net new RPC: **`pushSubscriptions.register`** only.
- **Client `webPush.ts` module → folded** into the settings handler, keeping only the
  pure `urlBase64ToUint8Array` as an exported (testable) helper.
- **Drop `topic`** on send (device-side `tag = threadId` already coalesces). Keep
  `TTL` + `urgency: "high"`.

### Compatibility

- **[HIGH] Handlers live in `ws.ts`, not `server.ts`**, and every WS method needs an
  `RPC_REQUIRED_SCOPE` entry or `requiredScopeForMethod` throws at call time (no test
  catches a missing entry). Add `pushSubscriptions.register` →
  `AuthOrchestrationOperateScope`; put the handler in the `ws.ts` handler map.
- Wire the **hand-written** `packages/client-runtime/src/wsRpcClient.ts` (interface
  member + factory impl) — it is not auto-derived from the group.
- Update the full-object `EnvironmentApi` mock in
  `apps/web/src/components/ChatView.browser.tsx` (`createMockEnvironmentApi`) — adding
  a namespace breaks it (the "3 mocks" hazard). The WS test harness
  (`apps/web/test/wsRpcHarness.ts`) auto-handles new *unary* methods — no edit needed.
- **Gate the settings toggle** on `!isElectron && import.meta.env.PROD` (no SW in
  Electron or dev → `serviceWorker.ready` would hang).
- Serve `/push-sw.js` with `Cache-Control: no-cache` so a changed handler propagates on
  the next SW update check (bounded ~24h otherwise).
- Confirmed: migration **034** slot is free; `web-push` externalizes correctly (like
  `node-pty`, not bundled); `WebPushRelay` fanning out to zero subs on a desktop-only
  deployment is a harmless no-op.

## Code review outcomes (Stage 9) — APPLIED

Two adversarial code reviewers (correctness+security, simplicity+regression) on the
branch diff. No regressions found; VAPID private key never leaks; SQL parameterized;
auth double-gated; no XSS. Applied:

- **[F1, Medium] SW suppression dropped the "asking" push.** The any-visible-client
  rule suppressed *both* edges, but the foreground path only covers *finished* — so an
  "asking" push was silently dropped whenever a tab was visible. Fix: the payload now
  carries `kind`; the SW always shows `asking` and suppresses only `finished` when a
  visible client exists.
- **[F2, Low-Med] Baseline advanced before send → lost alert on send failure.** The
  worker is single-fiber (no concurrent re-process to guard), so the baseline `Ref` is
  now advanced *after* the fan-out; a failed shell/subscription read leaves the edge to
  retry on the next event instead of silently dropping it.
- **[F4, Low-Med security] Blind SSRF via `register`.** Added `isAllowedPushEndpoint`
  (HTTPS-only; reject loopback/private/link-local IPs, `localhost`, `.local`, and
  single-label hosts) at the RPC trust boundary; a rejected endpoint returns `ok:false`.
- **[F3] Rapid edge pairs coalesce** (snapshot-based detection reads the latest shell) —
  accepted; acceptable for notifications. Added to follow-ups.
- **[F5] Client toggle can read ON after a server-side prune, and VAPID-key rotation
  (403/400, not 404/410) isn't pruned** — accepted; keys are generated once so rotation
  is rare. Added to follow-ups.
- **[A1] simplicity:** collapsed a duplicate `{endpoint}` schema. **[A3]:** corrected a
  "debounce" comment (the worker serialises, it does not coalesce).

### Final file list (supersedes "Files / modules touched")

**Server:** `package.json` (spike) · `Migrations/034_PushSubscriptions.ts` (new) ·
`Migrations.ts` (register 034) · `persistence/Services/PushSubscription.ts` (new) ·
`persistence/Layers/PushSubscription.ts` (new) · `push/WebPushRelay.ts` (new — reactor
+ inlined sender + `getOrCreateVapidKeys` + exported pure classifier) ·
`orchestration/Layers/OrchestrationReactor.ts` (start it) · `server.ts` (layer wiring +
`webPushVapidPublicKey` into `ServerConfig`) · `ws.ts` (register handler +
`RPC_REQUIRED_SCOPE` entry) · secret-name constants.
**Contracts:** `rpc.ts` (`pushSubscriptions.register` only) · `server.ts` /
`ServerConfig` (`webPushVapidPublicKey?`) · `ipc.ts` (`EnvironmentApi` namespace).
**Client-runtime:** `wsRpcClient.ts` (interface + factory).
**Web:** `public/push-sw.js` (spike; add any-visible suppression + fix
notificationclick) · `vite.config.ts` (spike) · `environmentApi.ts` (namespace) ·
`components/settings/SettingsPanels.tsx` (real gated toggle, replace debug button) ·
`components/ChatView.browser.tsx` (mock).
