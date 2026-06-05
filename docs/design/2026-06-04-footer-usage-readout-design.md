# Footer usage readout — design

**Date:** 2026-06-04
**Branch:** `feat/footer-usage-readout`
**Status:** Design

## Goal

Surface Claude account usage in the t3code web UI, in the empty middle of the
`BranchToolbar` row (between "Current checkout" and the branch selector) — mirroring
the user's terminal statusline:

```
5h 18% @14:30 | 7d 21% @Mon Jun 8, 04:00 | extra $435.40/$2000.00
```

t3code already shows model, branch, context-window %, and effort. The three usage
figures (5-hour limit, 7-day limit, extra/overage spend) are the missing pieces.

## Data source (verified against live API, 2026-06-04)

All three figures come from a single call to the Anthropic OAuth usage endpoint —
the same source `~/.claude/statusline/statusline.sh` uses for its `extra` segment:

```
GET https://api.anthropic.com/api/oauth/usage
  Authorization: Bearer <oauth_token>
  anthropic-beta: oauth-2025-04-20
```

Live response shape (confirmed on this machine):

```jsonc
{
  "five_hour": { "utilization": 45.0, "resets_at": "2026-06-04T19:30:00+00:00" },
  "seven_day": { "utilization": 24.0, "resets_at": "2026-06-08T09:00:00+00:00" },
  "seven_day_opus": null,
  "extra_usage": {
    "is_enabled": true,
    "monthly_limit": 200000, // cents → $2000.00
    "used_credits": 43540.0, // cents → $435.40
    "utilization": 21.77, // percent
    "currency": "CAD",
    "disabled_reason": null,
  },
}
```

`utilization` is a float percent; `resets_at` is ISO 8601 UTC; `used_credits` /
`monthly_limit` are integer cents. This is the entire payload the statusline shows.

### OAuth token resolution

The `@anthropic-ai/claude-agent-sdk` does not expose its access token to server code,
but the server runs locally on the same machine as the credentials, so we resolve the
token directly — exactly as `statusline.sh`'s `get_oauth_token()` does, in order:

1. `CLAUDE_CODE_OAUTH_TOKEN` env var
2. macOS Keychain: `security find-generic-password -s "Claude Code-credentials[-<hash8>]" -w`,
   where `<hash8>` is the first 8 chars of `sha256(CLAUDE_CONFIG_DIR)` when that env var is
   set (default service has no hash suffix). Parse `.claudeAiOauth.accessToken`.
3. `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json` → `.claudeAiOauth.accessToken`

