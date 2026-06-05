# Footer usage readout — implementation plan

Branch: `feat/footer-usage-readout`. Design: `docs/design/2026-06-04-footer-usage-readout-design.md`.
Order matters: contracts → server → web. Commit per task.

## T1 — Contracts: `account.usage.updated` event

`packages/contracts/src/providerRuntime.ts`:

- Add `"account.usage.updated"` to the `ProviderRuntimeEventType` literal list (after `account.rate-limits.updated`).
- Add `AccountUsageUpdatedType = Schema.Literal("account.usage.updated")`.
- Add payload schemas: `AccountUsageWindow { utilization: Number, resetsAt: NullOr(IsoDateTime) }`,
  `AccountUsageExtra { isEnabled: Boolean, usedCredits: Number, monthlyLimit: Number, utilization: Number, currency: NullOr(String) }`,
  `AccountUsageUpdatedPayload { fiveHour: NullOr(window), sevenDay: NullOr(window), extra: NullOr(extra) }` + exported type.
- Add `ProviderRuntimeAccountUsageUpdatedEvent` struct (mirror `...AccountRateLimitsUpdatedEvent`) and add it to the `ProviderRuntimeEventV2` union.

Commit: `feat(contracts): add account.usage.updated provider runtime event`

## T2 — Server: OAuth usage module + tests

New `apps/server/src/provider/Layers/OAuthUsage.ts`:

- `decodeUsageResponse` — Effect `Schema` for the raw API JSON (`five_hour`, `seven_day`, `seven_day_opus`, `extra_usage`), tolerant of nulls/missing.
- `normalizeUsage(raw): AccountUsageUpdatedPayload` — map raw → contract shape (used_credits/monthly_limit stay cents; utilization passthrough). **Pure — primary unit-test target.**
- `resolveOAuthToken: Effect<Option<string>, never, ...>` — env `CLAUDE_CODE_OAUTH_TOKEN` → keychain (`security find-generic-password -s "Claude Code-credentials[-<hash8>]" -w` via `ChildProcessSpawner`, `<hash8>`=sha256(CLAUDE_CONFIG_DIR) first 8 chars when set) → `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json` (FileSystem). Each branch best-effort; failures → next. Parse `.claudeAiOauth.accessToken`.
- `fetchUsageSnapshot(token): Effect<AccountUsageUpdatedPayload, ...>` — `HttpClient` GET `https://api.anthropic.com/api/oauth/usage` with `Authorization`, `anthropic-beta: oauth-2025-04-20` headers → filterStatusOk → json → decode → normalize.

Tests `OAuthUsage.test.ts` (@effect/vitest): `normalizeUsage` on the verified live sample → asserts fiveHour 45 / sevenDay 24 / extra used 43540, limit 200000, currency CAD; null `extra_usage`/`seven_day_opus` tolerated.

Commit: `feat(server): add OAuth usage fetch + token resolution`

## T3 — Server: single broadcasting poller in ClaudeAdapter

`apps/server/src/provider/Layers/ClaudeAdapter.ts` inside `makeClaudeAdapter` (after `sessions`/`offerRuntimeEvent`, ~line 1051):

- `const lastUsageRef = yield* Ref.make<AccountUsageUpdatedPayload | null>(null)`.
- `emitUsageForSession(context, payload)` — `makeEventStamp()` then `offerRuntimeEvent({ type:"account.usage.updated", eventId, provider:PROVIDER, createdAt, threadId: context.session.threadId, payload })`.
- Poller: `Effect.forever(Effect.sleep("60 seconds") → resolveOAuthToken → if Some: fetchUsageSnapshot → Ref.set → for each sessions.values(): emitUsageForSession)` `.pipe(Effect.ignoreCause({log:true}), Effect.forkScoped)`. Pattern from `makeManagedServerProvider.ts:141`. Also fire one immediate fetch on startup (forkScoped) so the Ref fills fast.
- On session registration (where a context is added to `sessions`), if `lastUsageRef` is Some, `emitUsageForSession` immediately for the new thread.
- Verify `HttpClient`/`ChildProcessSpawner` are in the adapter layer's context; if not, add to `ClaudeAdapterLive` provides. (If wiring is heavy, fall back to resolving token+fetch via a small injected service — keep blast radius small.)

