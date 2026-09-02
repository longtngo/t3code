# Crew Orchestration — Design (revision 16)

**Date:** 2026-09-01 · **Base:** `personal` @ `01c68bb03` · **Branch:** `feat/crew-orchestration`

You talk to one thread; it dispatches, supervises, and reports on a fleet of
autonomous worker threads, each in its own git worktree.

Sixteen review rounds produced this. The history is in
`2026-08-16-crew-orchestration-review-log.md`.

**Revision 14 deleted four mechanisms; revision 15 repairs what that broke and
what the new text got wrong.** Round 4 found that the design's heaviest machinery
guarded states this repo does not produce — the destruction surface is inert on
any tree that has run setup, the shell-stream wire path did not work and was ~10×
the surface of a shipped in-repo precedent, and `deliveredAt` was a column whose
two jobs contradicted each other. Those deletions stand.

Round 5 then found six criticals, all in newly-written text. Two were regressions
the deletions caused: the session reaper discards a queued note while `notedAt`
already reads handled, so `progress` loss became invisible (`notedWithoutTurn`
restores it, §4), and teardown's close-first order silently drops a report filed
one tick earlier (a drain step, §6). Two were in §5's reordered steps: the
per-sweep wake budget was gating the append as well as the wake, and a non-Claude
bridge starved its `needs-decision` behind `progress` backlog. Two were **false
`[V]` rows in §1** — the MCP credential and `stopSession`'s failure modes — each
contradicted by the doc comment of the file it cited, and each load-bearing for a
§5 mechanism that is now gone or bounded.

What survives is still: reserve a row, create a worktree, note or wake, close the
row, delete nothing.

## 0. Reading this document

**Tags:** `[X]` executed · `[V: path:line]` read at `01c68bb03` · `[W]` verified
absent, must be written · `[U]` unverified.

**A `[V]` on "we can call X" must cite an exported signature, not a definition.**
This document has rested on an unreachable private closure twice.

**Every predicate is stated once.** §5 owns delivery, §4 owns the schema, §8 owns
the refusals. Nothing restates them; a section that needs one cites it.

Line numbers rot. When a citation and the code disagree, the code wins.

## 1. Primitives this design rests on

| Capability                        | Reality                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appendSessionNote`               | Puts text into a live session **without starting a turn**; returns `false` when it could not `[V: apps/server/src/provider/Services/ProviderService.ts:155-159]`. **Claude only** — the other four adapters return `Effect.succeed(false)` `[V: apps/server/src/provider/Layers/{CodexAdapter.ts:2156,CursorAdapter.ts:1310,GrokAdapter.ts:2064,OpenCodeAdapter.ts:3316}]`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| …what it checks                   | The service layer checks binding → adapter → provider `[V: apps/server/src/provider/Layers/ProviderService.ts:1251-1266]`, and the Claude adapter then checks its own in-process session, returning `false` on `context.stopped` or session status `closed` `[V: ClaudeAdapter.ts:5284 → requireSession :4374-4395, :4386]`. Nothing anywhere checks `archivedAt`. It answers _"can I place text"_, never _"should this thread be woken"_                                                                                                                                                                                                                                                                                                                                                                                          |
| …what `true` means                | Queued into the SDK prompt stream, read on the agent's **next turn**. No next turn, nobody reads it `[V: ClaudeAdapter.ts:5284-5317]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The in-repo wake precedent        | Evaluates its idle guard first, then appends `[V: apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1938-1945 then :1975]`. **Do not call `maybeWakeThreadForCompletedTask`** — it has a `subagentOwned` branch that appends and returns _without waking_ `[V: ibid. :1984]`. Crew mirrors its shape; it does not reuse it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Archival and turns                | `thread.turn.start` calls `requireThread`, not `requireThreadNotArchived` `[V: apps/server/src/orchestration/decider.ts:982-986]`, so **archiving does not stop a thread taking turns** `[X: accepted on an archived thread; control `thread.snooze` rejected]`. It is not the only such command — `requireThreadNotArchived` guards 8, and 20 other sites use plain `requireThread` — but that is the only property crew needs                                                                                                                                                                                                                                                                                                                                                                                                    |
| The stall watchdog                | `shouldTrip` checks `archivedAt === null`; the **resume branch does not** `[V: apps/server/src/provider/Layers/ProviderTurnStallWatchdog.ts:233 vs :256-272]`. `stopSession` is what makes `activeTurnId` null, so a teardown landing inside the stop-grace window arms a resume on the next 60s sweep                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| …and its shape                    | Exports exactly `start` and `adoptExternalStop` `[V: apps/server/src/provider/Services/ProviderTurnStallWatchdog.ts:16, :32]`. `clearRecord` is a private closure with zero external references `[X: 3 hits, all internal; control `adoptExternalStop` reaches ws.ts:1283]`, and `adoptExternalStop` _arms_ recovery rather than clearing it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `stopSession`                     | `Effect<void, ProviderServiceError>` `[V: apps/server/src/provider/Services/ProviderService.ts:93-95]`. Idempotent on an already-stopped session. It fails deterministically in **three** persisted cases, not one: no binding, a binding whose `providerInstanceId` is undefined, and an instance not in the registry `[V: apps/server/src/provider/Layers/ProviderService.ts:321-331, :526-572]`. **Only two are reachable from persisted state:** the directory promotes a null instance id as the row leaves persistence — `runtime.providerInstanceId ?? defaultInstanceIdForDriver(provider)`, and that fallback is total `[V: apps/server/src/provider/Layers/ProviderSessionDirectory.ts:74; X: 488 live rows, 0 null]` — so the middle case survives only as a defensive throw. Only the adapter call itself is transient |
| `listSessions`                    | `Effect<ReadonlyArray<ProviderSession>>` on the service shape `[V: ibid. Services:102, Layers:1379]`. Absence precedes death on every ordinary stop, so it is evidence only where a session is known to have opened, and it is not exposed on ws, HTTP or any RPC. **It is not defect-free:** it reads each thread's persisted binding and `Effect.die`s on a provider or instance-id disagreement, plus a bare `throw` on a binding with no `providerInstanceId` `[V: apps/server/src/provider/Layers/ProviderService.ts:1079-1135, :202]`. Its `never` error channel hides this — a defect is not rescued by an error-channel catch, and it kills the fiber for the rest of the boot `[X: a spaced loop stopped at tick 3 of 26]`                                                                                                |
| `revokeActiveMcpThread`           | `Effect<void>`, idempotent `[V: apps/server/src/mcp/McpSessionRegistry.ts:184-187, :241-242]`, reversible — any later `startSession` re-mints `[V: ibid. :225-232]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| MCP identity                      | `threadId` bound at mint `[V: ibid. :126-133]`, resolved by token hash `[V: ibid. :152-166]`, absent from every tool schema `[X: 0 hits in mcp/toolkits/, control `Schema` = 7]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| MCP tool errors                   | A refusal reaches the agent as its own message only if it is declared in the tool's `failure:` schema **and the error class overrides `message`** — the server returns `error instanceof Error ? error.message : INTERNAL_TOOL_ERROR_MESSAGE`, and a `TaggedErrorClass` without the override yields `""` `[V: .repos/effect-smol/…/McpServer.ts:839-843; X: two arms]`. The in-repo precedent overrides it `[V: packages/contracts/src/previewAutomation.ts:644-646]`                                                                                                                                                                                                                                                                                                                                                              |
| MCP credential expiry             | 24h liveness window, refreshed by **any MCP request** as well as by `touch` on a provider turn — `resolve()` writes `lastAliveAt` on every authenticated call, and the module's own doc comment says so at the line revision 14 cited `[V: apps/server/src/mcp/McpSessionRegistry.ts:63, :152-166]`. A crewmate that files any report keeps its own credential alive `[X: hourly MCP traffic, 48h, no provider turn → alive; control, no MCP call → expired]`                                                                                                                                                                                                                                                                                                                                                                      |
| `createWorktree`                  | Honours `input.path`, a required-nullable key on the exported `VcsCreateWorktreeInput` `[V: packages/contracts/src/git.ts:159-165; apps/server/src/vcs/GitVcsDriverCore.ts:2969-2973]`; otherwise derives `<worktreesDir>/<repo>/<branch with "/"→"-">`. It is **one** Effect with three partial-failure outcomes — the post-add `git config` step is unguarded `[X: rc=255 with both worktree and branch on disk]`                                                                                                                                                                                                                                                                                                                                                                                                                |
| `git worktree add -b`             | Creates the branch **before** validating the path `[X: collision → branch exists, rc=128; every retry rc=255]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `git worktree remove`             | Refuses any path that is not a registered worktree of that repo `[X: rc=128 even with `-f -f`, target intact]`, refuses modified/untracked trees, and **deletes every ignored file on a tree that reads clean** — `.env`, `dist/`, `node_modules/` gone at rc=0, no `--force` `[X, reproduced independently twice]`. Crew does not call it (§7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `git worktree prune`              | Repo-global, no path scoping `[V: GitVcsDriverCore.ts:3256]`. Never deletes a directory that exists `[X: 151 worktrees, 50 hand-deleted → exactly 50 entries removed]`, but de-registers any whose directory is momentarily absent, unrecoverably `[X: `worktree repair` fails]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `git config --worktree`           | **Unusable here.** rc=128 whenever a repo has more than one working tree and `extensions.worktreeConfig` is unset — every repo crew touches, by construction `[X: rc=128 on the target repo; control, a fresh single-worktree repo, rc=0]`. Enabling it writes to the shared `.git/config`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `git worktree list --porcelain`   | Reports the **resolved** path, so a string compare against a stored path is false under any symlinked prefix `[X: `/private/tmp/…`for a`/tmp/…` add]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Disk                              | `dbPath` is `<baseDir>/<userdata\|dev>/state.sqlite` and `worktreesDir` is `<baseDir>/worktrees` `[V: apps/server/src/config.ts:121, :133]` — one volume, not siblings. One crew worktree after `runSetupProgram()` is ~4.8 GB `[X]`, accruing asynchronously over minutes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| The shell stream's sequence guard | There are **two**, and the one that matters is in the caller: `shell.ts` applies `item.sequence > snapshot.snapshotSequence` **before** invoking the reducer `[V: packages/client-runtime/src/state/shell.ts:152-161]`, and `shellReducer.ts:16` repeats it. A caught-up client's cursor equals the domain head, so a sidecar frame at that value is dropped twice `[X: driving the real pipeline, a frame at the cursor yields 0 rows while the reducer called directly accepts it]`. Crew does not use this stream (§3)                                                                                                                                                                                                                                                                                                          |
| The one-shot RPC precedent        | `useResourceQueue` — a unary RPC read by a visibility-gated poll at 60s idle / 5s open, with last-snapshot latching `[V: apps/web/src/hooks/useResourceQueue.ts:10, :12]`. Its entire client-runtime surface is 23 lines `[X: wc -l]`, it is a generic factory `createEnvironmentRpcQueryAtomFamily` `[V: packages/client-runtime/src/state/runtime.ts:635]`, a second feature already copied it `[V: subagentBackend.ts:10]`, and it contains no sequence logic at all `[X: 0 occurrences of `sequence`; control, shellReducer.ts = 5]`                                                                                                                                                                                                                                                                                           |
| `IsoDateTime`                     | `Schema.String`, millisecond `[V: packages/contracts/src/baseSchemas.ts:56]`. 200 back-to-back writes → 1 distinct value `[X]`. Every timestamp on `latestTurn` is the **client's** clock `[V: packages/client-runtime/src/operations/commands.ts:72-82 → decider.ts:1051 → ProjectionPipeline.ts:1304, :1430]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Turn settling                     | The projector settles a turn on **any** exit from `running` and writes `completedAt` unconditionally — `error`, `interrupted` and `stopped` included `[V: apps/server/src/orchestration/Layers/ProjectionPipeline.ts:1325-1344]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Boot reconciliation               | Rewrites to `stopped` only sessions in `{idle, starting, running, ready}`; `error` and `interrupted` survive a restart unchanged `[V: apps/server/src/orchestration/BootTurnReconciler.ts:43-48, :63-90]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Completion notifications          | **Three** emitters, two server-side and both reaching a phone with the screen off: `apps/web/src/hooks/useThreadCompletionNotifications.ts`, `apps/server/src/push/WebPushRelay.ts`, `apps/server/src/relay/AgentAwarenessRelay.ts`. None has a per-thread predicate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Migrations                        | 49 entries, ids 1-33 and 35-50; the migrator runs only ids **above** the applied maximum `[V: apps/server/src/persistence/Migrations.ts:121-172, :176-200]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Provider authority                | `bypassPermissions` `[V: ClaudeAdapter.ts:4863]`, plus Bash, ambient `gh`, and direct `state.sqlite` write access `[X]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| OpenCode MCP                      | `mcp.add` is skipped only when the server is **external**, and `external` is true only when `openCodeSettings.serverUrl` is non-empty, which defaults to `""` `[V: apps/server/src/provider/opencodeRuntime.ts:788-793; packages/contracts/src/settings.ts:737-738; OpenCodeAdapter.ts:2420-2434]`. A default-configured OpenCode crewmate **can** reach MCP                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 2. Goals and non-goals