Verified on this machine: token lives in the Keychain under the default service name
`Claude Code-credentials` (no `CLAUDE_CONFIG_DIR` set). Token resolution is best-effort:
if no token is found, the poller emits nothing and the UI simply shows no usage segment
(graceful, matches statusline's `-` placeholder behavior).

## Approach

A server-side poller fetches the normalized usage snapshot and emits it as a provider
runtime event; the web client derives it from thread activities (the same path the
context-window meter already uses) and renders a responsive readout in `BranchToolbar`.

### Why poll (not reuse the SDK `rate_limit_event`)

The SDK already emits a `rate_limit_event` → `account.rate-limits.updated`, but:

- it carries **no** `extra_usage` dollar figures (only overage _status_ + `resetsAt`);
- it fires **one `rateLimitType` per event** (five_hour / seven_day / overage separately),
  forcing client-side accumulation of partial snapshots;
- it only fires **during an active turn** — no at-rest updates.

Since we must call the usage API anyway for the dollar figures, and that one call
returns all three figures in a single complete snapshot, polling it is both simpler
(one normalized payload, no accumulation) and fresher (updates at rest). The existing
SDK `account.rate-limits.updated` emit is left untouched (it is currently dropped at
ingestion and nothing consumes it).

### Server

1. **New module** `apps/server/src/provider/Layers/OAuthUsage.ts`:
   - `resolveOAuthToken`: env → keychain → credentials file (best-effort, returns
     `Option<string>`). Kept all three to match the reference `statusline.sh` exactly —
     the file branch is the Linux/remote fallback and is ~5 lines, so the marginal cost is
     negligible (design-review note: a v1 could drop the file branch; kept for parity).
   - `fetchUsageSnapshot`: `HttpClient` GET to the usage endpoint (mirrors the existing
     `@effect/platform` `HttpClient` usage in `apps/server/src/http.ts`), decodes the
     response with an Effect `Schema`, normalizes to the `AccountUsageUpdatedPayload` shape.
     A pure function — no caching here; throttling is handled by the single poller below.

2. **Single adapter-lifetime poller** in `makeClaudeAdapter`
   (`apps/server/src/provider/Layers/ClaudeAdapter.ts`). _(Revised after design review —
   the original per-session-fork design left threadId routing underspecified and
   N-sessions→N-fetches; a single poller + broadcast is simpler and correct.)_
   - `offerRuntimeEvent` (line 1050) is a free function over the **adapter-wide**
     `runtimeEventQueue`, callable from any fiber in the adapter scope. Every event carries
     `threadId: context.session.threadId`, and `sessions` (line 1032) is a
     `Map<ThreadId, ClaudeSessionContext>` of all live sessions.
   - Fork **one** `Effect.forkScoped` fiber at adapter scope (loop pattern from
     `makeManagedServerProvider.ts:141`). Each 60s tick: `fetchUsageSnapshot` once, store it
     in a `Ref<AccountUsageUpdatedPayload | null>`, then for every `context` in
     `sessions.values()` emit one `account.usage.updated` event (stamped via the existing
     `makeEventStamp()`, `provider: PROVIDER`, `threadId: context.session.threadId`).
   - On **session start**, if the `Ref` already holds a snapshot, emit it immediately for the
     new thread so the readout populates without waiting for the next tick.
   - One API call per 60s regardless of session count; the `Ref` replaces the separate
     `Cache`. Fiber is adapter-scoped → interrupted on adapter shutdown. No token → fetch is
     a no-op, `Ref` stays null, nothing emitted.

3. **Ingestion case** in `runtimeEventToActivities()`
   (`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`): add
   `case "account.usage.updated"` → activity `{ kind: "account.usage.updated", tone: "info",
summary: "Account usage updated", payload }`. This is the load-bearing change — without it
   the event is dropped at the `default` branch (same gap that currently swallows
   `account.rate-limits.updated`). Transport (`ws.ts`) needs no change: it gates on
   `thread.activity-appended`, which this produces.

### Contracts (`packages/contracts/src/providerRuntime.ts`)

Add a new event `account.usage.updated` with a typed payload (do **not** repurpose the
`Unknown`-typed `account.rate-limits.updated`, to avoid breaking its existing producer):

```ts
const AccountUsageWindow = Schema.Struct({
  utilization: Schema.Number, // percent, float
  resetsAt: Schema.NullOr(IsoDateTime), // ISO 8601, null if absent
});
const AccountUsageExtra = Schema.Struct({
  isEnabled: Schema.Boolean,
  usedCredits: Schema.Number, // cents
  monthlyLimit: Schema.Number, // cents
  utilization: Schema.Number, // percent
  currency: Schema.NullOr(Schema.String),
});
const AccountUsageUpdatedPayload = Schema.Struct({
  fiveHour: Schema.NullOr(AccountUsageWindow),
  sevenDay: Schema.NullOr(AccountUsageWindow),
  extra: Schema.NullOr(AccountUsageExtra),
});
```

Plus: add `"account.usage.updated"` to `ProviderRuntimeEventType`, the
`AccountUsageUpdatedType` literal, the event struct, and the `ProviderRuntimeEvent` union.

The ingestion `case` carries a comment noting that `account.rate-limits.updated` remains
dropped and could be folded in by a future rate-limit-detail refactor.

For `formatResetTime`, use `Intl.DateTimeFormat` (24-hour, local tz) rather than hand-rolled
parsing — `new Date(iso)` parses the UTC ISO string and `Intl` handles tz/locale (review nit).

### Web

1. **`apps/web/src/lib/usage.ts`** — `deriveLatestUsageSnapshot(activities)` (mirrors
   `deriveLatestContextWindowSnapshot`): scan activities newest-first for
   `kind === "account.usage.updated"`, return a typed `UsageSnapshot | null`. Plus pure
   helpers: `usageColor(pct)` (thresholds identical to `statusline.sh`: ≥90 red, ≥70 orange,
   ≥50 yellow, else green), `formatResetTime(iso, "time"|"datetime")` (local "14:30" /
   "Mon Jun 8, 04:00"), `formatCredits(cents)` (`$435.40`).

2. **`apps/web/src/components/chat/UsageMeter.tsx`** — responsive readout:
   - **≥ ~640px (desktop):** compact bars — `5h ▮▮·· 18%   7d ▮▮·· 21%   extra ▮▮·· $435/$2k`.
   - **< ~640px (mobile):** pill fallback — `5h 18%` `7d 21%` `$ 22%`.
   - **hover/tap:** `Popover`/`PopoverPopup` (same primitives as `ContextWindowMeter`) with
     full detail: exact %, reset times, `$435.40 / $2000.00` (+ currency).
     Colors via `usageColor`. Renders nothing when snapshot is null or has no enabled segments.

3. **Integration** — render `<UsageMeter>` in `BranchToolbar.tsx`'s middle slot (a new
   `flex-1 justify-center` wrapper between the left env group and the right
   `BranchToolbarBranchSelector`). `BranchToolbar` receives the active thread's activities
   via a new prop threaded from `ChatView` (which already holds `activeThreadActivities` and
   passes them to `ChatComposer`).

