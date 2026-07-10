# Turn-start session recovery (closed-query dead-end) — 2026-07-10

## Goal

Eliminate the user-facing dead-end where sending the next message on an existing
thread fails permanently with:

```
Provider turn start failed - ProviderAdapterSessionClosedError:
claudeAgent adapter thread is closed: <threadId>
  cause: Query closed before response received  (@anthropic-ai/claude-agent-sdk)
```

When the underlying Claude SDK `query` dies but the adapter's in-memory session
context is still present, a plain (non-pending-input) turn-start reuses the dead
query and fails, and there is **no recovery** — the thread is stuck behind a
session-error banner until the process restarts.

## Background — root cause (validated against live code)

Three linked facts produce the dead-end:

1. **The query can die while the context still looks alive (the race).**
   When the Claude subprocess exits, the SDK `Query` immediately rejects any
   further control call (`setModel` / `setPermissionMode`) and stdin write with
   *"Query closed before response received"* (`PU.performCleanup`). The adapter
   tears the context down **asynchronously**: `runSdkStream` observes the async
   iterator end → `handleStreamExit` → `stopSessionInternal`
   (`ClaudeAdapter.ts:2819`, `:2845`) marks `status:"closed"` and only then
   deletes the entry from the `sessions` map. Between the query dying and that
   teardown completing, a user `sendTurn` passes `requireSession` (`:2944` —
   status not yet `"closed"`, `stopped` not yet set) and calls into the dead
   query (`:3580`, `:3598`, `:3646`). `toSessionError` (`:1138`) maps the
   "closed" message → `ProviderAdapterSessionClosedError` **with a `cause`**
   (the `cause` is what distinguishes this from a fully-gone session, which is
   `SessionNotFound` with no cause).

2. **`listSessions` reports the dead session as active.**
   `ClaudeAdapter.listSessions` (`:3787`) returns *every* map entry regardless of
   `status`/`stopped` — unlike `hasSession` (`:3790`) which filters `stopped`.
   `ProviderService.listSessions` (`:877`) builds on that in-memory list. So
   `ensureSessionForThread` (`ProviderCommandReactor.ts:414`) sees the dead
   context as an active session and **reuses it** (`:589`) instead of resuming.

3. **The plain turn-start path has no auto-reattach.**
   `recoverTurnStartFailure → handleTurnStartFailure`
   (`ProviderCommandReactor.ts:879`, `:855`) only records a
   `provider.turn.start.failed` activity and sets the session-error banner — that
   recorded `detail` **is** the text the user sees. The reattach machinery
   (`continuePendingRequestAsNewTurn`, `:927`) exists only on the
   pending-user-input / approval paths, not on a plain "user sends the next
   message" turn.

**Cursor survival (validated):** `ProviderService.startSession` recovers the
resume cursor from the *persisted* `ProviderSessionDirectory`
(`ProviderService.ts:544`, `:569`) when the caller passes none, and the directory
is upserted after every `sendTurn` (`:684`). So evicting the dead in-memory
session and restarting **does not lose conversation context** — the fresh session
resumes from the persisted cursor.

## Approach (chosen)

Two changes: the reactive recovery that fixes the dead-end (B), and the
identity-guarded map delete (C) that B's recreate-under-same-threadId depends on
to be safe. (An earlier draft included a `listSessions` liveness filter as
"defense-in-depth"; design review showed B subsumes it and it touches 8+
consumers — dropped, see Alternatives.)

### Change B (primary) — reactive recovery on the plain turn-start path

In `ProviderCommandReactor.processTurnStartRequested`, when `providerService.sendTurn`
fails and the failure is a **session error** — detected by error **tag**
(`ProviderAdapterSessionClosedError` or `ProviderAdapterSessionNotFoundError`),
*not* by cause-presence, so the cause-less `requireSession` variant is also
caught — recover instead of dead-ending:

1. Evict any stale in-memory session for the thread (`providerService.stopSession`),
   wrapped **best-effort** (`Effect.catchCause`): it may already be gone, and
   `resolveRoutableSession` validation-fails when the persisted binding is absent —
   that must not abort the retry.
2. Retry the turn **once** via the normal resume path — re-run
   `buildSendTurnRequestForThread` + `sendTurn` **directly** (not a re-dispatch,
   which would re-trigger first-turn title/branch generation and is pointless
   against the `hasHandledTurnStartRecently` dedup). Because the stale session is
   now gone, `ensureSessionForThread` starts a fresh session and
   `ProviderService.startSession` resumes it from the persisted cursor
   (`ProviderService.ts:544`, `:569`).
3. If the retry also fails (or the failure was never a session error), fall
   through to the existing `handleTurnStartFailure` (records the activity + banner).

Guarded against loops by a **single retry** — the retry path does not itself
recover a second time; a second session error becomes the recorded failure. No new
persistent state.

