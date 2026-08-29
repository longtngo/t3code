# Cursor vitals popup: honest context, working refresh — 2026-08-28

## Goal

Two user-reported defects on the composer vitals popover when the thread runs Cursor:

1. It does not show what the Claude popover shows.
2. The refresh control "does not seem to work, or it still receives stale data."

Done means: the popover no longer silently omits a section without saying why, and pressing
refresh visibly changes something on an idle thread.

## Baseline @ 69212ea7e (2026-08-28)

```
context activities by provider instance:
  bun -e '<join projection_thread_activities to projection_threads>' →
  claudeAgent_personalsub 173979 | claudeAgent 144655 | codex 65 | cursor 0

fetchedAt present on account.usage.updated payloads:
  cursor 0/4 | codex 0/1 | claudeAgent 4/1183 | claudeAgent_personalsub 11/223

live Cursor provider sessions:
  SELECT status, COUNT(*) FROM projection_thread_sessions WHERE provider_name='cursor'
  → stopped 10   (ready 0, running 0)
  all providers: claudeAgent stopped 451 / ready 4 / running 2 / error 1; codex stopped 2 / error 1

staleness of the projected Cursor numbers vs the live dashboard API (measured by the RCA):
  projected auto 7.23%, onDemand.usedCredits 395760   (written 2026-08-28T03:22:33Z)
  live API      auto 55.31%, pooledUsed      423908
```

Regression floor: `pnpm verify` — RED at baseline on `packages/shared/src/Net.test.ts`
(`findAvailablePort returns preferred when it is free`). Drained first on
`fix/net-test-port-race`; that is a Hard Rule 6 follow-up, not part of this item.

## Root cause (independent RCA + own measurement, agreeing)

**1. No context block.** `VitalsDetail` renders `ContextBlock` only when
`deriveLatestContextWindowSnapshot` finds a `context-window.updated` activity
(`VitalsGauge.tsx:675`). Those are projected only from `thread.token-usage.updated`
(`ProviderRuntimeIngestion.ts:994`), which **only `ClaudeAdapter` and `CodexAdapter` emit**.
Cursor, Grok and OpenCode emit none.

The premise "Cursor could report it if we asked" is **false, measured**. t3code drives Cursor over
ACP (`cursor-agent acp`). Against cursor-agent `2026.08.25-3e8eec8`, a raw ACP client that logs
every `session/update` saw `session_info_update`, `available_commands_update`,
`agent_thought_chunk`, `agent_message_chunk` and **no `usage_update`**; `session/prompt` returned
`{"stopReason":"end_turn"}` with **no `usage`** member. The ACP schema defines both
(`UsageUpdate{size,used}`), and no client capability gates them — cursor-agent simply does not send
them. Its `--output-format stream-json` mode does report `usage`, but that is a different transport
t3code does not use.

**2a. The refresh control has no feedback.** Its visible label is
`formatSnapshotAge(usage.fetchedAt, now)` (`VitalsGauge.tsx:316`), which returns `null` when
`fetchedAt` is absent. Only Claude's `OAuthUsage.ts:249-253` stamps it. `CursorUsage.ts` and the
Codex path never do, so the control renders as a bare 12px icon that never changes.

**2b. The refresh genuinely does nothing on an idle thread.** `refreshAccountUsage` polls, caches
into `lastUsageRef`, then emits **only** `for (const context of sessions.values())`
(`CursorAdapter.ts:423-429`; `ClaudeAdapter.ts:2123-2131` is identical). A thread whose provider
session has stopped is not in that map, so the RPC returns `{ok:true}` having updated nothing the
UI can see. Every Cursor session on this machine is `stopped`, so for Cursor this is not an edge
case — it is the only case.

## Approach

Three changes, smallest first.

### A. Stamp `fetchedAt` at the fetch, for Cursor and Codex

Mirror `OAuthUsage.ts`: stamp the moment the HTTP response is normalized, not at emission. The
field is already optional on `AccountUsageUpdatedPayload` and already read by the UI, so this is
purely a producer-side gap. Gives the control a label that moves, which is what makes a press
observable at all.

### B. Route an on-demand refresh to the thread that asked

`WsAccountUsageRefreshRpc`'s payload becomes `{ threadId?: ThreadId }`. The client passes the
thread it is showing; `ChatComposer` already holds `activeThreadId` and threads it through
`VitalsGaugeConnected` → `useAccountUsageRefresh`.

**`ProviderService` resolves the thread to ONE adapter before emitting.** The refresh today walks
`getAdapterEntries` and asks every adapter; handing `threadId` to all of them would let the Claude
adapter stamp Claude's OAuth numbers onto a Cursor thread. So when `threadId` is present, take the
route the rest of the service already takes — `directory.getBinding(threadId)` →
`requireBindingInstanceId` → `registry.getByInstance` (`ProviderService.ts:529-539`) — and give the
threadId only to that adapter. Every other adapter is still polled, session-scoped, exactly as
today. A thread with no binding refreshes environment-wide rather than failing: the button is not
worth an error dialog.

Why the requesting thread rather than a fan-out to every thread bound to the instance: the user
pressed a button while looking at one thread, and a fan-out would rewrite the usage row on
hundreds of archived threads for one press. Optional rather than required so the existing
poller and the environment-wide press keep working unchanged.