Test: extend `ClaudeAdapter.test.ts` harness — stub the fetch to a fixed snapshot, register a session, `TestClock.adjust(60s)`, assert an `account.usage.updated` event is emitted on the stream with the right threadId/payload.

Commit: `feat(server): broadcast account usage to active sessions every 60s`

## T4 — Server: ingestion case → activity

`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` `runtimeEventToActivities()` switch (mirror `thread.token-usage.updated` at ~515):

```
case "account.usage.updated":
  // NOTE: account.rate-limits.updated stays dropped; fold in here on a future rate-limit-detail refactor.
  return [{ id: event.eventId, createdAt: event.createdAt, tone: "info",
            kind: "account.usage.updated", summary: "Account usage updated",
            payload: event.payload, turnId: toTurnId(event.turnId) ?? null, ...maybeSequence }];
```

Test: feed an `account.usage.updated` runtime event → expect one activity, kind `account.usage.updated`, payload preserved.

Commit: `feat(server): surface account.usage.updated as a thread activity`

## T5 — Web: derive + format helpers + tests

New `apps/web/src/lib/usage.ts` (mirror `lib/contextWindow.ts`):

- Types `UsageWindow`, `UsageExtra`, `UsageSnapshot`.
- `deriveLatestUsageSnapshot(activities): UsageSnapshot | null` — newest-first scan for `kind === "account.usage.updated"`, read `activity.payload`.
- `usageColor(pct): "green"|"yellow"|"orange"|"red"` — thresholds ≥90/≥70/≥50 (matches statusline.sh).
- `formatResetTime(iso, "time"|"datetime")` — `Intl.DateTimeFormat`, local, 24h: `14:30` / `Mon Jun 8, 04:00`.
- `formatCredits(cents)` → `$435.40`; `formatCreditsShort(cents)` → `$435`/`$2k`.

Tests `usage.test.ts` (vitest): color thresholds at boundaries; `formatCredits(43540)==="$435.40"`, `formatCredits(200000)==="$2000.00"`; `deriveLatestUsageSnapshot` picks the latest matching activity / returns null when none.

Commit: `feat(web): add usage snapshot derivation + format helpers`

## T6 — Web: `UsageMeter` component

New `apps/web/src/components/chat/UsageMeter.tsx`:

- Props `{ usage: UsageSnapshot }`. Render nothing if all segments null/disabled.
- Desktop (`hidden sm:flex`): compact bars — per segment `label · bar(width=util%) · value`, color via `usageColor`. extra value `formatCreditsShort`.
- Mobile (`flex sm:hidden`): pills — `5h 18%` `7d 21%` `$ 22%`.
- Wrap trigger in `Popover`/`PopoverTrigger openOnHover` + `PopoverPopup tooltipStyle side="top"` (mirror `ContextWindowMeter`): rows for 5-hour / 7-day (with `formatResetTime`) / Extra usage (`formatCredits used / limit` + currency), each with a thin bar.
- Color → tailwind classes; keep thresholds in one mapping.

(No standalone unit test; covered by lib tests + manual smoke. Optional render smoke if a web test setup exists.)

Commit: `feat(web): add UsageMeter readout component`

## T7 — Web: wire into BranchToolbar

- `BranchToolbar.tsx`: add `activities?: readonly OrchestrationThreadActivity[]` to `BranchToolbarProps`; compute `deriveLatestUsageSnapshot(activities)`; render `<UsageMeter>` in a new middle wrapper `<div className="flex min-w-0 flex-1 justify-center">` between the left env group and `BranchToolbarBranchSelector`. Adjust the branch selector's `flex-1` so the middle gets the slack (branch selector → `md:flex-none`, already is).
- `ChatView.tsx` (~3907): pass `activities={activeThread?.activities}` to `<BranchToolbar>`.

Commit: `feat(web): show usage readout in the branch toolbar`

## T8 — Verify

- `bun run typecheck` (or repo's check) clean.
- `bun test` for touched packages green.
- Manual smoke: run web app, confirm readout renders with live data, hover popover shows resets + dollars, colors correct. Screenshot.