### Change C (required for B's safety) — identity-guarded session delete

`stopSessionInternal` ends with `sessions.delete(context.session.threadId)`
(`ClaudeAdapter.ts:2941`) — an **identity-blind** delete by key. Teardown has many
yield points (notably `Fiber.interrupt(streamFiber).timeoutOption(8s)` at `:2911`),
so `handleStreamExit`'s teardown of the *old* context can be parked when Change B
recreates a *new* context under the same `threadId` (via `startSession`'s
replace-guard `sessions.set`, `:3473`). When the parked teardown resumes, its
key-based delete removes the **new** context → lost session + orphaned subprocess:
exactly the dead-end B set out to fix, now intermittent.

Fix: guard every `sessions.delete` on identity —
`if (sessions.get(threadId) === context) sessions.delete(threadId)` — so a stale
teardown never deletes a session it does not own. This is a pre-existing latent
race that B amplifies from "harmless" to "probable"; shipping B without C would
reintroduce the bug.

## Alternatives considered

- **`listSessions` liveness filter (former "Change A").** Filter
  `ClaudeAdapter.listSessions` on `stopped`/`status==="closed"` so
  `ensureSessionForThread` sees no active session and resumes proactively.
  **Rejected as part of this fix** (design review): (a) it cannot see the reported
  window — the failing trace carries a `cause`, i.e. `stopped===false` and status
  unmarked, which the filter does not exclude; (b) its `status==="closed"` clause
  is dead code (`status==="closed" ⟹ stopped===true` always, since both are set
  only in `stopSessionInternal`), so it reduces to `!stopped`; (c) Change B fires
  regardless of teardown timing and already recovers the marked window too, so the
  filter's only benefit is saving one failed `sendTurn` round-trip in the common
  case; (d) it changes what "a session" means for 8+ consumers
  (`ProviderService.listSessions`, binding sync, `runStopAll`, `CheckpointReactor`,
  `ProviderRuntimeIngestion`, three reactor sites). Not worth the blast radius.
  Captured as a non-blocking cleanup suggestion (align `listSessions` with
  `hasSession`'s `!stopped` contract) instead.
- **Synchronously probe query liveness in `requireSession`/`sendTurn`.** Rejected:
  the SDK exposes no synchronous "is closed" flag; liveness is only observable by
  the control call failing. Reactive recovery (Change B) is the only reliable
  signal.
- **Mark the context `stopped` the instant the SDK query closes.** This is what
  `handleStreamExit` already does — asynchronously. Making it synchronous would
  require the SDK to surface closure synchronously (it does not). No cheaper hook
  exists than the failed call.
- **Reuse `continuePendingRequestAsNewTurn` verbatim.** Rejected: that path carries
  a pending-request continuation message and dedups per `requestId`; a plain turn
  already *has* the user's message and should re-send *that*, not a synthesized
  continuation. The recovery reuses `buildSendTurnRequestForThread`, not the
  pending-request machinery.

## Files / modules touched

- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` —
  session-error detection + single retry in the turn-start failure path (Change B).
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` — identity-guarded
  `sessions.delete` (Change C).
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts` — repro +
  regression tests for Change B.

## Tradeoffs and known limitations

- Recovery re-sends the user's message on a freshly-resumed session. If the dead
  session had already partially processed the message before dying (rare — the
  failure is at *start*, before the message is enqueued), the resumed session
  could theoretically see it twice. Mitigated: the failure surfaces at
  `setModel`/`setPermissionMode`/`Queue.offer` *before* the message is delivered
  to the subprocess, so the original never ran.
- Single retry only — a thread whose provider genuinely cannot start (bad binary,
  auth failure) still dead-ends after one retry, which is correct (those are not
  transient session losses).

## Follow-ups deferred

- **`listSessions`/`hasSession` liveness consistency** (non-blocking): align
  `ClaudeAdapter.listSessions` (and peers) with `hasSession`'s `!stopped` contract
  so stopped-but-undeleted sessions are not reported as active. Benign today (no
  consumer breaks, per review) — an independent cleanup, not required by this fix.
- Other adapters (Codex/Cursor/Grok/OpenCode) share both the
  `listSessions`-returns-all shape *and* the identity-blind `sessions.delete`
  pattern; audit whether they need the Change C identity guard too. Out of scope
  (the reported bug is claudeAgent).

## Design review

One round, two adversarial reviewers (correctness, simplicity), converged:
- Correctness surfaced the identity-blind-delete race → promoted to **Change C**
  (required). Confirmed cursor survival, no listSessions-consumer breakage,
  correct scope/dedup handling.
- Simplicity showed Change B subsumes the former Change A's window → **dropped A**;
  flagged tag-based detection + best-effort eviction wrapping (folded into B).
Exit: findings applied; no new issues on re-read.
