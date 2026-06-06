# Disable authentication (open-access mode) — 2026-06-06

> Naming note: the user-facing ask was "turn off the pairing feature", but
> pairing is the only bootstrap method — removing the gate without an
> alternative means _no authentication at all_. The toggle is named
> `disableAuthentication` (env `T3CODE_DISABLE_AUTH`, flag `--disable-auth`)
> so the security consequence is carried by the name, per design review.

## Goal

Running the server remotely (e.g. over a Tailnet) currently always gates every
browser/client on the pairing-code flow: a one-time token minted at startup or
from the Connections settings, exchanged for a session cookie. For a personal
single-user deployment on a trusted network this gate makes remote workflows
(rebuilds, restarts, new devices, cleared cookies) painful — every restart or
new browser profile needs a fresh pairing token.

Add a persistent opt-in toggle that disables the pairing gate entirely: when
on, any client that can reach the port is authenticated automatically with
full (administrative) scopes. Off by default; nothing changes unless the user
explicitly opts in.

## Background (how the gate works today)

Two-layer auth in `apps/server/src/auth/`:

1. **Bootstrap**: a one-time pairing credential (`PairingGrantStore`) is
   exchanged for a session — `POST /auth/browserSession` (cookie) or
   `POST /oauth/token` (bearer/DPoP token) via `EnvironmentAuth`.
2. **Session**: every HTTP request and WebSocket upgrade is authenticated by
   `EnvironmentAuth.authenticateRequest` (cookie → bearer → DPoP), failing
   with `ServerAuthInvalidCredentialError` when no valid credential is
   presented. WS upgrades may instead present a short-lived ticket
   (`wsTicket` query param) minted by `issueWebSocketTicket(session.sessionId)`
   — tickets are bound to a **real session row** in `SessionStore`.

The web client (`apps/web/src/environments/primary/auth.ts`,
`bootstrapServerAuth`) calls `GET /auth/session` on load; if the response says
`authenticated: false` and no desktop-bridge credential exists, the router
redirects to `/pair`. **If the server reports `authenticated: true`, the
pairing UI is never shown** — the client needs no changes for this feature.

## Approach

### 1. Toggle — `disableAuthentication` on `ServerConfigShape`

Resolved in `resolveServerConfig` (`apps/server/src/cli/config.ts`) with the
same precedence pattern the observability settings already use
(flag/env → bootstrap envelope where applicable → persisted settings file →
default):

1. CLI flag `--disable-auth`
2. Env var `T3CODE_DISABLE_AUTH` (boolean)
3. Persisted `disableAuthentication` in `~/.t3/userdata/settings.json`
   (`ServerSettings` gains an optional boolean field, decoding default
   `false`; read at startup next to the existing observability read)
4. Default `false`

