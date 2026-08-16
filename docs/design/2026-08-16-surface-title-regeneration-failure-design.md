# Tell the user when "Regenerate title" fails

## Problem

Title regeneration runs in a reactor, and every failure path ends the same way:
`logWarning` → complete the request with no title (`ProviderCommandReactor.ts`). The spinner clears
and the title stays as it was.

That makes four different outcomes indistinguishable in the UI:

1. the CLI crashed,
2. the CLI hung and hit the 180s timeout,
3. the model returned the same title, so the rename was correctly skipped,
4. the request was superseded by a newer one.

Only (3) and (4) are successes. A user who hits (1) sees a button that appears to do nothing, and
keeps pressing it. That is exactly what happened: 4 of 4 regeneration attempts failed with no
feedback, and a 100% failure rate went unnoticed for two months
(`~/reports/t3code/2026-08/2026-08-16/2026-08-16-claude-textgen-node-options-rca.md`).

## Approach

Carry the outcome on the completion event and let clients react to it.

`thread.title.regeneration.complete` gains an optional `failed` flag. When set, and when the request
is still the current one, the decider stamps `titleRegenerationFailedAt` onto the emitted
`thread.meta-updated` payload. The projector writes it to the thread, so it reaches both the open
thread and every thread shell; a hook on each client watches for it changing and shows a message.

**A timestamp, not a boolean.** Clients need to detect a _new_ failure. A boolean that stays `true`
cannot distinguish a second failure from the first; a timestamp changes every time, so the hook can
fire on the edge. This mirrors how `classifyThreadCompletion` already detects completion edges.

**It is persisted, after a first design was falsified.** The first version of this design carried the
value only on the event, with no column, on the reasoning that the client reducer already spreads
optional payload fields. Exploration killed that: `applyShellStreamEvent` replaces a thread shell
**wholesale** with a server-built payload assembled from projection columns, so a non-persisted field
cannot reach the sidebar at all.

That matters because the sidebar is the primary surface, not a secondary one — "Regenerate title"
is reachable from the sidebar context menu for threads that are not open, which is exactly how the
failure was originally hit. The event-only design would have worked solely for the currently-open
thread and silently missed the case that motivated the work.

So `title_regeneration_failed_at` becomes a nullable column, and the value clears on the next
successful regeneration. Persistence does not resurrect a stale toast: the hook fires on a _change_
from a previously-observed value, so hydration cannot trigger it.

A transient shell-stream event kind was considered instead. Rejected: every shell event carries a
`sequence` and the reducer exists to maintain snapshot state, so a transient kind would need a new
raw-stream tap on both web and mobile that does not exist today — more new plumbing than a column,
for a weaker guarantee.

### Only the user-initiated path reports

Initial title generation runs automatically on every new thread. A toast for work the user never
asked for is intrusive, and at a high failure rate it would be a stream of noise. So only
regeneration — a button the user pressed, with an expectation of a result — reports. The automatic
path stays silent and is diagnosable from the log, which now names the no-output case distinctly
(`cliFailureDetail`, merged in `83dfd8cf4`).

### The message does not carry the CLI's error text

The flag is a boolean, not a reason string. A provider CLI's stderr is unbounded and untrusted — it
can carry absolute paths, environment detail, or token-shaped strings — and the UI's job here is to
stop lying, not to render a diagnostic. The full detail stays in the server log.

The cost is real and worth naming: a user who sees "Couldn't regenerate the title" still cannot tell
_why_ without server access. That is an acceptable first step over silence, and a bounded, sanitized
reason can follow if this proves insufficient in practice.

## Surfaces

- **Web** — toast via the existing `toastManager` / `stackedThreadToast`.
- **Desktop** — wraps web, so it follows automatically.
- **Mobile** — React Native, separate navigation. Reports on the same signal.
- **Contracts** — one optional command field, one optional event field. No wire break: both are
  optional, so an older client ignores them and an older server never sets them.
- **Providers** — not provider-shaped; the reactor is provider-agnostic here.

## Failure and edge cases

- **Superseded requests must not report.** The decider already guards title application on
  `requestIsCurrent`; the failure stamp uses the same guard, so a superseded request stays silent.
- **Initial hydration must not fire.** The hook records the last seen value per thread and only
  reports on a change from a previously-observed value, exactly as the completion notifier does.
  A freshly-observed thread has no previous value, so it cannot fire on load.
- **Server restart mid-flight.** The boot sweep clears interrupted regenerations by dispatching a
  completion with no `failed` flag, so a restart clears the spinner without claiming a failure. That
  is deliberate: the work was abandoned, not proven to have failed.

## Files touched

- `packages/contracts/src/orchestration.ts` — optional `failed` on the command, optional
  `titleRegenerationFailedAt` on the meta-updated payload
- `apps/server/src/orchestration/decider.ts` — stamp it when the request is current
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` — distinguish failure from
  "completed, no change"
- `packages/client-runtime/src/state/threadReducer.ts` — carry it onto the open thread
- `apps/server/src/persistence/Migrations/…` — nullable `title_regeneration_failed_at` column
- `apps/server/src/persistence/…/ProjectionThreads.ts` — read/write the column
- `apps/server/src/orchestration/projector.ts` — apply the event to the projection
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — include it in the shell
- `apps/web/…` — report it
- `apps/mobile/…` — report it

## Alternatives rejected

**Command receipts.** `OrchestrationCommandReceiptStatus` is `accepted | rejected` and exists for
dispatch idempotency in the outbox. The receipt lands when the command is accepted, long before the
reactor does the work, so it cannot carry the outcome.

**Infer failure from state.** Watch for `titleRegeneration` going non-null → null with the title
unchanged. Rejected: that is precisely outcome (3) as well, so it would report a failure every time
the model correctly decided the existing title was already right.

**Carry it on the event only, with no column.** This was the original plan, and it is wrong — see
"It is persisted, after a first design was falsified" above. A shell is rebuilt wholesale from
projection columns, so an event-only field never reaches the sidebar, which is the surface the
action is most often invoked from.

## Follow-ups deferred

1. A bounded, sanitized failure reason in the message, if the boolean proves too thin.
2. Applying the same treatment to the automatic initial-title path, if a quieter surface than a
   toast (a badge, say) turns out to be wanted.