**Goals.** One bridge thread. Worktree isolation against _collision_. No turn per
`progress` report. Restart loses no report **row** — the row survives; a `progress`
note already queued into a session does not (cost 4). Concurrency bounded by a slot the
system can always release.

**Non-goals.** Retention and purge. Hierarchy. `pr` mode and landing. Mobile. Any
security boundary between a crewmate and the host (§8).

**Five costs, stated up front.**

1. **The cap bounds provider sessions, not processes.** A crewmate has Bash; its
   children outlive teardown and nothing here stops them.
2. **Nothing reclaims disk.** ~4.8 GB per dispatch on `state.sqlite`'s own volume.
   §7 bounds new dispatches with a refusal; reclaiming is the operator's job, by
   hand. Crew deletes nothing, ever.
3. **Crew threads raise completion notifications on three emitters, two of them
   server-side and both reaching a phone with the screen off** (§1). A server-side
   predicate covers the two server emitters; the third runs in the browser and
   derives everything from `OrchestrationThreadShell`, which carries no crew field
   — so it needs one added in contracts (§3), not a server predicate. This is the
   loudest thing crew does at cap 4 overnight, and Phase 1 must ship both halves.
4. **A `progress` note is still lost if the session dies any way other than
   reaping.** The exemption covers the reaper, which is 74% of session stops (§4).
   Archive, settle, an explicit client stop and **every server restart** are not
   covered: `appendSessionNote` queues into an in-process Effect `Queue`
   `[V: ClaudeAdapter.ts:5305-5316]` that nothing persists, and §5 stamps `notedAt`
   on the append, so the row is never re-selected and nothing displays it. A live
   Claude session is ~500 MB RSS `[X: 4 sampled]`, which is also why the exemption
   is scoped to `open` tasks rather than held open indefinitely.
   `needs-decision`, `done` and `failed` always take a turn and are never exposed.
5. **Every delivered report occupies the bridge's context permanently.** At a
   1 KiB payload bound, 200 reports per task and cap 4, that is ~800 KiB ≈ 200k
   tokens; twenty dispatches overnight is ~1M. Nothing reclaims it — the bridge
   compacts, or the operator starts a new one.

## 3. Architecture

Sidecar service: own tables, own repository, own supervisor layer. No
`decider.ts` or `projector.ts` changes.

**Integration points.**

- `apps/server/src/persistence/Migrations.ts` + a new migration
- `apps/server/src/server.ts`, `apps/server/src/serverRuntimeStartup.ts`
- `apps/server/src/mcp/` — a crew toolkit
- `packages/contracts/src/rpc.ts` — the `crew.list` RPC and the crew error types
- `apps/server/src/ws.ts` — the RPC handler; `apps/server/src/auth/RpcAuthorization.ts` — its scope
- `packages/client-runtime/src/state/crew.ts` — a `createEnvironmentRpcQueryAtomFamily` atom
- `apps/web/src/components/Sidebar.tsx`, `LegacySidebar.tsx`, `CommandPalette.tsx` (§10)
- `apps/server/src/provider/Layers/ProviderSessionReaper.ts` — the exemption's one
  `continue` (§4)
- `apps/server/src/provider/{Services,Layers}/ProviderTurnStallWatchdog.ts` — the
  one method teardown needs (§6) — and
  `integration/orphanedProviderSessionStartup.integration.test.ts`, whose inline
  stub of the shape breaks on the new member `[X]`
- `packages/contracts/src/orchestration.ts` — a `crewRole` field on
  `OrchestrationThreadShell`, which is what the web notification hook needs (§2
  cost 3); it runs in the browser and no server-side predicate can reach it
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — **the field's
  only producer**, at its three shell-mapping sites. `crewRole` is `"bridge" | "crewmate" | "crewmate-closed" | null`, derived from
  `crew_tasks`: `bridge` for a thread parenting an `open` task, `crewmate` for a
  thread owning one, `crewmate-closed` once its task closes. **The reaper and the
  notification suppression need different scopes and a single one serves neither.**
  The reaper exempts `bridge` and `crewmate` only, so a crewmate whose teardown
  failed is still reapable (§4). The suppression matches **any** non-null value,
  because §6 closes the row at step 1 and archives the thread at step 7, and step
  5's `stopSession` sits between them — the projector settles the turn on any exit
  from `running`, so tearing down a mid-turn crewmate raises exactly the push §2
  cost 3 exists to suppress, in a window where a `status = 'open'` scope has already
  dropped the role `[X: shell found, crewRole absent]`. The layer holds a `SqlClient`, but `crew_tasks` is a sidecar table (§3), so
  the read is a correlated subquery this layer does not have today; that is the work, and it is what the 248-error alternative was measured against.
  **Spread the field in only when present** (`...(role ? { crewRole: role } : {})`),
  matching `linkedPullRequest` in the same object — emitting `crewRole: null` on
  ordinary threads turns an existing `ProjectionSnapshotQuery.test.ts` assertion red
  `[X]`. Built end to end the exemption is **5 files, 126 lines**, 0 errors in all
  five packages and 75 server tests green, with the role query at 0.0396 ms against
  0.564 ms for one of `getShellSnapshot`'s five existing queries `[X: the
  developer's own database, 505 threads, seeded with 200 crew tasks]`.
  `Migrations.ts` is on this path too, since the fill needs migration 51 before any
  snapshot runs. The field alone typechecks
  clean in all five packages and stays `undefined` on every thread, so the web
  half of cost 3 suppresses nothing and §11's notification test cannot catch it —
  a web unit test builds its own fixture and sets `crewRole` by hand `[X]`. Fill it
  from a read already in that layer's context: routing it through a new service
  costs 248 errors, or 43 across 8 test files once the layer is wired `[X]`. All
  three emitters do read this projection `[V: WebPushRelay.ts:436,
AgentAwarenessRelay.ts:408, and the client shell stream]`
- `packages/contracts/src/crew.ts`, `packages/contracts/src/index.ts`,
  `apps/server/src/crew/CrewService.ts`, `apps/server/src/server.ts`,
  `apps/server/src/server.test.ts`,
  `packages/client-runtime/package.json` (`exports`), `apps/web/src/state/crew.ts`,
  `apps/web/src/hooks/useCrew.ts` — measured, not guessed (§3)