This covers both halves of the ask ("persistent configuration **or** env
var"): the settings.json field survives restarts regardless of how the server
is launched; the env var / flag work for ad-hoc and scripted launches and
override the file.

### 2. Bypass — lazy singleton open-access session at the auth gate

In `EnvironmentAuth.make()` (which can read `ServerConfig` like its siblings —
`SessionStore.make` already does, so the dependency is satisfied), when
`config.disableAuthentication` is true, wrap the **inner `authenticateRequest`
closure** — not the public methods — so `getSessionState`,
`authenticateHttpRequest`, and the no-ticket branch of
`authenticateWebSocketUpgrade` all inherit the fallback through the one shared
implementation. The catch must sit at the _outermost_ pipe of
`authenticateRequest` so it also covers `ServerAuthInvalidCredentialError`
raised by the post-verify DPoP checks (a stale `Authorization: DPoP …` header
from a previous server secret must not lock the user out), not just the
token-verify step. On any `ServerAuthInvalidCredentialError` (missing **or**
invalid), fall back to a singleton **open-access session**:

- Lazily issued through the normal `SessionStore.issue` path — subject
  `"open-access"`, `AuthAdministrativeScopes` (the same scopes the startup
  pairing credential grants), method `bearer-access-token`.
- The issued token is cached in a `Ref<Option<string>>`; each fallback
  verifies the cached token via `sessions.verify` and reissues if
  verification fails (expiry, revocation). A concurrent double-issue race is
  benign — both rows are valid, the loser is dropped from the cache and ages
  out with its TTL.
- Lazy (not eager-at-boot) issuance is load-bearing, not a style choice:
  sessions hard-expire after `DEFAULT_SESSION_TTL = Duration.days(30)`
  (`SessionStore.ts`). A session issued once in `make()` would silently lock
  out a server left running past 30 days — exactly the long-running remote
  deployment this feature targets. The verify-and-reissue loop is the minimum
  that survives TTL expiry.

Because the fallback returns a _real_ session:

- `GET /auth/session` reports `authenticated: true` → the client never
  redirects to `/pair`; **zero web-client changes**.
- WebSocket upgrades authenticate through the same fallback, and
  `issueWebSocketTicket`/`verifyWebSocketToken` work unchanged (real
  `sessionId`).
- Session-management surfaces (Connections settings, client list, revoke)
  keep working; the open-access session shows up as one labeled client.
  Revoking it is harmless — the next request mints a new one.

The auth descriptor, pairing endpoints, and `/pair` route stay functional and
unchanged: pairing links can still be minted and used; they're just no longer
required.

### 3. Startup behavior when disabled

- `resolveStartupBrowserTarget` (`serverRuntimeStartup.ts`) opens the plain
  base URL instead of minting a startup pairing URL. (The desktop-mode branch
  already returns the plain base URL today; only the web branch changes.)
- Headless output: when disabled, skip `issueHeadlessServeAccessInfo`
  entirely (it mints a pairing credential) and print a separate
  open-access variant — connection string plus warning, no token/QR.
  `HeadlessServeAccessInfo` keeps its current required shape; a new
  `formatHeadlessOpenAccessOutput(connectionString)` formatter is added
  beside `formatHeadlessServeOutput` rather than making fields optional.
  Nothing machine-parses this output (desktop uses the bootstrap-envelope
  path, not stdout scraping), so the shape change is safe.
- A prominent startup warning is logged in **all** modes:
  `"Authentication is disabled — anyone who can reach this server has full control."`

## Alternatives considered

- **Synthetic principal (no session row).** Make `authenticateRequest` return
  a fabricated `AuthenticatedSession` when disabled. Rejected:
  `issueWebSocketTicket` → `SessionStore.issueWebSocketToken(sessionId)`
  requires a real session row, so WS tickets would break or need
  special-casing inside `SessionStore` — a deeper, wider change.
- **Auto-issue a cookie on `GET /auth/session`.** Server-side only, but gives
  a read endpoint a write side effect, duplicates expiry handling, and still
  issues per-browser sessions the user must manage. Rejected for cleanliness;
  the singleton-session fallback achieves the same UX without touching HTTP
  semantics.
- **Descriptor-driven client auto-exchange** (new bootstrap method, e.g.
  `"open-access"`; the client auto-POSTs `browserSession`). Cleanest
  HTTP-semantics story but touches `packages/contracts` (descriptor schema)
  and the web client for no user-visible gain. Rejected on blast radius.
- **Env var only (no persisted setting).** Smaller, but "persistent
  configuration" was an explicit half of the ask, and the observability
  settings already establish the persisted-file-read-at-startup pattern, so
  the marginal cost is low.

## Experiments

None — reading the code settled the design space (single viable bypass point;
toggle pattern dictated by existing precedent).

## Files touched

- `packages/contracts/src/settings.ts` — `disableAuthentication` boolean on
  `ServerSettings` (decoding default `false`) **and** the hand-maintained
  `ServerSettingsPatch` (`Schema.optionalKey(Schema.Boolean)`) — omitting the
  patch field would make it silently un-patchable later.
- `packages/shared/src/serverSettings.ts` — the persisted read returns a fixed
  `{otlpTracesUrl, otlpMetricsUrl}` shape today; generalize it (e.g.
  `parsePersistedServerStartupSettings` returning observability fields +
  `disableAuthentication`) rather than bolting on a parallel parse.
- `apps/server/src/config.ts` — `disableAuthentication` on `ServerConfigShape`.
- `apps/server/src/cli/config.ts` — flag + env var + persisted read +
  precedence resolution. Note **two** `CliServerFlags` construction sites:
  `resolveServerConfig`'s `normalizedFlags` and the inline literal in
  `resolveCliAuthConfig` (compile break if missed).
- `apps/server/src/auth/EnvironmentAuth.ts` — open-access fallback in
  `authenticateRequest` (+ singleton issuance).
- `apps/server/src/serverRuntimeStartup.ts` — skip startup pairing URL; warn.
- `apps/server/src/startupAccess.ts` — token-less headless output variant.
- Tests: `EnvironmentAuth.test.ts` (fallback paths incl. invalid-credential
  fallback and WS-ticket issuance off the open-access session), cli config
  resolution test (precedence), `startupAccess.test.ts` (open-access output
  variant), `serverSettings.test.ts` (explicit `true` persists; default
  `false` is stripped by `stripDefaultServerSettings` on write).

## Tradeoffs and known limitations

- **This is an off switch for authentication, not just for the pairing UI.**
  Anyone with network reach gets administrative scopes. That is the explicit
  point of the feature; the naming (`disableAuthentication`), the opt-in default,
  and the startup warning carry the communication burden. Intended for
  loopback/trusted-network (Tailnet) deployments.
- Restart churn: each server process mints one new open-access session row
  per process lifetime (plus reissues on expiry); old rows age out via TTL.
- A revoked open-access session resurrects on the next request. "Revoke all
  other sessions" therefore can't lock out network-local attackers while the
  toggle is on — consistent with the feature's premise.
- The persisted setting is read once at startup (like observability); changing
  it requires a restart. No settings-UI exposure in this iteration — users
  edit settings.json or use the env var. (Old clients can't wipe the field:
  the web client patches settings field-by-field via `splitPatch` +
  `applyServerSettingsPatch`/`deepMerge`, never round-tripping the whole
  struct. The existing "Reset all settings" action of a _new_ client resets
  it to `false` — the safe direction.)
- A user who enables the toggle, then downgrades to an older binary, loses the
  unknown field on that binary's next settings write (pre-existing
  lenient-decode behavior, not introduced here).

## Follow-ups deferred

- Settings-UI toggle (Connections panel) with a danger-styled confirmation.
- A scoped-down variant (standard client scopes instead of administrative).