**Observability.** `{ok: true}` is what made this bug invisible: the RPC has always reported
success for a refresh that emitted nothing. The success payload becomes
`{ ok: true, emitted: number }` — the count of `account.usage.updated` events the press produced —
and `ProviderService` logs `provider.account-usage.refresh-emitted` with the instance id, the
resolved threadId, and that count. Zero emits is then readable from production signal instead of
being indistinguishable from success. The client does not render the count; it exists for the log
and for the tests.

### C. Say why the context block is missing

When the thread's provider reports no context usage, render one muted line in place of the block:
`Cursor does not report context usage.`

The alternative — leave it out — is what produced this bug report. An absence with no explanation
reads as breakage; three providers of five are in that state permanently, so the explanation is
worth its one line.

**Gate on the thread's SESSION provider, not the model picker.** `activeThreadProviderDisplayName`
is derived from `activeThreadModelSelection` (`ChatComposer.tsx:1101-1110`) — the picker, which the
user can move at any time without the thread having run there. Gating on it would put "Cursor does
not report context usage" on a thread that ran its whole life on Claude and merely has the picker
parked on Cursor. `OrchestrationSession` already carries `providerName`
(`contracts/orchestration.ts:431`), which is what the thread actually ran on; that is the key.

Absence of a snapshot is NOT the key either: the database holds started Claude threads with
messages and zero `context-window.updated` rows, so "no snapshot" and "provider never reports" are
different states and only the second one earns the line. The set is a small
`PROVIDERS_WITHOUT_CONTEXT_USAGE` beside `formatProviderDisplayName`, and the line renders only
when the session's provider is in it.

A thread with no session yet shows nothing — same as today.

## Alternatives rejected

- **Make Cursor report context usage.** Not available over ACP (measured above). Would mean moving
  the Cursor transport to `--output-format stream-json`, which loses ACP's permissions, plans, and
  tool-call structure. Wrong trade for a readout.
- **Derive a context estimate client-side** from message bytes. Invents a number; the meter would
  disagree with the provider and there is nothing to reconcile against. Rejected outright.
- **Fan the refreshed payload out to every thread on the instance** (2b). One press would write
  hundreds of activity rows and push them over every open websocket. Rejected on the performance
  rule.
- **Move account usage to an environment-scoped read model** instead of a per-thread activity.
  Correct long-term shape and it deletes the session-gating problem entirely, but it touches the
  contract, the projector, both clients, and the poller. Out of proportion to a refresh button.
  Recorded as a follow-up.

## Test plan

- `ProviderService`: a refresh carrying a threadId bound to instance A gives the threadId to A's
  adapter and to no other adapter. Mutation to guard against: dropping the binding lookup and
  fanning the threadId out.
- `CursorAdapter`: `refreshAccountUsage(threadId)` with an EMPTY session map emits exactly one
  `account.usage.updated` for that thread. With a live session for a different thread, it emits for
  both and not twice for either.
- `CursorUsage`: the normalized payload carries `fetchedAt`, and it is the fetch time rather than
  the emit time (assert it differs from a later emission's `createdAt`).
- RPC: `{}` and `{ threadId }` both decode; `{}` keeps today's behaviour.
- `VitalsDetail`: the "does not report context usage" line renders for a Cursor thread with no
  snapshot, and does NOT render for a Claude thread with no snapshot yet.
- The `emitted` count is asserted, since it is the signal the whole fix is judged by.

## Deployment ordering

Server and client ship as one app here, but the wire is version-skewed whenever a phone or a
browser on `app.t3.codes` outlives a server upgrade. An old server accepts `{ threadId }` and
ignores it (Effect `Schema.Struct({})` strips unknown members rather than rejecting them —
verified), so a new client against an old server silently gets today's behaviour. That is a
degradation, not a break, and it needs no client-side gate.

## Files touched

- `apps/server/src/provider/Layers/CursorUsage.ts` — stamp `fetchedAt`
- `apps/server/src/provider/Layers/CodexUsage.ts` — stamp `fetchedAt` (the poll normalizes here,
  not in the adapter)
- `packages/contracts/src/rpc.ts` — optional `threadId` on the refresh RPC
- `apps/server/src/ws.ts`, `apps/server/src/provider/Layers/ProviderService.ts` — forward it
- `apps/server/src/provider/accountUsageBroadcast.ts` (new) — the poll/cache/emit block the three
  adapters each carry a copy of, with the session-less emit added ONCE
- `apps/server/src/provider/Layers/{Cursor,Claude,Codex}Adapter.ts` — call it
- `apps/server/src/provider/Services/*Adapter.ts` — shape change
- `packages/client-runtime/src/state/accountUsage.ts`, `apps/web/src/hooks/useAccountUsageRefresh.ts`,
  `apps/web/src/components/chat/VitalsGauge.tsx`, `apps/web/src/components/chat/ChatComposer.tsx`,
  `apps/web/src/lib/contextWindow.ts`
- mobile: the vitals popover surface, if it renders one

## Tradeoffs and limitations

- Cursor's usage rows still carry no pace projection, because Cursor's windows have no fixed
  length. Deliberate; a pace on an unknown window length is a fabricated number.
- The refresh still cannot update a thread whose provider instance has no credentials; it fails
  silently by design (`ProviderService` logs and swallows per provider).
- Stamping `fetchedAt` does not make the numbers fresher. It makes the staleness legible, which is
  the honest half; **B** is the half that makes them fresh.

## Follow-ups deferred

- Environment-scoped account-usage read model (replaces per-thread activity fan-out entirely).
- Grok and OpenCode have the same missing-context-block state and inherit **C**, but neither was
  probed for whether their transports carry usage. Worth one probe each.