## Files touched

| File                                                               | Change                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| `packages/contracts/src/providerRuntime.ts`                        | new `account.usage.updated` event + typed payload          |
| `apps/server/src/provider/Layers/OAuthUsage.ts`                    | **new** — token resolve + fetch + 60s cache                |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`                 | fork scoped 60s poller per session                         |
| `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` | ingestion `case` → activity                                |
| `apps/web/src/lib/usage.ts`                                        | **new** — derive + format helpers                          |
| `apps/web/src/components/chat/UsageMeter.tsx`                      | **new** — responsive readout + popover                     |
| `apps/web/src/components/BranchToolbar.tsx`                        | render `<UsageMeter>` in middle slot                       |
| `apps/web/src/components/ChatView.tsx`                             | thread activities prop → `BranchToolbar`                   |
| + tests                                                            | `OAuthUsage.test.ts`, `usage.test.ts`, ingestion case test |

## Tradeoffs & limitations

- **Account data on a thread-scoped channel.** Usage is account-global but rides the
  per-thread activity stream (smallest blast radius — reuses existing transport; no new
  account-level subscription). Consequence: the snapshot is duplicated as the latest
  activity on each thread, and updates only flow while ≥1 session is alive. Acceptable:
  usage only matters while working. A dedicated account-level channel is a possible
  future refactor (noted as follow-up).
- **Local-credential dependency.** Reading the Keychain/credentials file only works when
  the server runs on the user's machine (it does, for the desktop app). A remote/headless
  server without local creds shows no usage segment — graceful degradation.
- **Currency.** `extra_usage.currency` may be non-USD (CAD on this account). Inline shows
  `$`; the popover shows the currency code to disambiguate.
- **60s freshness.** Matches the statusline's cache TTL; not real-time.

## Follow-ups deferred

- Account-level (non-thread) subscription channel for genuinely global state.
- Optionally consume `seven_day_opus` when present (per-model weekly limit).
- Desktop/Tauri statusline parity if the desktop shell renders its own bar.
