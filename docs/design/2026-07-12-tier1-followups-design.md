# Tier-1 follow-up batch — design (2026-07-12)

Three independent follow-ups from `~/reports/t3code/2026-07/2026-07-12/2026-07-12-followup-catalog.md`,
each shipping on its own branch. Grouped in one design doc because each is small and they
share no code. Premises were validated against live code before writing this (Hard Rule 8);
the validation results are inlined per item.

---

## Item 1 — CheckpointReactor.test.ts flake hardening

**Branch:** `test/checkpoint-reactor-flake-hardening`

### Goal

Stop `CheckpointReactor.test.ts` from occasionally reddening the gate (or burning `retry:2`
attempts) under heavy concurrent CPU load.

### Premise validation (the catalog premise was PARTIALLY FALSIFIED — refined)

The catalog said "timing/wait hardening." Reading the live config
(`apps/server/vite.config.ts:54-72`) changed the picture:

- The maintainers **already** diagnosed this exact class ("CheckpointReactor capture/revert …
  load-sensitive async-timing races: green in isolation, occasionally red only under heavy
  concurrent CPU load … environmental contention, not a product bug") and applied the accepted
  mitigation: `fileParallelism: false`, `testTimeout: 120_000`, `retry: 2`. A per-test
  racy-git fix "was tested and falsified on APFS's ns-mtime."
- So a _new_ per-test timing fix is out — it was tried and rejected. **But** there is a
  concrete, non-contradictory gap: the test's own internal poll helpers
  (`waitForThread`, `waitForEvent`, `waitForGitRefExists`) all default to **`timeoutMs = 15_000`**,
  while the sibling load-sensitive test `OrchestrationEngineHarness.integration.ts:143` already
  raised its internal deadline to **`40_000`** for exactly this reason. The 15 s internal
  deadline trips _before_ the 120 s framework budget the maintainers deliberately set, so under
  contention the helper throws its own "Timed out waiting for git ref" and forces a `retry`
  (or, if load persists across all 3 attempts, a red gate) — defeating the generous budget.

### Approach

Align the three internal helper deadlines in `CheckpointReactor.test.ts` from `15_000` to
`40_000`, matching the precedent already set by `OrchestrationEngineHarness.integration.ts`.
Nothing else changes — `retry:2` stays as the backstop; a genuine hang still fails
deterministically at the 120 s framework timeout across all attempts (no regression is masked,
because a real product break fails every attempt regardless of the poll deadline).

### Alternatives rejected

- **New racy-git / mtime fix** — already tried and falsified per the config comment. Rejected.
- **Bump `retry` to 3** — masks more, discriminates less; the maintainers chose 2 deliberately.
- **Replace polling with event subscription** — larger rewrite of a working harness; the
  deadline mismatch is the actual defect, not the polling strategy.

### Files

`apps/server/src/orchestration/Layers/CheckpointReactor.test.ts` (three default-arg constants).

### Limitations

Does not _eliminate_ contention flakes (that's environmental, per the maintainers) — it stops
the test's own tight deadline from pre-empting the framework's generous one, which is the part
under our control. Ships alongside, not instead of, `retry:2`.

---

## Item 2 — Cursor + Grok `listSessions` consistency

**Branch:** `fix/peer-adapter-listsessions-consistency`

### Goal

Close the latent `listSessions`/`hasSession` inconsistency in the Cursor and Grok adapters —
the exact shape that already shipped as a real defect in `ClaudeAdapter` (`633fd5775`).

### Premise validation (confirmed against live source)

- Cursor `listSessions` (`CursorAdapter.ts:1166-1167`): `Array.from(sessions.values(), (c) => ({ ...c.session }))`
  — **no `!stopped` filter**, while `hasSession` (1169-1173) returns `!c.stopped`. Mismatch confirmed.
- Cursor `stopSessionInternal` (528-546): sets `ctx.stopped = true` (531), yields through
  settle/interrupt/`Scope.close`, then `sessions.delete(ctx.threadId)` (538) — a key-based
  delete after yields. Confirmed.
- Grok is identical: `listSessions` (`GrokAdapter.ts:896-897`), `hasSession` (899-903),
  key-delete (321) after `stopped=true` (314). Confirmed.
- Both have a per-thread `Semaphore` (`withThreadLock`) serializing start/stop, which is why
  the audit found these latent (Shape B neutralized) rather than live — matching the audit's
  finding. No live defect; this is consistency + defense-in-depth.

### Approach (per audit recommendations B1 + B4, identical edit in both files)

1. **`listSessions` filters `!stopped`** — mirror the ClaudeAdapter contract:
   `Array.from(sessions.values()).filter((c) => !c.stopped).map((c) => ({ ...c.session }))`.
2. **Identity-guard the key delete** (defense-in-depth): replace
   `sessions.delete(ctx.threadId)` with `if (sessions.get(ctx.threadId) === ctx) sessions.delete(ctx.threadId)`.
   Currently unreachable behind the `Semaphore`, but makes the delete correct independent of
   the lock, so a future _unlocked_ teardown path can't silently reintroduce the ClaudeAdapter race.

### Alternatives rejected

- **Filter only, skip the identity guard** — leaves the delete lock-dependent; the guard is
  ~1 line and future-proofs it. The audit explicitly paired them (B1+B4).
- **Refactor Cursor+Grok+OpenCode to a shared session-map helper** — larger; OpenCode has a
  different liveness contract (`stopped` is a `Ref`, not a field) and is a separate audit item
  (B2/B3, deliberately out of this batch).

### Files

`apps/server/src/provider/Layers/CursorAdapter.ts`, `apps/server/src/provider/Layers/GrokAdapter.ts`.
Tests: extend each adapter's existing test to assert `listSessions` excludes a stopped session.

### Limitations

OpenCode (the one genuinely-exposed peer) is intentionally excluded — its fix (B2/B3) is a
distinct liveness-contract decision, tracked separately.

---

## Item 3 — `pushsubscriptionchange` SW handler (auto re-subscribe + background re-register)

**Branch:** `feat/web-push-subscriptionchange`

### Goal

When the browser/push-service rotates or invalidates the device's push subscription in the
background, automatically re-subscribe and re-register with the server — instead of silently
losing delivery until the user next opens the app and the page re-registers.

### Premise validation (the load-bearing auth premise, validated against live code)

The valuable version re-registers with the server _in the background_ (no tab). That requires
the service-worker `fetch` to authenticate. Findings:

- The web app's primary transport is bearer/DPoP tokens in storage — but the **primary
  (same-origin) environment**, which is what the Tailscale-served phone PWA is, bootstraps via
  `client.auth.browserSession` (`apps/web/src/environments/primary/auth.ts:182`).
- That flow sets a session cookie (`apps/server/src/auth/http.ts:217`): `httpOnly: true`,
  `sameSite: "lax"`, `path: "/"`, `expires = session token expiry`.
- `authenticateHttpRequest` accepts that cookie (`EnvironmentAuth.ts:353`, method
  `browser-session-cookie`). A same-origin SW `fetch(url, {credentials:"include"})` **carries
  the cookie** (httpOnly blocks JS reads, not credentialed fetch; same-origin is same-site so
  `lax` allows it).
- **Conclusion:** background re-register is viable and **degrades gracefully** — if the cookie
  has lapsed, the POST 401s and we fall back to the existing next-visit page re-registration
  (i.e. no worse than today). The token/DPoP (`/oauth/token`) path is for _remote_ cross-origin
  environments only and is not the phone-PWA path.

### Approach

Two pieces:

1. **SW handler** in `apps/web/public/push-sw.js`:

   ```
   self.addEventListener("pushsubscriptionchange", (event) => {
     event.waitUntil((async () => {
       // Re-subscribe with the SAME applicationServerKey the old sub carried. For the common
       // case (push service rotated the endpoint, VAPID key unchanged) this is exactly right.
       const appServerKey = event.oldSubscription?.options?.applicationServerKey;
       if (!appServerKey) return;                       // nothing to rebind to
       let sub = event.newSubscription
         ?? await self.registration.pushManager.subscribe({
              userVisibleOnly: true, applicationServerKey: appServerKey });
       const json = sub.toJSON();
       if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;
       // Best-effort background re-register; graceful-fallback to next page load on failure.
       await fetch("/push/subscriptions", {
         method: "POST", credentials: "include",
         headers: { "content-type": "application/json" },
         body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
       }).catch(() => {});
     })());
   });
   ```

   Notes: `applicationServerKey` from `event.oldSubscription` avoids the SW needing to know the
   VAPID key. If the _VAPID key itself_ rotated (not just the endpoint), the old key is stale
   and the re-subscribe rebinds to it — but VAPID keys are generated once (`getOrCreateVapidKeys`)
   and effectively never rotate in this app, so this is the correct trade for the real case. A
   VAPID-key-rotation recovery is the separate client key-aware path already shipped (`d833afe6b`).

2. **New authenticated HTTP route** `POST /push/subscriptions` in `apps/server/src/http.ts`,
   mirroring `otlpTracesProxyRouteLayer` (a raw `HttpRouter.add` route, no contract needed):
   - `authenticateRawRouteWithScope(AuthOrchestrationOperateScope)` (cookie or bearer).
   - Parse `{ endpoint, keys:{p256dh, auth} }` from the JSON body.
   - **Reuse** the exact register logic the WS RPC uses (`ws.ts:1709-1733`): the
     `WebPushRelay.isAllowedPushEndpoint` SSRF guard → `PushSubscriptionRepository.upsert` with
     `createdAt = nowIso`. To avoid drift, extract that ~12-line body into a shared
     `registerPushSubscription(input)` effect (in the `PushSubscription` service module or a
     small `push/register.ts`) called by BOTH the WS handler and the new route. 400 on bad body,
     403/`{ok:false}` on disallowed endpoint, 204 on success.
   - Register the route layer into the same router the OTLP/attachments routes use, and add
     `/push-sw.js` is already served `no-cache` (verified — `http.ts:518`), so the new SW
     handler ships on next load without a stale-SW lag.

### Alternatives rejected

- **SW re-subscribes locally only, page re-registers on next visit (no HTTP route)** — adds
  ~nothing over the status quo: the server keeps the dead endpoint until a tab opens, which the
  existing key-aware on-load path already handles. The background server-update is the whole value.
- **SW opens a WebSocket and calls the existing `pushSubscriptions.register` RPC** — heavier
  (WS upgrade + Effect RPC client in the SW) for a one-shot write; the raw HTTP POST matches the
  existing `otlpTracesProxyRoute` precedent and the cookie-auth path.
- **`postMessage` an open client to do the RPC** — only works when a tab is open, defeating the
  background purpose.

### Files

- `apps/web/public/push-sw.js` — new `pushsubscriptionchange` handler.
- `apps/server/src/http.ts` — new `POST /push/subscriptions` route + router wiring.
- `apps/server/src/push/register.ts` (or extend `persistence/Services/PushSubscription.ts`) —
  extracted shared `registerPushSubscription` used by ws.ts + the route.
- `apps/server/src/ws.ts` — call the extracted helper (behavior unchanged).
- Tests: server test for the route (auth required, SSRF-rejected endpoint → non-2xx, valid →
  upsert); the SW handler is plain JS exercised via a small logic unit test if feasible, else
  covered by manual phone test.

### Limitations / follow-ups

- Pure-background re-register depends on the session cookie being unexpired when
  `pushsubscriptionchange` fires; on lapse it degrades to next-visit re-registration (documented,
  no regression).
- Does not add a durable SW credential (would remove even the cookie dependency) — larger,
  security-sensitive, out of scope.
- `pushsubscriptionchange` browser support is good on Android Chrome (the target); other engines
  vary — irrelevant for the stated Android use case.

---

## Design review outcomes (Stage 6 — 2 opus reviewers, correctness+security / simplicity+compat)

Both reviewers verified every premise against live code. Items 1 & 2 sound as written
(Item 1 confirmed green 13/13 in the server workspace where `retry:2` applies; Item 2 confirmed
no caller breaks — `ProviderService.listSessions` is the only consumer and wants live sessions).
Item 3 viable but its **snippet had real bugs**; applied fixes:

- **[HIGH wiring]** Raw route layers are aggregated in **`server.ts`** (`makeRoutesLayer =
Layer.mergeAll(...)`, ~line 349-363), not `http.ts`. Editing only `http.ts` ships an
  exported-but-never-merged layer → 404. → Add the new route layer(s) to both the `server.ts`
  import block and the `Layer.mergeAll`. Requirements (`PushSubscriptionRepository`,
  `WebPushRelay`) are already in that runtime, so no new service layer.
- **[MED naming]** Every authenticated raw route is under `/api` (`/api/observability/v1/traces`,
  `/api/project-favicon`); the dev proxy + `navigateFallbackDenylist` already cover `/api`. →
  Route is **`POST /api/push/subscriptions`** (not `/push/subscriptions`).
- **[MED-1 SW ordering]** Deriving `applicationServerKey` from `event.oldSubscription` and
  early-returning discards a valid `event.newSubscription` (populated, `oldSubscription===null`
  is common on Android Chrome). → **Register `event.newSubscription` FIRST**; only require
  `applicationServerKey` on the branch that actually calls `subscribe()`.
- **[MED-2 null key + no key route]** `applicationServerKey` is often null on Chrome and there is
  **no HTTP route** exposing the VAPID key (it rides only the WS descriptor). Early-return then
  no-ops in the common rotation case. → Add **`GET /api/push/vapid-public-key`** (unauthenticated;
  the key is explicitly not a secret per `WebPushRelay.ts`) and have the SW fetch it as the
  `applicationServerKey` fallback. Also removes the VAPID-rotation caveat.
- **[MED-3 shared contract]** The WS handler deliberately collapses SSRF-reject + persist-fail to
  `{ok:false}` to avoid widening its RPC error channel. → The shared helper returns a
  **discriminated** `"registered" | "rejected"` (SSRF branch → `"rejected"`; persistence failure
  caught _inside_ so it never escapes as an Effect error). WS maps `registered→{ok:true}` else
  `{ok:false}`; the route maps `registered→204`, `rejected→403`, and wraps its own
  `catchCause→500`.
- **[LOW CSRF defense-in-depth]** `sameSite:lax` + CORS (`devOrigin` only) + the opaque-origin
  viewer sandbox close CSRF today, but that leans on the viewer staying `allow-scripts` without
  `allow-same-origin`. → Require **`content-type: application/json`** on the POST route (forces a
  CORS preflight for any cross-origin caller, which the CORS layer denies) as cheap insurance.
- **[INFO SSRF]** `isAllowedPushEndpoint` is hostname-string-based (no DNS resolution) — a
  pre-existing blind-SSRF limitation shared identically with the existing WS RPC, same required
  scope. Applying the same guard in the route is necessary and sufficient _relative to the
  existing bar_; DNS-resolving hardening is a separate improvement to both paths, not a blocker.

**Code review (Stage 9, 1 opus reviewer on the Item 3 diff): no HIGH/MED defects.** Verified
auth-before-content-type, outcome→status mapping, persistence-failure-never-escapes (WS channel
stays boolean), no requirement-channel leak, clean refactor, SW ordering/`waitUntil`, CSRF
reasoning. Applied the one cheap coverage gap (the 400 bad-body route branch). Deferred as
non-blocking follow-ups (pre-existing / out of this batch's diff): (a) harden `isAllowedPushEndpoint`
against DNS→internal-IP SSRF — blind + auth-gated + shared identically with the existing WS RPC, so
this batch adds no new exposure; (b) a uniform request-body size cap on the raw JSON routes; (c) a
jsdom/mock unit harness for the SW handler ordering.

Revised Item 3 files: `apps/web/public/push-sw.js`; `apps/server/src/http.ts` (both route layers);
`apps/server/src/server.ts` (merge the layer(s)); a shared `registerPushSubscription` helper
(new `apps/server/src/push/register.ts` or extend the `PushSubscription` service) used by ws.ts +
the route; `apps/server/src/ws.ts` (call the helper). Tests: route auth + SSRF-reject + valid
upsert; VAPID-key GET returns the key.

## Cross-cutting

- Each item is independent → three branches, three squash-merges to `personal`, one verify gate
  per merge (Hard Rule 7). Fork practice: merge to `personal` unreleased; deploy (`t3-rebuild`)
  is a separate step offered to the user, not auto-run.
- No release/version bump (fork trunk). Item 3's SW change needs a phone smoke test after deploy
  (the SW-staleness gotcha: fully close+reopen the PWA to load the new SW).