- `apps/server/src/push/WebPushRelay.ts`, `apps/server/src/relay/AgentAwarenessRelay.ts`,
  `apps/web/src/hooks/useThreadCompletionNotifications.ts` (§2 cost 3)

### Crew rows reach the client by one unary RPC

**`crew.list` is a unary RPC, read by a `createEnvironmentRpcQueryAtomFamily`
atom on the `useResourceQueue` cadence** — 60s in the background, 5s while the
panel is open, last snapshot latched on transient failure.

**Built end to end in a scratch copy, it is ~155 lines over 12 files** `[X: zero-
error typecheck baseline in all five packages, then the full path]`: one line in
`RpcAuthorization.ts`, six in `ws.ts`, the row schema in `packages/contracts` plus
its `index.ts` export, a `CrewService` with a `list` read, its layer in `server.ts`
**and its `Layer.mock` in `server.test.ts`** (omitting that leaves the server
package at 320 errors), ~23 lines of client-runtime **plus an entry in its
`exports` map** (omitting that typechecks clean in client-runtime and fails in
web), and the web state and poll hook. Revision 14 said "two lines in `ws.ts`, one
in `RpcAuthorization.ts`, ~23 lines of client-runtime", which was the visible tip.
The comparison against the shell-stream path survives the honest number.

Both totality gates are compile-enforced, so the panel cannot silently be empty: a
missing `RpcAuthorization` entry is `TS2741` cascading to 249 errors plus a runtime
test that diffs the scope map against the RPC group, and a missing handler is
another `TS2741` `[X: inverted arms for both]`. Mobile costs nothing `[X: rc=0, 0
crew references]`.

**Revision 13 put crew rows on the shell stream and it did not work.** Three
independent defects, each reproduced:

- The reducer reorder it prescribed is **inert**. The guard that drops the frame
  is in `shell.ts`, before the reducer is called (§1) — and the unit test the
  design specified passes on the defect, because it drives the reducer directly.
- Real clients load the HTTP snapshot and then always subscribe with
  `afterSequence` `[V: shell.ts:203-246]`, whose branch returns catch-up ++ live
  with **no snapshot** `[V: ws.ts:1618-1650]`. Crew emits no domain events, so
  nothing replays crew state and a same-session resubscribe refetches nothing
  `[X: loaderCalls stays 1 across a resubscribe]`.
- `/api/orchestration/shell` has no `payload` and no `urlParams`
  `[V: packages/contracts/src/environmentHttp.ts:516-520]`, so there is no channel
  for an opt-in — and mobile decodes and persists that snapshot
  `[V: apps/mobile/src/connection/environment-cache-store.ts:27-31]`. "Mobile pays
  nothing" was false.

The RPC has none of these. It also deletes the whole `sequence` hazard class
(§1), the closed-union edits in `ws.ts`, the snapshot field, and three tests.

### Reusing the bootstrap

Crew needs what `dispatchBootstrapTurnStart` already does. It lives in
`apps/server/src/ws.ts` with one call site. **Extract and share it; do not port
it.** `origin` becomes optional — the ws caller passes a client origin, crew has
none `[V: apps/server/src/ws.ts:554-560]`.

**Crew supplies an explicit `path`**, `<worktreesDir>/crew/<taskId>`, and a
branch `crew/<taskId>`. `taskId` is a v4 uuid, so both are unique by construction
and no name resolver is needed; dispatch still asserts the resolved path stays
under `<worktreesDir>/crew/` before use.

## 4. Data model

Two tables. Migration id = the next free applied id, **51** at `01c68bb03`. Never
reuse the gap at **34**: it is below the applied high-water mark, so the migrator
silently skips it — it works on a fresh `.t3` and creates nothing on a real
database `[X]`. A taken id fails loudly instead.

### State machine

**A task holds a slot while it is `open`.**

| State    | Holds slot | Terminal |
| -------- | ---------- | -------- |
| `open`   | yes        | no       |
| `closed` | no         | yes      |

| From   | To       | Trigger             | Authority          |
| ------ | -------- | ------------------- | ------------------ |
| `open` | `closed` | `crew.teardown`     | bridge-or-operator |
| `open` | `closed` | `system.compensate` | system             |
| `open` | `closed` | `system.reapOrphan` | system (boot)      |

