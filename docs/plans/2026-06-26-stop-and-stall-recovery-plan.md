# Plan — Stop & stall-recovery robustness — 2026-06-26

Design: `docs/design/2026-06-26-stop-and-stall-recovery-design.md`. Three independent fixes, each
TDD (failing test first), each its own commit. Full suite green before merge (Hard Rule 7).

## Task A — Watchdog: track open foreground-tool items

1. **Test (red).** In `apps/server/src/provider/Layers/ProviderTurnStallWatchdog.test.ts`: a
   snapshot with `openToolItemIds` non-empty and `lastEventType:"thread.token-usage.updated"`,
   `lastEventAt` past the threshold → assert **no** stop dispatched. Sibling: same but empty set →
   trips. Update `staleEntry` helper default to `openToolItemIds: new Set()`.
2. **Test (red).** In `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`:
   feed `turn.started` → `item.started{command_execution, itemId:X}` →
   `thread.token-usage.updated` and assert `listTurnActivity[0].openToolItemIds` contains X; then
   `item.completed{itemId:X}` and assert it's gone.
3. **Impl.**
   - `ProviderRuntimeIngestion.ts` (Services): add `readonly openToolItemIds: ReadonlySet<string>`
     to `TurnActivitySnapshot`.
   - `ProviderRuntimeIngestion.ts` (Layers): `FOREGROUND_TOOL_ITEM_TYPES = new Set([command_execution,
file_change, dynamic_tool_call, collab_agent_tool_call])`. In `recordTurnActivity`: init empty
     set on `turn.started`; on `item.started` with `payload.itemType ∈ set` and `event.itemId`
     present → add (copy set); on `item.completed` with `event.itemId` → remove (copy set); carry
     the set through the existing `{...existing, lastEventAt, lastEventType}` update.
   - `ProviderTurnStallWatchdog.ts`: `shouldTrip` replaces the `IN_FLIGHT_LAST_EVENT_TYPES` clause
     with `entry.openToolItemIds.size === 0`; delete the now-dead `IN_FLIGHT_LAST_EVENT_TYPES`.
4. **Verify**, commit: `fix(server): stop the turn-stall watchdog false-tripping on a tool-blocked turn`.

## Task B — Stop path: don't deadlock before teardown

1. **Test (red).** `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`: build a session whose
   `createQuery` returns a fake query with an async iterator that never yields/settles and a
   `close` spy. Start a turn, call `stopSession`, assert it **resolves** (within the test) and the
   `close` spy was called. (Today it would hang on `Fiber.interrupt`.)
2. **Impl.** `ClaudeAdapter.ts` `stopSessionInternal`: move the `query.close()` `Effect.try` block
   to **before** the `Fiber.interrupt(streamFiber)` block; wrap the `Fiber.interrupt` in
   `Effect.timeout(STOP_INTERRUPT_GRACE)` (`Duration.seconds(8)`, a backstop > SDK's 5 s SIGKILL)
   with a catch that proceeds on timeout. New named const + comment explaining the ordering.
3. **Verify**, commit: `fix(server): force claude session teardown instead of deadlocking on a wedged turn`.

## Task C — Stop button escalation

1. **Test (red).** `apps/web/src/components/ChatView.browser.tsx` (or the existing ChatView test):
   with a running turn, first Stop click dispatches `thread.turn.interrupt`; a second click (turn
   still running) dispatches `thread.session.stop`.
2. **Impl.** `ChatView.tsx`: local `useRef` escalation map keyed by thread id. `onInterrupt`: if not
   yet escalated for the active thread → dispatch `thread.turn.interrupt`, mark escalated, arm a
   ~6 s timer that dispatches `thread.session.stop` if the turn is still running; else (already
   escalated) → dispatch `thread.session.stop` now. A `useEffect` clears the entry + timer when the
   turn settles or the active thread changes. Relabel the button "Stop" → "Force stop" once escalated.
3. **Verify**, commit: `feat(web): escalate Stop to a hard session stop when a turn won't interrupt`.

## Gate

`pnpm typecheck && pnpm lint && pnpm test` (+ browser suite) — 0 failures — before squash-merge to
`personal`. No release (fork norm) unless instructed.