`system.reapOrphan` closes, at boot, every `open` row whose `crewThreadId` is
missing **or names a thread with `deletedAt !== null`** — the same
non-deliverability test §5 step 1 uses. The second half is not optional:
**thread deletion is soft.** `thread.deleted` upserts the row with `deletedAt`
set rather than removing it `[V: apps/server/src/orchestration/Layers/ProjectionPipeline.ts:879-903]`,
so a predicate keyed on non-existence matches nothing — there are **48
soft-deleted threads** on the developer's own machine, all still present `[X:
read-only]`. Keyed that way the orphan row holds its slot forever, and because
§4's reaper exemption is scoped to `open` rows, it would also keep that bridge
exempt from the reaper indefinitely. It deletes nothing (§7). The state is reachable, not
theoretical: the bootstrap crew reuses deletes the thread it created on **any**
failure `[V: apps/server/src/ws.ts:1031-1043, from the catchCause at :1226-1256]`,
so a crash between the reservation commit and compensation leaves exactly that
row, holding a slot, with the reap as its only release.

`crew_report` is an insert, not a transition.

### Derived renderings

`closed` renders as itself; `open` runs the ladder. Blocking outranks fault
outranks liveness outranks the fallback.

| #   | Renders as         | Signal   | When (status `open`)                         |
| --- | ------------------ | -------- | -------------------------------------------- |
| 1   | `blocked-on-human` | blocking | pending approvals, user input, or a plan     |
| 2   | `errored`          | fault    | session status `error`                       |
| 3   | `interrupted`      | fault    | session status `interrupted`                 |
| 4   | `working`          | liveness | session status `running` or `starting`       |
| 5   | `idle-no-report`   | liveness | session status `ready`, `idle`, or `stopped` |
| 6   | `starting`         | liveness | **no session record**                        |
| 7   | `unknown`          | fallback | unreachable — see below                      |

**The ladder is exhaustive over the real enum, and rule 7 is dead code.**
`OrchestrationSessionStatus` has exactly seven members — `idle`, `starting`,
`running`, `ready`, `interrupted`, `stopped`, `error`
`[V: packages/contracts/src/orchestration.ts:456-464]` — rules 2-5 name all seven
and rule 6 covers the absent record. Do not key any of this on
`ProviderSessionStatus`, a **different** five-member enum
(`connecting|ready|running|error|closed`) at `packages/contracts/src/provider.ts:27`
that shares **three** member names — `running`, `ready` and, the one that matters,
`error`, which would silently mis-key rule 2 `[X]`. The panel reads `OrchestrationThreadShell.session`.

Rule 6's predicate is _no session record_, covering the whole
`runSetupProgram()` window, minutes long.

**`stopped` is not a fault.** It is what boot reconciliation rewrites live
sessions to (§1), so treating it as one renders the fleet `interrupted` after
every restart. It falls to rule 5, and §5 treats it as exactly the case a wake
turn is for.

**Every rule ages against `session.updatedAt`, and only rules 2 and 3 age
truthfully.** That field is `IsoDateTime`, not nullable
`[V: packages/contracts/src/orchestration.ts:474; X: 488 of 488 live rows
non-null]`, and boot reconciliation leaves `error` and `interrupted` alone — so
for rules 2 and 3 it is the fault instant and it survives restarts `[X: a live
`error` session carrying a usable 2026-06-04 timestamp]`. Revision 14 had this
backwards: rule 5 is the untruthful one, because the reconciler stamps
`updatedAt: nowIso` on every session it rewrites to `stopped`, so a rule-5 row
that was live at the last restart shows age-since-boot `[X: 62 threads sharing one
timestamp to the millisecond]`. Rules 2 and 3 carry `session.lastError` as the
sublabel.

Every row carries its last report's `state` as a sublabel.

### `crew_tasks`

`taskId` PK (v4 uuid) · `parentThreadId` · `crewThreadId` **NOT NULL** ·
`projectId` · `baseRef` · `branch` · `worktreePath` · `provider` · `status` ·
`createdAt` · `updatedAt`

Indexes: `(parentThreadId)`, `(crewThreadId)` UNIQUE, `(status)`.

`crewThreadId`, `branch` and `worktreePath` are written in the reservation
commit, before `createWorktree` — crew knows the thread id first
`[V: apps/server/src/ws.ts:1160]`. Reserve in a short `crew_tasks`-only
transaction and **commit** before taking any other lock.

**No `createdWorktree`/`createdBranch` flags and no identity stamp.** Revision 13
carried both so §7 could delete safely. §7 deletes nothing, so they guard
nothing — and neither was implementable as written: `git config --worktree`
returns rc=128 on every repo crew touches, and the `git worktree list` probe
compares a resolved path against a stored one, which is false under any symlinked
prefix (§1).

### `crew_reports` — append-only

`reportId` PK · `taskId` · `state` (`progress`|`needs-decision`|`done`|`failed`) ·
`note` · `createdAt` · `notedAt` · `replyTo`

Index: `(taskId, createdAt)`. `rowid` cannot be an index column `[X: three engines
refuse]`; SQLite appends it to every non-unique index anyway, so this serves
`crew_status`'s per-task `ORDER BY createdAt, rowid` without a temp b-tree `[X]`.
§5's cross-task sweep sorts — measured, 400 rows at 0.001s on 20k `[X]` — and no
index changes that. Order by both columns: a millisecond string cannot order
anything alone (§1).

**One timestamp, and answers are rows.** `notedAt` = the report has been fully
handled: its text is in the transcript, or a wake turn was dispatched for it.

An answer is a `crew_reports` row with `state = 'answer'` and `replyTo` naming the
report it answers; its destination thread follows from the direction. That is one
select and one delivery loop instead of two, and it deletes `answerText`,
`answeredAt` and the whole second-direction paragraph — a separate column and
select produced a critical of its own (an answer with no terminal state, retried
60 times an hour forever). §10's `Answer` availability becomes a `NOT EXISTS` over
the same table. `crew_report` refuses `answer` as an input state (§8), and §4's
"last report's `state` as a sublabel" skips `answer` rows.

**A crew bridge is exempt from the session reaper**, which is what actually
protects a `progress` note. `appendSessionNote` puts the text in an in-process
queue `[V: ClaudeAdapter.ts:5309]` and does not touch the binding's `lastSeenAt`
`[V: ProviderService.ts:1251-1267 — no `directory.upsert`]`, so an idle bridge is
the reaper's ideal target: it stops a session after 30 minutes of inactivity,
sweeping every 5 minutes, and none of its guards can see a queued note
`[V: apps/server/src/provider/Layers/ProviderSessionReaper.ts:21-22, :54-142]`.
Measured on the developer's own event log, **the reaper is 125 of 169 session
stops in 10 days across 44 threads, and 135 of 290 all-time — 74%** `[X:
read-only]`.

The exemption is one `continue` in the reaper's guard chain, on a thread shell it
has already fetched, keyed on the `crewRole` field §3 already adds for §2 cost 3
`[X: arm A reaps the bridge, arm B does not]`. It costs two arms, not one: the reaper exempts `crewRole` of `bridge` or
`crewmate`, and **not** `crewmate-closed` (§3). A bridge is `bridge` only while it
parents an `open` task, or it would be exempt forever after its first dispatch; a
crewmate becomes `crewmate-closed` when its task closes, or a crewmate whose
teardown failed could never be reaped at all. That second scope
is what stops §6's stated residual becoming a permanent leak: after §5's three
zombie-stop attempts the reaper is the last thing that can stop a crewmate whose
`stopSession` failed, and an unscoped exemption forbids it `[X: provider process
alive past the threshold, while §12 clause 10 stays green because it asserts the
slot, not the process]`. §8's `nested`, by contrast, is computed over rows of every
status; the two scopes are deliberately different.

**Do not implement it by calling `recordTaskLiveness` to set
`backgroundLiveness`**, which is the obvious shortcut and is wrong three ways: that
registry is in-memory and empty after a restart, so it disappears at one of the
moments the loss happens; `isAutoSettlementCandidate` returns false while it is
set `[V: ThreadSettlementPolicy.ts:98]`, so the bridge never auto-settles; and it
changes `WebPushRelay`'s category filter `[V: WebPushRelay.ts:474]`. A `crewRole`
read is persisted, survives restart, and has none of those effects.

**Revision 15 tried to _display_ this loss instead, and could not.** A
`notedWithoutTurn` boolean grew a companion turn id and a sixth sweep step and
still reported a false read on the one path it existed for: turn identity cannot
tell "the bridge drained the queue" from "the session died and a new session took
a turn" — both yield a new `turnId` in state `completed` `[X: defect and control
arms end identically at unread=0, one having read the note and one not]`. The
column, its companion and the step are all gone.

**There is no `deliveredAt`.** Revision 13 had one, and it needed a third column
and a turn-identity comparison to be even approximately correct — because
`completedAt` is written on any exit from `running` and every timestamp on
`latestTurn` is the client's clock (§1). Both problems disappear with the column.
It was display-only by its own admission, no acceptance clause read it, and on
the design's headline case — a `progress` report noted on a live Claude bridge —
nothing could ever stamp it, so the row re-selected on every sweep forever and
the panel showed it permanently unread `[X: 6 sweeps, 2 rows still selected]`.
No acceptance clause read it.

Per-task caps: **200 rows of `state != 'answer'`**, and **1 KiB per `note`** —
refused with a typed error. Answers are exempt from the count: they are the
bridge's replies, not the crewmate's output, and counting them would let a
talkative bridge exhaust the budget its crewmate needs to report `done`.

## 5. Delivery

The sweep runs every 60s; a `crew.report` nudge runs the same loop. One lock per
parent thread covers both triggers.

**Select `WHERE notedAt IS NULL ORDER BY (state = 'progress'), createdAt`** —
blocking states first, then oldest, across every task regardless of status.

Dropping the `task.status = 'open'` conjunct is what makes teardown safe without a
drain step: a report filed one tick before the row closes is still selected, and so
is one on a task closed by `system.reapOrphan`, which a drain inside
`crew_teardown` never reaches at all.

**Every row therefore needs a terminal rule, or the select never empties.** When
step 1's guard fails **for any of its three reasons** — the destination thread is
missing, deleted, or archived — stamp `notedAt` and log `crew.deliver.abandoned`,
whatever the task's status. All three terminate on the first sweep. Revision 16's draft allowed `archived` a
five-sweep grace, and §4's schema has nothing to count sweeps in — the same defect
as `notedWithoutTurn`, one revision later. The two implementable substitutes are
both wrong in a named way: an in-memory counter resets on restart, and a
`createdAt`-based window gives **zero** grace to any row older than the window when
the archive happens `[X: abandons on the very first sweep; control, a row filed one
minute before the archive, honoured]`. An unarchive that wants its reports back is
an operator action, not a five-minute race.

Naming only two of the three reasons, and conjoining on `task.status = 'closed'`,
leaves **four of six states non-terminating** — at the per-task cap, 12,000 log
lines an hour `[X: 60 sweeps, each of 3 reasons × 2 statuses]`. `closed` is the
wrong key besides: `crew_teardown` refuses anyone but the bridge, so a task whose
_bridge_ is gone can never be closed except by hand. One rule covers both
directions; the code stays in the `crew.deliver.*` family for both, because it
describes the row's fate rather than its direction. Measured, the conjunct's only value was an index seek the
query already follows with a temp b-tree sort, on an append-only table bounded at 200 non-answer rows per task, ≤400 with answers `[X: EXPLAIN QUERY PLAN, both forms]`.

This is defence in depth, not a live starvation fix. **The `[X]` that justified it
is withdrawn:** it measured a one-report-per-pass model, and the ride-along rule
below drains the whole pass at once, so the ordering term now changes no outcome
`[X: 0 of 512 scenarios; 60 of 512 with the ride-along removed]`. Keep the term so
that blocking states lead if a future change ever reintroduces a per-pass bound.

**Crew issues at most one `thread.turn.start` per _destination thread_ per pass,
unconditionally.** The destination is the bridge for a report and the crewmate for
an `answer` — §5's steps are written for a destination, not for a bridge, and the
distinction is load-bearing rather than pedantic. **A wake carries a payload only for a report the append did not place; every
other report it carries is named, not quoted**, and the destination reads them
with `crew_status`. That predicate is per report, not per pass. Revision 16 wrote
it as a count — "only a single-report wake carries a payload" — which attaches a
payload to text already in the transcript in the one cell the two rules disagree
on: a single `done` report on a live Claude bridge, where step 3 appends _and_
step 4 wakes. The bridge then reads the same report twice in one turn and cannot
tell that from two reports `[X: 8-cell matrix, 1 cell at two channels]`. Every
report the wake carries is stamped; none defers, so there is no
second-non-`progress`-report arm and no code for one.

A coalesced _payload_ does not fit: §5's bound is 1 KiB per note and §11 fixes the
prefix at 40 bytes, so one line is already 1064 bytes and every report past the
first is dropped — silently, with `notedAt` stamped, so it is never re-selected
`[X: N=2 drops 1, N=200 drops 199]`. Removing the bound instead makes the payload
unbounded: 0.81 MiB ≈ 213k tokens in a single prompt at cap 4 `[X]`, which is §2
cost 4's entire overnight budget in one turn. The nudge has neither problem, and
§5 already uses that shape wherever the note landed.

"A `progress` report never consumes the budget" would be a second dispatch, and a
second dispatch destroys the first: `replacePendingTurnStart` clears every pending
row for the thread before inserting
`[V: apps/server/src/persistence/Layers/ProjectionTurns.ts:283-286]`. On a
non-Claude bridge the `needs-decision` text exists **only** in that replaced
payload, and its `notedAt` is already stamped — silent, permanent loss of the one
report blocking a crewmate that holds a slot `[X: the decision turn replaced before
running]`. The coalesced payload obeys the same 1 KiB bound per note and is
truncated whole at 8 KiB, oldest first.

1. **Thread guard.** The bridge thread exists, is not deleted, and
   `archivedAt === null`. Fail → log `crew.deliver.deferred.thread` with which of
   the three it was, retry next sweep. This precedes everything because
   `appendSessionNote` checks none of it (§1).
2. **Turn guard, before the append, for `state !== 'progress'`.** A
   `needs-decision`, `done` or `failed` report must reach the bridge, and §1
   records that a note is read on the next turn or not at all — so appending
   before you know you can wake buys nothing. Busy, and no wake yet dispatched for this bridge in this pass → log
   `crew.deliver.deferred.busy` and defer, without appending and without
   stamping.
3. **Append.** On `true`, or on `false` for a non-`progress` report, continue. On
   `false` for a `progress` report — a non-Claude bridge, or a Claude session
   that is stopped or closed — run the turn guard now; on busy, log
   `crew.deliver.deferred.no-session` and defer, stamping nothing. The log belongs
   in the defer arm: a `false` append that then wakes is the _working_ path on
   every non-Claude bridge, and logging a refusal there means ~800 `deferred`
   lines an overnight run describing 800 successful deliveries.
4. **Wake** if the report is non-`progress`, or if step 3's append returned
   `false`; log `crew.deliver.no-turn` when it does not.
5. **Stamp `notedAt` last, and only once the work it records has succeeded** — the
   append on the no-wake path, the dispatch on the wake path, and the _already
   dispatched_ wake for a report that rode one. All three arms stamp; naming only
   the dispatch leaves the design's headline case — `progress` appended to a live
   Claude bridge, where no dispatch happens — never stamped, re-selecting and
   re-appending every 60s forever `[X: 6 appends over 6 sweeps]`, which is verbatim
   the failure that retired `deliveredAt`.

**The turn guard is crew's own:** `activeTurnId === null`, no pending approvals or
user input, and `getPendingTurnStartByThreadId(threadId)` is `None`
`[V: apps/server/src/persistence/Services/ProjectionTurns.ts:132]`.

**There is no fourth "already woken this pass" conjunct, and the `[X]` that
justified one was false.** Revisions 13-15 carried a per-sweep woken `Set` because
"no projection read can close the race — the projection has not moved within one
sweep". It has: `projectionPipeline.projectEvent` runs **inside** the append
transaction, serially, before the dispatch returns, and
`thread.turn-start-requested` writes the pending row right there
`[V: apps/server/src/orchestration/Layers/OrchestrationEngine.ts:258-267;
ProjectionPipeline.ts:1299, :1857 concurrency 1]`. So the instant a wake returns,
`getPendingTurnStartByThreadId` is `Some` and the three conjuncts above already
serialise the pass. The `Set` was redundant, and moving it out of step 2 in
revision 15 changed nothing, because the other three conjuncts block identically.

**Instead: once a wake has been dispatched for a given _destination thread_ in
this pass, the remaining rows for that same destination append and stamp without
re-evaluating the guard.** They ride the turn that is already coming.

Keyed on the bridge instead, an `answer` sorts into the same pass as a `done`
report on the same task, "rides" the turn the report just dispatched **to a
different thread**, appends `false` on any non-Claude crewmate, and is stamped
handled. The operator's answer is silently lost and the crewmate stays blocked
holding a slot `[X: crewmate never woken]` — verbatim the outcome §5 rejects the
second-dispatch design for. Without that sentence the guard is correct and
the outcome is still wrong — reports 2, 3 and 4 defer unappended, which is the
revision-14 behaviour under a different cause `[X: appends 1, not 4]`.

Do not reuse the in-repo guard's `session.status === "ready"` conjunct: it is
anti-correlated with the case a wake exists for — a `stopped` or absent session
is exactly when a turn is required `[X: unreachable in 87.5% of states]`. The
pending-turn-start check is what keeps crew from silently replacing a human's
accepted turn, since `replacePendingTurnStart` keeps one pending row per thread
`[V: apps/server/src/persistence/Layers/ProjectionTurns.ts:283]`. (Revision 15's per-sweep `Set` paragraph stood here; it and its `[X]` are
retired above.)

**Transaction boundary.** Read-and-claim in one short transaction, commit, then
append and dispatch outside it, then stamp in a second short transaction, using
`UPDATE … WHERE reportId = ? AND notedAt IS NULL` and `changes() == 1` as the
once-only token. The permit is never held across provider I/O.

**An answer is a report row travelling the other way**, so it takes the same
select and the same four steps. `crew_answer(reportId, text)` inserts a row with
`state = 'answer'` and `replyTo = reportId`; the loop guards the _crewmate's_
thread rather than the bridge's, appends, wakes, and stamps its `notedAt`. Its
defer arms log `crew.answer.deferred.<thread|busy>` — never `no-session`, which no
answer path can reach (§9).

`crew_answer` reports **queued**, not delivered — it returns on the insert — and
§8 refuses a second answer to a report that already has one. Revision 15 gave the
answer its own column and its own select, and that produced a critical of its own:
a deferred answer had no terminal state, so a torn-down crewmate left the row
matching forever, 60 selections and 60 log lines an hour `[X: one hour]`. As a
report row it is closed by the same `task.status` handling as everything else.

**The sweep also stops zombies, in a fiber of its own.** For any thread in
`listSessions()` whose row is `closed`, re-issue `stopSession` — **up to three
attempts per thread per boot, or until the thread leaves `listSessions()`** — and
log `crew.zombie.stopped`. One attempt is too few: the only mode worth retrying is the transient adapter
call. **Two** of the three persisted modes are reachable (§1) — the second being an
instance id that no longer resolves in the registry, which is not exotic: **246 of
488 live bindings name a custom instance** the operator can delete in Settings
`[X: live directory, read-only]`. Neither is transient, so the bound of three caps
log lines rather than rescuing a slot.

**Wrap `listSessions()` in `Effect.catchCause`**, log
`crew.sweep.zombie-scan-failed` **once per unbroken run of failures, and stop the
zombie fiber after three consecutive ones**. The disagreement that kills it does
not heal while the offending session lives, so an unbounded log would be 1,440
identical lines a day — the shape this fork fixed in `01c68bb03`. It is not defect-free (§1), its `never` error
channel means an ordinary catch does not rescue it, and one unguarded call takes
the delivery loop down for the rest of the boot — every report undelivered,
silently, with §12 clause 13 already satisfied by the first tick.

**There is no MCP-credential touch.** Revision 14 had the sweep refresh each open
task's credential on the strength of a §1 row that was false: liveness is
refreshed by any MCP request, not only by a provider turn (§1), so a crewmate that
files reports keeps its own credential alive. The mechanism bought nothing and
permanently disabled the only expiry bound on a `bypassPermissions` credential. A
crewmate that has made no MCP call in 24h has filed no report in 24h, which is a
case for the operator.

### Payload

Bounded to **1 KiB**: normalize newlines → bound bytes on character boundaries,
accounting for prefix cost → prefix every line. The wake turn adds a per-wake
nonce fence. **No part of this is a security boundary** — the reader is an agent
with Bash and direct DB write.

## 6. Teardown

**Write `status = 'closed'` first, then clean up.** Every step is best-effort:
each logs `crew.teardown.step-failed.<1|2|3|4|5|6|7>` and none latches. Revision 11 held the
slot on a `stopSession` error, which fails deterministically (§1), so Retry re-ran
the same call forever and the cap reached zero `[X]`.

1. `status = 'closed'`
2. `[W]` clear the stall-watchdog record for the thread
3. `revokeActiveMcpThread(threadId)`
4. `TerminalManager.close({threadId})`
5. `stopSession(threadId)` — a missing binding is **success**
6. clear `worktreePath` and `branch` from the crew thread's meta
7. archive the crewmate thread if it exists and is not already archived

**There is no drain step, because §5's select no longer excludes closed tasks.**
Revision 15 added one, and it was inert on the path teardown is actually invoked
from: `crew_teardown` is an MCP tool, so a bridge calling it is inside its own
turn and every non-`progress` report deferred on the turn guard `[X: drained 0 of
1]`. It also never covered a task closed by `system.reapOrphan`. Dropping the
status conjunct from the select (§5) handles both, and delivery moves from
synchronous-at-teardown to at most 60s later.

**Step 2 has no API and Phase 1 must add one.** `clearRecord` is a private closure
and `adoptExternalStop` is the opposite operation (§1). Add
`clearRecoveryRecord(threadId)` to the shape; §3 lists both files and the one
integration test whose inline stub breaks.

Step 2 is not optional, though revision 14 stated its cause wrongly. Teardown does
not _arm_ a resurrection — `awaitingStopForTurnId` is written in exactly two
places, the watchdog's own self-trip and `adoptExternalStop`, neither of which
crew calls `[V: ProviderTurnStallWatchdog.ts:362, :459]`. It _completes_ one the
watchdog already armed: step 5 makes `activeTurnId` null, and the resume branch
has no archival check, so a stop already pending fires against the torn-down
thread on the next 60s sweep. Measured against the real watchdog: with step 2 on,
zero resumes; with step 2 stubbed to fail, `thread.turn.start` is dispatched to a
thread that is stopped, archived, and `closed` `[X]`.

Step 6 is what stops `ensureThreadWorktree` re-creating a directory the operator
deleted (§7).

**No destructive git operation.** Steps 3-7 are individually idempotent and safe
out of order. **Step 1 runs first and step 2 precedes step 5** — the one ordering
constraint, and the pair step 2 exists for.

**One residual, stated rather than hidden.** Step 1 mutes the crewmate — §8
refuses every tool on a `closed` row — before step 5 stops it. A crewmate
mid-turn loses `crew_report` and, if step 5 fails, keeps running with its slot
already released. §5's sweep is what eventually stops it.

## 7. Cleanup and the disk bound

**Crew never deletes a file, a directory, or a branch.** Not on dispatch failure,
not at boot, not on teardown. A failed dispatch closes its row, logs
`crew.dispatch.compensate.skipped`, and leaves whatever git created for the
operator.

Revision 13 had two deletion sites behind six guards — created-flags, an identity
stamp, a readdir gate, a symlink refusal, a no-`--force` rule, a path assertion —
and round 4 measured what they were protecting. The boot reap operates only on
trees that survived a restart, i.e. trees that have run `runSetupProgram()`, and
the readdir gate refuses every one of them: on the real worktree,
`OFFENDERS: ["node_modules"] → REFUSE` `[X, with an allow-arm control on a
pre-setup tree]`. Dispatch compensation is live only in the seconds before
setup's first write, on a bare checkout worth nothing. Two of the six guards
could not be implemented at all (§4). The smallest correct design deletes the
deletion.

The guards were not wrong about the danger — `git worktree remove` destroys
`node_modules/` and a `.env` at rc=0 with no `--force` (§1). That is precisely
why crew does not call it.

**`ensureThreadWorktree` is not a third deletion site, but it is adjacent.** It
runs on every turn start and returns immediately unless the thread has **both**
`worktreePath` and `branch` set **and** that directory does not exist, in which
case it prunes repo-globally and re-creates
`[V: apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:501-537, called at :1240]`.
The prune is unscoped and can unrecoverably de-register any worktree of the
project whose directory is momentarily absent (§1). Teardown step 6 clears both
fields, which takes a `closed` crew thread off that path for good. Fixing the
prune is filed as a repo follow-up (§14).

That same code is why crew stores `worktreePath` and `branch` on the thread: a
crewmate whose directory is deleted mid-run gets it back on the next turn,
instead of every later turn failing as a bogus "session not found" against the
persisted cwd `[V: ibid., the function's own doc comment]`.

**Reclamation is teardown first, then `git worktree remove --force <path>`.**
Never `rm -rf`, and never `git worktree prune`. Plain `remove` refuses a crew tree
in its normal state — the crewmate's work is uncommitted `[X: rc=128, "contains
modified or untracked files"]` — and the natural fallback is worse than useless:
`rm -rf` on an **open** task leaves the row pointing at a missing directory, so the
crewmate's next turn runs `ensureThreadWorktree`, which prunes repo-globally and
re-creates the tree. Measured, that de-registers any peer worktree momentarily
absent, unrecoverably (`git worktree repair` fails), _and_ the disk is not
reclaimed because the tree comes back `[X: four arms]`. `remove --force` needs no
prune and touches one entry.

**Crew never deletes a branch either**, so every dispatch leaves a permanent
`crew/<taskId>` in the branch list — 201 of them after 200 dispatches, in every
branch picker `[X]`. Git itself does not degrade at that scale: `worktree list`
0.02s, `worktree add` 0.10s against a 0.07s baseline `[X: 202 worktrees]`.

**The disk bound is a refusal only, and `[W]`.** No free-space primitive exists in
the repo — zero hits for `statfs|bavail|bfree|freeSpace|diskFree`, against a
control of 7 for `worktreesDir` `[X]`; Node's `fs.statfs` is available and unused.
`crew_dispatch` refuses when free space on `worktreesDir`'s volume is below
`T3CODE_CREW_MIN_FREE_BYTES` (default 25 GiB), logging
`crew.dispatch.refused.disk` with the figure. Because the ~4.8 GB accrues
asynchronously, **re-measure after `runSetupProgram()` and tear the task down if
the bound was crossed** — that frees the slot. It does **not** free the disk;
nothing does. Revision 13 said "compensate" here, which would have called a
removal the same section's gate refuses in 100% of cases it fires. Four
concurrent dispatches each observe 25 GiB, all four install, and ~19 GB stays on
`state.sqlite`'s volume until the operator clears it.

## 8. Authority

A crewmate runs `bypassPermissions` with Bash, ambient `gh`, `t3 pair`, and
direct `state.sqlite` write access (§1). **Everything below is a control against
crew's own code and honest mistakes, not a boundary** — including the cap, which
is enforced by a table its subject can edit.

| Tool            | Inputs                                                                            | Refuses when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `crew_dispatch` | `prompt` (≤8 KiB), `baseRef?`, `provider?`                                        | caller has **any** `crew_tasks` row as a crewmate (`nested`, over rows of every status); caller's thread is not deliverable-to by §5 step 1 (missing, deleted, or archived); cap reached; provider is OpenCode; `enableAgentBrowserAccess` false; free disk below the bound                                                                                                                                                                                                                      |
| `crew_status`   | `unreadOnly?`, `limit?` (default and max **50 rows per task**, most recent first) | never; bounded output — unbounded it returns 4 × 200 × 1 KiB = 0.78 MiB, the same magnitude §5 deleted the coalesced payload for, moved one hop downstream `[X]`; scoped **per direction** — `parentThreadId = caller` returns that bridge's tasks and their reports, `crewThreadId = caller` returns the crewmate's own task and the answers addressed to it. A single `parentThreadId` scope returns nothing to a crewmate, which would make the nudge unreadable in the answer direction (§5) |
| `crew_teardown` | `taskId`                                                                          | no `open` row with `parentThreadId` = caller                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `crew_answer`   | `reportId`, `text` (≤1 KiB)                                                       | the report's task has no `open` row with `parentThreadId` = caller; an `answer` row already names this `reportId`                                                                                                                                                                                                                                                                                                                                                                                |
| `crew_report`   | `state`, `note` (≤1 KiB)                                                          | no `open` row with `crewThreadId` = caller; per-task cap reached; `state` is `answer`, which only `crew_answer` may write                                                                                                                                                                                                                                                                                                                                                                        |

**Each crew error type declares its `failure:` schema and overrides `message`.**
Declaring alone is not enough — the server reads `error.message`, and a
`TaggedErrorClass` without the override yields `""`, which is strictly worse than
the generic internal error this is avoiding: a refused crewmate learns nothing
and holds its slot (§1).

The refusal rule is **per direction**, not a blanket "missing or closed row
refuses" — a bridge has no row of its own, so a blanket rule refuses the first
dispatch and the feature cannot bootstrap. `nested` is computed over rows of
every status, or a torn-down crewmate becomes a bridge.

Enforcement is keyed on `McpInvocationContext.threadId`, server-resolved and
absent from every tool schema (§1). `projectId` is resolved from the calling
thread, never supplied `[V: apps/server/src/persistence/Migrations/005_Projections.ts:23]`
— which is why there is no cross-project refusal: there is no cross-project
input.

**No `McpCapability` gate.** It is circular — a thread becomes a bridge by calling
the tool the capability would gate — and widening `McpCapability` breaks
`requireMcpCapability`, whose error type pins `Schema.Literal("preview")` and
travels on an RPC error union `[X: tsgo, two arms]`.

**Known limitation:** crew's tools are advertised to every thread on every
provider — one global tool array, `tools/call` unfiltered (§1). A second mount at
`/mcp/crew` fixes it; Phase 2, and the reason is context-window cost.

## 9. Observability

- **Spans:** `crew.dispatch`, `crew.sweep`, `crew.deliver`, `crew.answer`,
  `crew.teardown`, `crew.tool`.
- **Warnings, one per refusal §8 or §5 actually has:**
  `crew.dispatch.refused.<cap|thread|provider|browser-access|disk|nested|payload>`,
  `crew.dispatch.compensate.skipped`,
  `crew.deliver.deferred.<thread|no-session|busy>`, `crew.deliver.no-turn`,
  `crew.deliver.abandoned`,
  `crew.answer.deferred.<thread|busy>` — not `no-session`, which no answer path can
  emit: an answer is never `progress`, so a `false` append falls through to the
  wake rather than the defer arm —
  `crew.tool.refused.<tool>.<reason>` — the one family covering every non-dispatch
  refusal in §8, since `crew_report`'s per-task cap and `crew_teardown`'s and
  `crew_answer`'s row lookups each need a code or §11's both-ways correspondence
  test fails — `crew.notification.suppressed.<web-push|agent-awareness|web>`,
  `crew.tool.invoked.<crew_dispatch|crew_status|crew_teardown|crew_answer|crew_report>`,
  `crew.teardown.step-failed.<1|2|3|4|5|6|7>`, `crew.zombie.stopped`,
  `crew.sweep.zombie-scan-failed`, `crew.reap.orphan`. `crew.deliver.no-turn` and `crew.deliver.abandoned` are delivery **outcomes**;
  every other code above names a refusal or a deferral, and the bullet header covers
  all three kinds.
  **The non-dispatch refusals are six literal codes, not a cross product.**
  `crew.tool.refused.` + `crew_teardown.no-row`, `crew_answer.no-row`,
  `crew_answer.already-answered`, `crew_report.no-row`, `crew_report.cap`,
  `crew_report.bad-state`. Enumerating `<tool>` × `<reason>` instead yields 20, of
  which §8 can produce 6 — `crew_status` refuses _never_, and no tool has all four
  reasons — so §11's correspondence test fails on 14 codes `[X]`. That is the defect
  this paragraph attributes to revision 15, at 7× the scale, introduced by the commit
  that claimed to fix it. Every remaining placeholder is expanded inline above, so §11's correspondence test
  is a set comparison rather than a reading exercise — and a 40-line cross-reference
  gate can check it in `pnpm verify` (§11). Revision 15 left three of these open and shipped
  two codes no path emits, which is the defect §9's own framing says revision 13
  had.
- **A durable crew log in its own directory. NOT BUILT IN PHASE 1 — deferred.**
  Phase 1 ships `CrewLogLive` as `Effect.logInfo` with a `crewLogCode`
  annotation, so records go wherever `serverLogger.ts` sends everything else
  (`Logger.consolePretty()` plus the tracer). There is no crew file, no crew
  directory and no crew retention sweep. The design work below stands and is
  what a Phase 2 store should be built from; it is not a description of shipped
  behaviour. §12's clauses 5 and 13 are satisfied against the server log.
  Verified isolated in both
  directions, with the shared-directory hazard reproduced as a control `[X: four
arms]`. 2 MiB × 10 gives ~12 days at a measured 1.7 MB/day `[X]`; the store's
  other two bounds (512 MiB total, 14-day age
  `[V: apps/server/src/provider/Layers/EventNdjsonLogger.ts:27-31]`) never bind at
  that size. **Note that `isProviderLogFile` is not purely prefix-scoped** — on a
  prefix miss it sniffs the first 256 bytes for a provider header
  `[V: ibid. :272-284]`, so any file carrying that header dropped into crew's
  directory joins crew's retention.
- **Spans and the crew log are different sinks.** Spans go to
  `<logsDir>/server.trace.ndjson` via `makeLocalFileTracer`
  `[V: apps/server/src/observability/Layers/Observability.ts:61-67; config.ts:137]`;
  nothing routes them into a log store. §12 asserts against the log, not spans.
- **Allowed fields, positively:** `taskId`, `threadId`, `reportId`, `state`,
  counts, durations, byte counts, reason codes. **Never** `prompt`, `note`,
  `text`, wake-payload text, or raw git stdio.
- The branch is `crew/<taskId>`, so nothing derived from a prompt reaches a path,
  the panel, or a log line.
- **No metrics** — no OTLP by default `[V: Observability.ts:77-90]`.
- Crew adds no analytics call sites, but each wake bills an existing
  `provider.turn.sent` attributed to a human `[V: ProviderService.ts:853]`.

## 10. UI

A `Crew` section: task rows with the derived rendering, the unread count and age,
and `worktreePath` / `branch` with copy affordances.

| Action            | Effect                                 | Available when                        |
| ----------------- | -------------------------------------- | ------------------------------------- |
| `Answer`          | `crew_answer` (§5)                     | an unanswered `needs-decision` exists |
| `Teardown`        | `open` → `closed` (§6)                 | `open`                                |
| `Forget worktree` | clears `worktreePath` from thread meta | `closed`                              |
| `Open thread`     | navigation                             | always                                |

**There is no `Delete worktree` action.** Crew deletes nothing (§7); reclaiming
disk is teardown then `git worktree remove --force`, by hand, by someone who can
see the tree (§7 gives the procedure and why the obvious shortcuts are worse).
`Forget worktree` is `closed`-only because on an `open` task, clearing the field
disables `ensureThreadWorktree`'s recreate while the session keeps resuming into
a cwd that is gone — every later turn fails as "session not found", the slot is
held, and no rendering explains why (§7).

`Teardown` is also a command-palette entry, because neither sidebar renders on
the Settings route. The palette has no registration API, so that is an edit to
`CommandPalette.tsx`.

**Mount in `Sidebar.tsx` first** — `legacySidebarEnabled` defaults to `false`
`[V: packages/contracts/src/settings.ts:280]`. `LegacySidebar.tsx` needs it too;
factor the panel into one shared component.

**The panel is scoped to the environment, not to the bridge thread**, so a task
whose bridge was deleted is still visible and still tearable-down. Three things
the `useResourceQueue` precedent does that crew must copy and one it must not:
mount the section **whether or not it is expanded** — the repo's sidebar sections
render the header always and rows only when expanded, and putting the poll inside
the collapsed body means no cadence, no count, no header
`[V: apps/web/src/components/Sidebar.tsx:4161-4164]`; reset the latched snapshot to
null when `environmentId` is null, or a switch shows the previous environment's
rows; and note that polling **stops entirely while the tab is hidden**
`[V: useResourceQueue.ts:29-30, :51-56]`, so "no staler than the sweep" holds only
for a foreground tab — it self-heals on focus. The one to not copy: the precedent
discards the query error because it degrades in-band. `crew.list` has no such
field, so §10 needs an explicit error state or a failing call shows a frozen panel
with no explanation.

**A `Re-run teardown` action is available on a `closed` row** whose thread is still
in a session. Without it the zombie budget (§5) is the only thing that can stop a
live `bypassPermissions` agent, and `Teardown` is `open`-only.

**Crewmate text renders plain** — no markdown, links or images, length-clamped.
The reason is not `dangerouslySetInnerHTML`: `ChatMarkdown` pairs `rehypeRaw`
with `rehypeSanitize` `[V: apps/web/src/components/ChatMarkdown.tsx:416-419]`. It
is that the sanitize schema extends `protocols` with `"file"` for `href` and
`src` `[V: ibid. :390-394]`.

### Providers

| Provider     |        Phase 1         | Note                                                                                                                                                                                                                                                                                                                  |
| ------------ | :--------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude       |       supported        | The only provider with `appendSessionNote`, so the only one where `progress` costs no turn                                                                                                                                                                                                                            |
| Codex        |       supported        | Per-thread app-server child with its own token `[V: CodexAdapter.ts:1809-1822]`                                                                                                                                                                                                                                       |
| Cursor, Grok |       supported        | Per-thread MCP, ACP auto-approve `[V: CursorAdapter.ts:617-630, GrokAdapter.ts:984-996]`                                                                                                                                                                                                                              |
| OpenCode     | **refused, for scope** | Refused because Phase 1 has not exercised it, **not** because it cannot report. §1 corrects revision 13 here: `mcp.add` is skipped only for an _external_ server, and the default config spawns a local one, so a default OpenCode crewmate can call `crew_report`. Lift the refusal when someone runs §12 against it |

A non-Claude **bridge** works: every report takes the wake turn, including
`progress` (§5 step 3).

## 11. Testing

Ordinary vitest, run by `pnpm verify`.

**Every test below is parameterised over a correct and a deliberately-defective
implementation, both in the test file, and asserts the defective arm fails.** The
defect names, in a comment, the sentence of this document it breaks. For an
enumerated bullet that is **one defect per arm, not one per bullet**.

Four rounds running, a test written from a wrong design asserted the defect and
passed. Revision 13 answered with "ships with an inverted fixture", and a
reviewer showed in one grep that the phrase appears nowhere but this document: no
mutation tooling, no coverage gate, nothing in `pnpm verify` distinguishes a test
whose fixture was deleted from one that never had it. The parameterised form is
what the gate can check.

**The defective arm asserts its own specific wrong output, positively** —
`expect(result).toBe(<the defect's value>)`. Never `it.fails`, never `.not.toBe`
with a `try/catch`: both are green when the body throws for _any_ reason,
including a fixture the author never wired, so a defect arm can satisfy the
convention and assert nothing `[X: 3 renderings × {inert defect, crashing
fixture}; only the positive form catches both]`. An arm that throws is a broken fixture, not a caught defect.

**Both arms run the same fixture, the clause names the two literal values that
must differ, and each defect arm also asserts that its precondition was
entered** — that the busy guard was consulted and refused, that the budget was
spent, that the ordering fixture filed the `needs-decision` last. Positive
assertion alone closes a fixture that throws, not one that silently never reaches
the defect's precondition: there the correct implementation arrives at the same
value by its intended path and both arms are green with nothing exercised
`[X: a busy-guard clause green in all four cells]`. If the two values do not
differ under the named fixture, the clause is not testable and must be rewritten.

**A clause whose _correct_ arm is red against §5 is a defect in §5, not in the
implementation.** Reconcile the sentence before touching the test — the amended
rule constrains the arms and does not constrain polarity, so an inverted clause
satisfies all three requirements and still points the implementer at the deleted
behaviour `[X]`.

**Suite-level invariants are exempt** — the §9 reason-code correspondence check has
no implementation to parameterise over and no "defect's value".

**Two assertion shapes are traps, and both have shipped here.** One quantified
over _outputs_ ("every rendering is reachable") gets **easier** to satisfy as the
table degrades. One asserting _absence_ ("no notification fires") is satisfied
best by the most over-broad implementation possible. Each needs its complement.

- **Migrations:** ids unique and strictly ascending, and
  `ids.every(id => LEGACY.has(id) || id > 50)` where **`LEGACY` is a literal array
  in the test file, never derived from `migrationEntries`** — derive it and the
  predicate is `every(id => true)`, which passes on the id-34 fixture `[X: two
arms]`. `LEGACY` is a `Set` built from an inline array literal — as a bare array
  the bullet does not typecheck (`Property 'has' does not exist on type
  'number[]'`) `[X: tsgo]`. Assert `LEGACY.size === 49`. **And assert the migration
  executes.**
- **`derive()`:** total, the four-tier ordering, and — the assertion that
  discriminates — **for each of the seven `OrchestrationSessionStatus` members,
  the rendering by name, plus `unknown` produced by none.** Reachability-of-every-
  rendering is the wrong quantifier; it and totality both passed on a ladder that
  dropped `stopped` into `unknown` `[X: 9 of 11 green on the defect]`.
- **Cap, enumerated** — for {crewmate crash, restart, `stopSession` error, no
  provider binding, binding with no instance id, bridge archived, bridge deleted,
  crewmate thread archived or deleted, dispatch failure after `createWorktree`,
  submodule worktree, `enableAgentBrowserAccess` off mid-flight}: assert the
  rendering, name the §10 action that frees the slot, and assert **the crew row is
  `closed` and the slot count returned to its pre-dispatch value**. Add
  `listSessions()` **only on the arms where a session is known to have opened**,
  and say which — it returns only live adapter sessions (§1 — note it _does_ read each thread's
  persisted binding on the way, which is why it can die), so elsewhere it is
  satisfied before the test runs `[X: the arm and
its own inverted fixture both green]`.
- **Delivery:** an archived bridge defers and stamps nothing; `progress` on a
  Claude bridge starts no turn, and **a second sweep selects zero rows and issues
  no second append** — "is not re-selected" phrased as an inference from `notedAt`
  is green on a select that drops the `notedAt IS NULL` conjunct and re-appends
  the same report every 60s forever `[X: 6 appends over 6 sweeps, every named
observable still holding]`;
  `progress` on a non-Claude bridge takes the wake turn; a `done` report on an
  idle bridge starts one; a bridge with a `stopped` session takes the wake turn; a
  non-`progress` report on a busy bridge **is not appended** and arrives on a
  later sweep; a pending turn-start defers; two reports for one bridge in one
  sweep start one turn; **two consecutive sweeps, each with a fresh report on the
  same idle bridge, start two turns** — a module-level woken set wakes each bridge
  once per process and then defers everything forever, and both neighbouring
  clauses are green on it `[X: 5 of 6]` — declare that set at module scope in the
  test file and reset it between tests, or a factory-local rendering escapes a
  harness that builds a fresh sweeper per sweep `[X]`; **four `done` reports in
  one sweep are all appended and start one turn**; **the report's note text
  reaches the bridge by exactly one channel** — appended-with-a-bare-nudge, or
  not-appended-with-a-payload-carrying-wake — asserted on a Claude and a
  non-Claude bridge, which is also the complement the "is not appended" absence
  assertion otherwise lacks; **a non-Claude bridge with N pending `progress` reports and one `needs-decision`
  starts one turn and delivers all N+1** (no defect arm: with the ride-along rule
  the whole pass drains at once, so the ordering term changes no outcome in 512
  scenarios — 60 with the ride-along removed, which is the control `[X]`); nudge and sweep together deliver once.
- **Answers:** `crew_answer` notes the _crewmate_ thread and starts a turn even
  when that session is `stopped`; a blocked crewmate resumes; **an answer to a
  busy crewmate is deferred, the `answer` row survives with `notedAt` null, and it
  arrives on a later sweep** — defective arm stamps `notedAt` on defer; **an `answer` row filed one tick before teardown, on a crewmate not yet archived,
  is still delivered**; **an `answer` row whose crewmate is archived is abandoned on the first sweep** —
  `notedAt` stamped, `crew.deliver.abandoned` logged, and the next sweep selects
  nothing — defective arm omitting the terminal rule; **a report
  whose destination is missing or deleted terminates on the first sweep**; **an
  `answer` and a `done` report on one task in one pass wake two different
  threads**, defective arm keying the pass on the bridge.
- **Teardown:** closes the row first; a `stopSession` error still frees the slot;
  an already-archived or deleted crewmate thread does not fail it; `worktreePath`
  is cleared; the watchdog record is cleared; **with step 2 stubbed to fail and a
  recovery record awaiting a stop, the watchdog _does_ resume the torn-down
  thread** — that arm is the defect step 2 retires, and it must go red on the
  correct implementation; revision 14 asserted the opposite, which is the
  correct-arm outcome and passes on a fixture where the hazard cannot occur
  `[X]`; **a report filed one tick before teardown is still delivered** (§5's select carries
  no status conjunct);
  the zombie stop makes at most three attempts per thread per boot.
- **No deletion:** a dispatch that fails after `createWorktree` leaves the
  directory **present**; boot reap closes rows and removes nothing; there is no
  code path from crew to worktree removal — grep the crew module for
  `/\bremoveWorktree\b/`, `/"worktree"\s*,\s*"remove"/` **and**
  `/git\s+worktree\s+remove/`, with a control symbol. The last pattern alone is
  vacuous: its only occurrences in this repo are comments and error strings, and
  the real call site spells it `["worktree","remove"]` behind
  `gitWorkflow.removeWorktree` `[X: a fixture calling `removeWorktree()` passes the
single-pattern test]`.
- **Refusals:** every row of §8's table, asserting the **agent-visible message is
  non-empty and names the reason** — a declared failure type without a `message`
  override yields `""` (§1). **And that every reason code in §9 is emitted by some
  test, and every emitted code is in §9.**
- **`crew.list`:** an old client without the RPC is unaffected; the atom refetches
  on the open-panel cadence; **a collapsed panel still polls at 60s and renders a
  count**; a failing call renders an error state rather than a frozen panel.
  Revision 14 asked for "the handler is scoped to the calling environment", which
  no implementation can fail — `environmentId` exists only client-side and the ws
  layer is built per authenticated connection `[X: 0 occurrences in ws.ts, control
`threadId` = 43]`. Scoping is by connection; there is nothing to test.
- **Notifications:** a crewmate thread settling produces no notification on each
  of the three emitters, **and a non-crew thread settling still notifies on all
  three** — without the second clause a predicate that suppresses unconditionally
  passes, and so does the obvious inverted fixture. The two server emitters are
  asserted by log line; the web hook is asserted in a web unit test by the
  notification not being raised, since it cannot reach the server's log store
  `[X: 0 `EventNdjsonLogger`references under`apps/web/src`]`.
- **Reaper exemption**, three arms: a bridge with an `open` task and a crewmate
  with an `open` task are both exempt; the same bridge once its last task is
  `closed` is reaped; a non-crew thread is always reaped. **The fixture must go
  through the real `ProjectionSnapshotQuery` shell mapping, not a hand-built
  shell** — "the exemption is absent" and "`crewRole` is never populated" are
  behaviourally identical `[X: impl1 ≡ impl3]`, and a hand-built fixture that sets
  `crewRole` itself passes on the state that loses the note.
- **Config:** `0`, `00`, ` 0` disable; `-1`, `abc`, `""` default to 4.
- **Bounds and paths:** a 1 KiB note of 4-byte emoji plus a 40-byte prefix
  truncates to ≤1024 bytes with no split code point; a 1 KiB + 1 byte note is
  refused with a message naming the bound (§8 puts that limit in its _Inputs_
  column, so "every row of §8's table" does not reach it); three reports sharing
  one `createdAt` deliver in insertion order (§1 measured 200 writes → 1 distinct
  value); a `taskId` resolving outside `<worktreesDir>/crew/` is refused before
  `createWorktree`; a dispatch that crosses the disk bound during setup ends
  `closed` with the slot returned and the directory present; `Forget worktree` is
  absent on an `open` row and present on a `closed` one.

Drive the live UI in both sidebar modes.

## 12. Phase 1 and acceptance

Dispatch a crewmate into a worktree, let it report, deliver without a turn where
possible, show a panel, tear down.

Every clause below names something an operator or a test can read. Revision 13's
list had six clauses with no observable and one describing an event §8 makes
impossible.

_Acceptance (`T3CODE_CREW_MAX_CONCURRENT_TASKS=2`):_

1. Two crewmates dispatch and report — two `crew_tasks` rows, four `crew_reports`.
2. Both `progress` reports are noted with **no turn started**: two
   `crew.deliver.no-turn` lines, the bridge's `latestTurn.turnId` unchanged, and a
   second sweep emits **no further** `crew.deliver.no-turn` line for either
   report.
3. A `needs-decision` report is **deferred while the bridge is busy** —
   `crew.deliver.deferred.busy`, `notedAt` still null — and **arrives on a later
   sweep**: a turn starts and `notedAt` is set.
4. It is answered — an `answer` row exists with `notedAt` set — and **the crewmate
   files a further `crew_report` afterwards**.
5. The bridge reads both tasks via `crew_status` — one `crew.tool.invoked.crew_status`
   line in the crew log. Not a span: §9 puts §12's assertions in the log, spans go
   to a separate sink whose ring holds ~60 minutes on the developer's own machine
   `[X: 11 files, 104 MB, 59.6-minute window]`, and an acceptance run that waits out
   a sweep deferral and a teardown outlives it.
6. A third dispatch is refused by the cap: `crew.dispatch.refused.cap`, and the
   agent-visible message is non-empty and names the cap.
7. Teardown frees a slot — the row is `closed`, the slot count returns to its
   pre-dispatch value — and a fourth dispatch succeeds.
8. Nested dispatch is refused: `crew.dispatch.refused.nested`.
9. A dispatch failing after `createWorktree` leaves no held slot, and **the
   worktree directory is still there** — `crew.dispatch.compensate.skipped`.
10. A `stopSession` failure still frees the slot: `crew.teardown.step-failed.5`
    with the row `closed`.
11. A bridge whose session is `stopped` still receives its report: the wake turn
    runs. (No rendering claim — §4's ladder renders crewmate task rows, and a
    bridge has no row of its own.)
12. With at least one push subscription registered — the relay reaches its send
    path only through a non-empty `pushRepo.list()`
    `[V: apps/server/src/push/WebPushRelay.ts:489-490]`, so a fresh environment
    would pass this vacuously — a crewmate thread settling raises
    `crew.notification.suppressed.web-push` in the crew log — and `…agent-awareness` where agent-activity publishing is
    configured, which it is not by default `[X: the secret is absent on the
developer's environment]`. The web emitter is asserted in a web unit test, not
    by a log line. A non-crew thread settling raises none.
13. One `crew.*` record reaches the crew log — in Phase 1 that is the server log,
    carrying `crew: true` and the `crewLogCode` annotation (see §9's deferral note).

## 13. Phase 2

A second MCP mount at `/mcp/crew`. Mobile. OpenCode, once someone runs §12
against it. Retention, if manual cleanup proves annoying. `pr` mode and landing.

## 14. Follow-ups outside this design

Filed at `~/reports/t3code/2026-09/2026-09-01/2026-09-01-crew-followups.md`. Both
are defects in shipped code, independent of crew: the stall watchdog's resume
branch missing `archivedAt === null`, and `ensureThreadWorktree`'s repo-global
`git worktree prune`.

## 15. Open questions

Round 5 closed the two that were here. **Rules 2 and 3 do have a timestamp** —
`session.updatedAt`, non-null on all 488 live rows, and truthful for exactly those
two rules (§4). **No identity check is needed:** with crew deleting nothing there
is no destructive operation to misdirect, and two independent guards already
refuse — `ensureThreadWorktree` early-returns when the path exists, and
`git worktree add` refuses a non-empty directory `[X: an operator's foreign
directory at the crew path survives both arms]`.

1. Alert thresholds and ownership.
2. Whether `T3CODE_CREW_MAX_CONCURRENT_TASKS` is environment-global or
   per-bridge. Phase 1 ships one bridge, so acceptance cannot distinguish; the
   design assumes global.
