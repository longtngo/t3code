# Credit spend guard — design

Revision 3. Round 1 restructured the core (the gate no longer reads a cached blocked-set); round 2
fixed a lost-interrupt defect in the replacement and deleted two modules that over-corrected.
Section 14 records what each lens changed and why each exited.

## 1. Goal and baseline

Give the server one switch, **Allow to spend credits** (default on), that when turned off stops a
provider from doing further work once one of that provider's usage windows reads 100%: running turns
on it are interrupted, new turns on it are refused, and Cursor subagent offload is withheld.

Stage 1b baseline (untouched tree, `b31d52799`):

```
control-settings-key  rc=0  packages/contracts/src/settings.ts:2
    (proves a grep of this shape reads non-zero; the absence probes below are not vacuous)
setting-key           rc=0  allowSpendingCredits in contracts: 0
credit-guard-sites    rc=0  creditGuard refs in apps/server: 0
limit-100-reaction    rc=0  server sites reacting to a 100% usage window: 0
gate --floor          rc=0  vp run: 0/14 cache hit (0%).
                            390 test files passed, 5541 tests passed, 0 failed, all 14 packages ran
```

The `gate` floor is recorded under Node **24.13.1**, which `package.json` pins, not the ambient Node
26.2.0 — see premise P10.

## 2. Scope

**Must have**

- A server-scoped `allowSpendingCredits` boolean, default `true`, editable in Settings, gated by its
  own environment capability so an older server cannot silently swallow the patch.
- With it off, a provider **instance** whose published `usageLimits` contains a window at
  `usedPercent >= 100` is _blocked_:
  - every thread holding a live session on that instance with an active turn is interrupted, with a
    visible activity entry saying why;
  - `thread.turn.start` aimed at that instance is refused **synchronously** at the WebSocket command
    boundary, so the sidebar Queue pauses with the reason instead of draining into errors;
  - the refusal is re-applied inside `ProviderCommandReactor`, so a turn start the server itself
    originates (the stall watchdog's resume) is refused too.
- With it off and the Cursor account's total usage at `>= 100%`, per-thread subagent offload resolves
  to `default`, so `~/bin/subagent-dispatch` refuses (exit 3) and `ClaudeAdapter` stops injecting the
  dispatch instruction.
- Turning the switch back on, or the window resetting below 100%, restores all of the above with no
  further user action — **including when the guard's background fiber is dead**, because the gates
  read live state rather than anything the fiber maintains.

**Not in scope (knowingly left)**

- **Per-provider granularity of the switch.** The user specified one server-scoped toggle.
- **A composer-side indicator that sends are blocked.** The refusal message carries the reason.
  Follow-up (section 13).
- **Blocking on anything other than an affirmative `usedPercent >= 100`.** A provider that reports no
  limits, reports `unavailable`, or whose probe failed is never blocked — see P1: four of six drivers
  never populate `usageLimits` at all, so "block when we cannot tell" would permanently disable Grok,
  OpenCode, Cursor-as-a-provider and Antigravity.
- **Escalating an unlanded interrupt to a hard `thread.session.stop`.** Section 12, with the measured
  gap the safety lens supplied.
- **Mobile Settings.** `apps/mobile` renders only `sidebarAutoSettleOnMerge` among server settings.
  The server enforces regardless of which client is connected. **Desktop needs no separate work: it
  wraps the web app and has no Settings fork.**
- **Deduplicating `LIVE_SESSION_STATUSES`.** It already exists twice, identical in members but with
  different rationales, in `BootTurnReconciler.ts:51` and `BackgroundTaskRecoveryWatchdog.ts:60`.
  Revision 2 proposed a shared module; the simplicity lens pointed out that a module which dedupes
  one of two copies while filing a follow-up for the other is net churn. The guard now keeps its own
  four-line set with its own comment, and consolidating all three is a follow-up (section 13).
- **Aligning the settings-search capability filter with the panel's.** The search hook filters with
  `.some()` over connected environments while the panel gates with `.every()`
  (`useAvailableSettingsSearchItems.ts:45-50` vs `SettingsPanels.tsx:2229-2233`), so under mixed
  server versions a search hit can lead to a row that is hidden. That divergence is pre-existing and
  shared with the crew and subagent rows; changing the shared filter would change their behaviour
  too. Identical for a single-environment user, which is the common case. Follow-up in section 13.

**Consumers and siblings of the mechanism (Hard Rule 12)**

The mechanism is "a provider instance is blocked from spending". Every site that can cause spend:

| Site                                                                                      | In scope                  | Why                                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ws.ts` `dispatchNormalizedCommand` — client `thread.turn.start`, **bootstrap and plain** | yes                       | the Queue's send path; needs a synchronous refusal, before `thread.create` side effects                  |
| `ProviderCommandReactor.buildSendTurnRequestForThread`                                    | yes                       | the chokepoint every `thread.turn-start-requested` passes, client or server-originated                   |
| `ProviderTurnStallWatchdog` resume                                                        | yes, via the reactor gate | it dispatches `thread.turn.start` itself                                                                 |
| `SubagentBackend.resolveThreadBackend`                                                    | yes                       | the one truth table for per-thread Cursor offload (P8)                                                   |
| Running turns already in flight                                                           | yes                       | the guard fiber interrupts them                                                                          |
| `thread.turn.interrupt` / `thread.session.stop`                                           | no                        | these end spend, never start it                                                                          |
| Title generation / `textGeneration`                                                       | **no — knowingly left**   | a single short completion on the text-gen path, not a provider turn. Named rather than silently skipped. |
| Codex-native subagents (`thread_spawn`)                                                   | no                        | they run inside a Codex turn the gates above already stop                                                |

## 3. Premises

| #   | Premise the design depends on                                                                                                                                                                                                             | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P11 | `[unsourced]` The user means "any published usage window at 100%", not a vendor-specific overage bucket.                                                                                                                                  | The ask reads "when one of the usage limit hit 100%". Section 12 records what a narrower reading would change.                                                                                                                                                                                                                                                                                                                                                                                            |
| P13 | `[unsourced]` A turn wedged inside a tool call is not billing the provider while wedged, so the cooperative interrupt's known gap costs less than it appears.                                                                             | Not verified. Section 12 treats the gap as real regardless; this premise is only a reason not to add a timer, and nothing in the design depends on it being true.                                                                                                                                                                                                                                                                                                                                         |
| P1  | Only the Claude and Codex drivers ever populate `ServerProvider.usageLimits`; Antigravity, Cursor, Grok and OpenCode never do.                                                                                                            | `for f in apps/server/src/provider/Layers/*Provider.ts; do grep -c usageLimits $f; done` → Claude 2, Codex 2, all others **0**. Independently re-run and confirmed by the pillar sweep.                                                                                                                                                                                                                                                                                                                   |
| P2  | `usedPercent` is clamped to `[0,100]`, so `>= 100` is reachable and is the top of the range.                                                                                                                                              | `apps/server/src/provider/providerUsageLimits.ts:14-16`. Correctness lens ran a table over every snapshot shape: `undefined`, `unavailable` (both reasons), empty windows, 99.999, exactly 100, mixed — all behaved as assumed.                                                                                                                                                                                                                                                                           |
| P3  | A window reaching 100% is published to in-process listeners _during_ a turn, not only on the 5-minute probe.                                                                                                                              | `ClaudeAdapter.ts:4627-4639` emits `account.rate-limits.updated`; `ProviderUsageLimitsIngestion.ts:25-37` folds it in; `makeManagedServerProvider.ts:186-205` republishes; `ProviderRegistry.streamChanges` aggregates                                                                                                                                                                                                                                                                                    |
| P4  | A `ServerSettings` field also listed in `ServerSettingsPatch` persists and reaches every client with no other plumbing, and a parity test enforces the mirror.                                                                            | `settings.ts:1658,1944`; `settings.test.ts:1092-1116`. Compat lens applied the change to a scratch copy and ran the assertions: `parity ok: true`, `DEFAULT allowSpendingCredits: true`, `decode {} → true`, `patch rejects string: true`.                                                                                                                                                                                                                                                                |
| P5  | `ServerSettingsService` exposes a live change stream.                                                                                                                                                                                     | `apps/server/src/serverSettings.ts:230`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| P6  | A failed `thread.turn.start` RPC pauses the sidebar Queue and surfaces the server's message; a reactor-side failure does **not**.                                                                                                         | `executeQueuedSend.ts:71-90`; `threadQueue.logic.ts:164-169`; `ThreadQueueCoordinator.tsx:185-214`. Simplicity lens built both arms and ran them: "ws-sync refusal pauses after first entry" / "reactor-only refusal drains every entry as sent".                                                                                                                                                                                                                                                         |
| P14 | `OrchestrationDispatchCommandError` survives the ws boundary with its message intact; only a non-tagged error is replaced by the generic text.                                                                                            | `ws.ts:811-813` `isOrchestrationDispatchCommandError(cause) ? cause : …`. Safety lens traced it end to end: "web client sees: Credit spending is disabled: …"                                                                                                                                                                                                                                                                                                                                             |
| P7  | `~/bin/subagent-dispatch` refuses with exit 3 for **any** backend other than `cursor`, including a missing or malformed state file.                                                                                                       | `~/bin/subagent-dispatch:15,31,33-36`. Two reviewers executed it: missing file → `exit 3`; `backend=default` → `exit 3`.                                                                                                                                                                                                                                                                                                                                                                                  |
| P8  | `resolveThreadBackend` is the single truth table for a thread's offload target, and both writers go through it.                                                                                                                           | `SubagentBackend.ts:339,454,514`; no other caller                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P9  | The Cursor account's total usage percentage is readable server-side, cached 60 s, and never fails (null on error).                                                                                                                        | `cursorUsageRead.ts:27,52,60-63`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| P10 | The Stage 1b Node-26 red is the environment, not the tree.                                                                                                                                                                                | Three mechanisms. (a) Real suite, both arms, same tree: Node 26 → `× does not replace terminal labels embedded in 𐐀@build:7`, 1 failed / 848; Node 24 → 68 passed (68), and the full gate 14/14 green. (b) `git diff --quiet origin/main -- packages/shared/src/composerContextLegacy*.ts` → byte-identical. (c) The regex directly: `/[\p{L}\p{N}\p{M}_@.-]$/u.test("\u{10400}")` → Node 24 `true`, Node 26 `false`, while bare `/\p{L}$/u` is `true` on both. `package.json` pins `"node": "^24.13.1"`. |
| P12 | Every thread with a live session, its provider instance and its active turn are readable from one projection query.                                                                                                                       | `ProjectionSnapshotQuery.getShellSnapshot():131`; `BootTurnReconciler.ts:50-55,76-105` already reads exactly these fields                                                                                                                                                                                                                                                                                                                                                                                 |
| P15 | The instance a turn runs on is **not** `desiredInstanceId`. With a live session and no explicitly requested selection, the reactor keeps the existing session on the _session's_ instance while `desiredInstanceId` holds the _thread's_. | `ProviderCommandReactor.ts:766-773` computes `currentInstanceId` (session→thread) and `desiredInstanceId` (requested→thread) **separately**; `:988-991` early-returns keeping the existing session. Found by the correctness lens, re-read and confirmed against source.                                                                                                                                                                                                                                  |
| P16 | Post-`ensureSessionForThread`, the exact bound instance is available as `activeSession.providerInstanceId`, and `ProviderService.sendTurn` routes on that same binding.                                                                   | `ProviderCommandReactor.ts:1074-1085` reads it; `ProviderService.ts:1363-1372` routes via `directory.getBinding(threadId)`                                                                                                                                                                                                                                                                                                                                                                                |
| P17 | A new server setting without an environment capability flag fails **silently** against an older server: the patch decodes to `{}`, the toggle appears to work, and the change is dropped.                                                 | Compat lens ran an old-schema decode of a new patch: `{} … key accepted`, no error. Precedent gates exist for exactly this: `environment.ts:154-165`, `SettingsPanels.tsx:2229-2233`, `settingsSearch.test.ts:224-230`.                                                                                                                                                                                                                                                                                   |

## 4. Approach

### Current → proposed

|                        | Today                                                                                                                                                                                 | Proposed                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Window hits 100%       | nothing server-side reacts (baseline `limit-100-reaction` = 0). Claude's own `rate_limit_event` fails the turn **unless overage is allowed**, in which case it keeps going and bills. | if `allowSpendingCredits` is off: interrupt live turns on that instance, refuse new ones, withhold Cursor offload |
| Queue with a limit hit | drains, every entry erroring in turn (measured, P6)                                                                                                                                   | first entry is refused synchronously, queue pauses with the reason, rest untouched                                |
| Cursor subagents       | dispatched whatever the Cursor balance                                                                                                                                                | flag file resolves to `default`; wrapper exits 3 and no instruction is injected                                   |

### The central decision: the gate reads live state, never a cache

Revision 1 had the gates consult a `Ref<Map<instanceId, reason>>` maintained by a background fiber.
Two lenses independently broke it, and the prototypes agreed: a cached blocked-set has three
fail-**open** holes — a transient settings-read error cleared it, an empty set during a settings
outage admitted spend, and a dead fiber froze it empty forever. All three are the unsafe direction
for a feature whose entire purpose is not spending money.

So there is no gate-facing cache. `blockedReason` is a pure function of two in-memory reads that are
already on every hot path anyway (`serverSettings.getSettings`, `providerRegistry.getProviders`),
with no network and no disk:

```
creditSpendBlockedReason(settings, providers, instanceId) -> string | null
    if settings.allowSpendingCredits !== false: return null        # checked FIRST
    provider := providers.find(p => p.instanceId === instanceId)
    if provider is undefined: return null                          # unknown instance is not our refusal to make
    windows := exhaustedUsageWindows(provider.usageLimits)         # [] for undefined / unavailable / empty
    if windows is empty: return null
    return "<displayName> is at 100% of <window labels> and \"Allow to spend credits\" is off. …"
```

Checking the toggle first is what makes turning the switch back on work instantly and
unconditionally, whatever else is broken.

The background fiber survives, but only for **side effects it alone can do**: interrupting turns that
are already running, and rewriting Cursor flag files. A stale memo there causes at worst a missed or
repeated interrupt — never admitted spend.

### Components

**A. `ServerSettings.allowSpendingCredits: boolean` (default `true`)** — `packages/contracts/src/settings.ts`,
mirrored in `ServerSettingsPatch`. _Reuse check:_ `subagentBackendEnabled` sits two lines away as the
exact analogue; this copies its `withDecodingDefault` + `catchDecoding` containment, so an undecodable
value reads as the default `true`.

**A2. Environment capability `allowSpendingCredits`** — `packages/contracts/src/environment.ts`,
advertised `true` in `ServerEnvironment.ts`, and required by the Settings row and the settings-search
entry. Without it, P17: the toggle silently no-ops against an older server. Its own flag, not a reuse
of the subagent flags — orthogonal feature.

**B. `exhaustedUsageWindows(limits)` — `packages/shared/src/usageLimits.ts`.** Pure; returns the
windows at `usedPercent >= 100`, empty for `undefined` limits and for any `unavailable` snapshot.
_Reuse check:_ (1) framework/vendored — nothing; (2) project — this file already owns every pure
window predicate (`remainingPercent:406`, `paceOf:432`, `limitsNotice:395`), so it is the house
location, and those neighbours take a `ServerProviderUsageWindow` and return a plain value, which
this matches; (3) own diff — nothing. `git grep -in "atLimit|isExhausted"` over `packages/shared/src`
and `apps/server/src` returns only unrelated scan-budget code.

**C. `apps/server/src/provider/creditSpendGuard.ts`** — pure, no service, no Context tag:
`creditSpendBlockedReason(...)` above and `cursorOffloadBlockedReason(settings, cursorUsedPercent)`.
_Reuse check:_ no existing spend/credit/budget guard anywhere
(`git grep -iln "spendGuard|creditGuard|usageGuard|budgetGuard"` → empty).

**D. The ws gate's instance resolution — inlined, not a module.** `requested ?? live session's
instance ?? thread's`. This is a **new** rule, not an extraction: P15 showed the existing code
computes two different values and neither is this. Revision 2 gave it its own file; it has exactly
one caller (the reactor uses something exact, component F below), so it is five lines above the gate in
`ws.ts` instead:

```
instanceId := command.modelSelection?.instanceId
           ?? shell?.session?.providerInstanceId
           ?? shell?.modelSelection.instanceId
```

**E. `apps/server/src/provider/Layers/CreditSpendGuardLive.ts`** — `Layer.effectDiscard` forking one
fiber, modelled line for line on `ProviderUsageLimitsIngestionLive` (44 lines, no `Services/` file,
`Stream.runForEach` + `Effect.forkScoped` + `ignoreCause({log:true})` per item). Input:
`Stream.merge(providerRegistry.streamChanges, serverSettings.streamChanges)` — the correctness lens
built this merge on the pinned Effect build and confirmed both sides deliver and neither starves the
other. Per tick:

```
settings  := serverSettings.getSettings    ?? on error: log tick-failed{stage}, SKIP the tick
providers := providerRegistry.getProviders ?? on error: log tick-failed{stage}, SKIP the tick
    # skipping leaves prevBlocked and interruptPending untouched. It cannot admit spend:
    # the gates never read either of them.

nextBlocked   := { p.instanceId -> reason | p in providers,
                   creditSpendBlockedReason(settings, providers, p.instanceId) is non-null }
blockedNow    := keys(nextBlocked)
becameBlocked := blockedNow \ keys(prevBlocked)
prevBlocked   := nextBlocked

# Anything we owed an interrupt sweep but never delivered, retried while it is still blocked.
interruptPending := interruptPending ∩ blockedNow        # an instance that unblocked is no longer owed
toSweep          := becameBlocked ∪ interruptPending

if toSweep non-empty:
    shells := projection.getShellSnapshot()
        on error: interruptPending := toSweep            # keep the debt; retry next tick
                  log interrupt-skipped { instances: toSweep }
                  goto cursor step
    failed := {}
    for shell where session.providerInstanceId in toSweep
                 and session.status in LIVE_SESSION_STATUSES
                 and session.activeTurnId != null:
        key := threadId + ":" + session.activeTurnId
        if key not in announced:                       # once per turn, not once per retry tick
            engine.dispatch(thread.activity.append  "Credit limit reached - turn interrupted")
                on error: log, continue to the interrupt anyway
            announced := announced ∪ { key }
        engine.dispatch(thread.turn.interrupt { threadId, turnId: session.activeTurnId })
            on error: log; failed := failed ∪ { session.providerInstanceId }
    interruptPending := failed
    announced := announced ∩ { threadId + ":" + activeTurnId | shell in shells, activeTurnId != null }

cursorPct     := readCursorUsage()?.usedPercent ?? null   # cached 60 s, never fails
nextCursorBlk := cursorOffloadBlockedReason(settings, cursorPct) is non-null
if nextCursorBlk != prevCursorBlk:
    prevCursorBlk := nextCursorBlk
    reconcileAllBackends()    # rewrites every thread flag file, under the existing single permit
```

`announced` is what round 3 added. The retry loop re-sweeps every thread on a still-owed instance, so
a thread whose interrupt already landed could collect a fresh "Credit limit reached" timeline line on
every tick until its neighbour's dispatch succeeded — the safety lens reproduced it
(`interrupt keeps failing → append every tick until success`). Keying on `threadId:turnId` means the
line is written once per interrupted turn. The duplicate _interrupt_ needs no such guard: the reactor
consults the live session and no-ops when the turn is already gone
(`ProviderCommandReactor.ts:1856-1877`), verified by reading it.

`interruptPending` is what round 2 added. Revision 2 assigned `prevBlocked := nextBlocked` before the
projection read, so a read failure on the tick that _first_ saw an instance cross 100% meant the
instance never re-entered `becameBlocked` and its running turn was **never** interrupted — the safety
lens reproduced it (`tick1 projection-fail + tick2 skip → tick3 does NOT re-interrupt A`). The debt
set makes the sweep retry until it lands or the instance unblocks. It is still only a side-effect
memo: the gates read neither it nor `prevBlocked`, so no staleness here can admit spend (I9).

The activity append before the interrupt makes a guard stop distinguishable from the user's own Stop
press, which dispatches the same bare `thread.turn.interrupt`. The append is attempted first because
a turn that stops with no explanation is the worse outcome; if the append fails the interrupt is
still dispatched. The nearest precedent is `ProviderTurnStallWatchdog.ts:356-369`, which appends an
activity and then dispatches — though note it dispatches `thread.session.stop`, not an interrupt, so
this design follows its _shape_ while taking the gentler action. `BootTurnReconciler.ts:99-106`
dispatches a bare interrupt with no activity; that is boot-time cleanup with nobody watching, which
is why it is not the model here.

**F. Two turn-start gates.** Both call `creditSpendBlockedReason`; neither reimplements it.

- **`ws.ts`, at the top of `dispatchNormalizedCommand`, before the `bootstrap ? … : …` branch**, so a
  bootstrap turn is refused _before_ `thread.create`, the worktree, and the setup script. For a
  bootstrap the thread shell does not exist yet, so the instance comes from
  `command.modelSelection?.instanceId ?? bootstrap.createThread.modelSelection.instanceId`; otherwise
  from the component D expression. On a non-null reason: fail with
  `new OrchestrationDispatchCommandError({ message: reason })` — P14 says the message survives, P6
  says the Queue then pauses with it.
  One side effect does precede this gate: `normalizeDispatchCommand` (`ws.ts:1516`) claims pending
  attachment uploads to disk (`Normalizer.ts:265,328`). That is accepted rather than designed around,
  because `ws.ts:1543-1544` already wraps the dispatch in
  `Effect.tapError(() => cleanupFailedUploadedAttachments(...))`, so a refusal rolls the claim back
  with no new code. Verified by reading both sites.
- **`ProviderCommandReactor.buildSendTurnRequestForThread`, after `ensureSessionForThread`**, using
  `activeSession.providerInstanceId` — the exact instance `sendTurn` will route to (P16), already
  read at `:1074-1085`. Fails with `ProviderAdapterRequestError`, the type all eleven sibling
  refusals there use (`:719-868`), which routes to `provider.turn.start.failed` + `session.lastError`.

The ws gate is deliberately **best-effort** and the reactor gate is **authoritative**. The component D
rule is right whenever the session is kept or a selection is requested. It differs from the reactor's
binding whenever a session restarts _and_ the live session's instance differs from the thread
default — the restart routes to the thread's instance instead. The correctness lens enumerated all
six restart triggers (`ProviderCommandReactor.ts:938,939,962-966,972-980`): `runtimeModeChanged`,
`cwdChanged`, `membersChanged`, `shouldRestartForModelChange` and
`shouldRestartForModelSelectionChange` all diverge; `instanceChanged` does not, because it requires an
explicit requested selection that the ws gate also sees. It then asserted the direction of every one:
**no divergence is in the unsafe direction** — the ws gate either over-refuses, or the reactor
refuses after the restart. Nothing reaches the provider on a blocked instance.

**G. `resolveThreadBackend` gains `creditsBlockedReason: string | null`.** When non-null it returns
`{ ...OFF, degraded: reason }` — the same shape and position as the existing
`settings.subagentBackendEnabled === false` branch (`SubagentBackend.ts:345-347`), so the sidebar
panel's existing `degraded` rendering explains it with no UI change. The two callers (P8) supply it.
Keeping the read in the callers keeps the truth table a pure function of its inputs, testable without
stubbing a network call.

**H. Web Settings row** — General panel, beside the subagent-offload row (`:2787-2813`):
`SettingsRow serverScoped` + `Switch` + per-row reset, gated on the A2 capability, label
**"Allow to spend credits"**. The description must say the switch **only affects providers that
report usage limits** — P1 means four of six drivers are never blocked, and a switch that silently
does nothing for them is worse than one that says so.

### Files touched

`packages/contracts/src/settings.ts` · `packages/contracts/src/settings.test.ts` ·
`packages/contracts/src/environment.ts` · `packages/shared/src/usageLimits.ts` ·
`packages/shared/src/usageLimits.test.ts` ·
`apps/server/src/provider/creditSpendGuard.ts` (new, pure) ·
`apps/server/src/provider/Layers/CreditSpendGuardLive.ts` (new) ·
`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` ·
`apps/server/src/subagentBackend/SubagentBackend.ts` · `apps/server/src/ws.ts` ·
`apps/server/src/server.ts` · `apps/server/src/environment/ServerEnvironment.ts` (+ its test) ·
`apps/web/src/components/settings/SettingsPanels.tsx` ·
`apps/web/src/components/settings/settingsSearch.ts` (+ its test) ·
`apps/web/src/components/settings/useAvailableSettingsSearchItems.ts` · `docs/user/usage.md`

Confirmed **not** needed (compat lens, by inspection): `PERSISTED_SERVER_SETTINGS_DEFAULTS`
(`serverSettings.ts:412-413` spreads the defaults), `redactServerSettingsForClient`
(`:168-190` spreads through), `SHARED_SERVER_SETTING_KEYS`, `PROJECT_SCOPED_SERVER_SETTING_KEYS`,
`packages/shared/src/serverSettings.ts` (a plain boolean needs no special merge).

## 5. Alternatives

| Alternative                                                             | Why rejected                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Do nothing / smaller change: gate only in `ProviderCommandReactor`.** | Measured, not argued: the simplicity lens built both arms — "reactor-only refusal drains every entry as sent". The RPC succeeds, so `executeQueuedSend` never sees a failure and the Queue erases itself one error at a time. That is the case the ask singles out.                                              |
| **Gate only in `ws.ts`.**                                               | Misses every server-originated turn start: `ProviderTurnStallWatchdog.ts:191-208` dispatches `thread.turn.start` itself after a stall — precisely a long, expensive turn.                                                                                                                                        |
| **A `Ref` cache of blocked instances, read by the gates** (revision 1). | Three fail-open holes, all reproduced: settings-read error cleared the map; an empty map during a settings outage admitted spend; a dead fiber froze it empty forever. Live reads are two in-memory lookups over ~6 providers; the cache bought nothing measurable and cost the property the feature exists for. |
| **Gate in the decider (`decider.ts`).**                                 | The decider is a pure function of command + read model (`:202`); usage limits are live external state in a provider `Ref`. Feeding them in makes every command's determinism depend on a probe.                                                                                                                  |
| **Block on the client, in `queuedSend.ts`'s refusal ladder.**           | The ask is explicitly server-scoped, and a client check is bypassed by every other client and by the watchdog. Worth adding later as _additional_ pre-flight polish (section 13), never as the enforcement.                                                                                                      |
| **Key the block on driver kind rather than provider instance.**         | Limits are per instance (`makeManagedServerProvider`'s per-instance `snapshotStateRef`); two Claude instances are two accounts. Blocking by driver would stop a second, unexhausted account.                                                                                                                     |
| **Gate the reactor on `desiredInstanceId`.**                            | P15: that is the _thread's_ instance, not the one a kept session runs on. It would check the wrong account in the common case.                                                                                                                                                                                   |
| **Hard-stop (`thread.session.stop`) instead of interrupt.**             | Section 12.                                                                                                                                                                                                                                                                                                      |
| **Block whenever usage cannot be read** (fail-closed).                  | P1: four of six drivers never report limits; this permanently disables most of the product. Absence of a reading is not a reading of 100%.                                                                                                                                                                       |

## 6. Experiments and cost

N/A as a between-designs experiment: the decisions were settled by reading live code and by reviewer
prototypes that built and ran both arms (recorded inline in sections 3 and 5), plus one two-arm probe
for P10.

Costs the pillar sweep asked to be named, since there was no performance section:

- `creditSpendBlockedReason` at each gate: two in-memory reads plus a linear scan of ~6 providers. No
  I/O. Runs once per `thread.turn.start`, which is human-paced.
- `getShellSnapshot()` on a **newly-blocked transition only**, not every tick: O(threads).
- `reconcileAllBackends()` on a **Cursor block edge only**: O(threads) small file writes, under the
  existing single permit.
- `readCursorUsage()` once per tick, behind its own 60 s cache.

## 7. Invariants

| #   | Property                                                                                                                                                                                 | Check that FAILS if it breaks                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | **Never** refuse a turn while `allowSpendingCredits` is `true`, whatever the windows read.                                                                                               | Test: windows at 100%, setting `true` → `creditSpendBlockedReason` is `null`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| I2  | **Never** refuse a turn on an instance whose published limits contain no window at `>= 100`, including `undefined` limits, `unavailable` (both reasons), and an empty `windows` array.   | Table test over all shapes with the setting `false` → `null` for each. Already prototyped green by the correctness lens.                                                                                                                                                                                                                                                                                                                                                         |
| I3  | ~~Ref written before interrupts~~ **Retired in revision 2** — there is no gate-facing Ref to order against. Replaced by I9.                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| I9  | **Never** let the gate depend on the guard fiber: with the fiber never started, the gate still refuses a blocked instance and still allows when the toggle is on.                        | Test: call the gate with no `CreditSpendGuardLive` in the layer stack at all. Reintroducing a cached read turns it red.                                                                                                                                                                                                                                                                                                                                                          |
| I4  | **Eventually** — within one tick of the toggle flipping — an already-exhausted instance's running turns are interrupted, without waiting for the next 5-minute probe.                    | Test driven from `serverSettings.streamChanges` only, no provider event: flip to `false`, await the tick, assert one interrupt.                                                                                                                                                                                                                                                                                                                                                  |
| I5  | **Eventually** — when the window falls below 100% or the toggle returns to `true` — the instance is unblocked and Cursor flag files are rewritten.                                       | Test: block, then unblock; assert the gate returns `null` **and** `reconcileAllBackends` ran a second time. The correctness lens confirmed a 100→99 update does republish and a 100→100 no-op does not.                                                                                                                                                                                                                                                                          |
| I6  | **Never** let a blocked Cursor account keep offloading: while blocked, `resolveThreadBackend` returns `backend: "default"` for every thread, whatever `subagentBackendThreadModes` says. | Test: thread mode `"on"`, global backend `cursor`, `creditsBlockedReason` non-null → `default`, reason in `degraded`. Removing the branch turns it red.                                                                                                                                                                                                                                                                                                                          |
| I7  | **Never** interrupt a thread on an instance that is not newly blocked, and never one with no active turn.                                                                                | **Multi-unit** test: three threads — one on the blocked instance mid-turn, one on the blocked instance idle, one on a _second_ instance mid-turn — assert exactly one interrupt, for the first.                                                                                                                                                                                                                                                                                  |
| I8  | **Never** let one bad tick end the guard fiber, and never let a failed tick change the blocked memo.                                                                                     | Test: first tick's settings read fails, assert `prevBlocked` unchanged and the second tick still processes.                                                                                                                                                                                                                                                                                                                                                                      |
| I10 | **Never** let a bootstrap `thread.turn.start` create a thread, worktree, or setup-script run when the instance is blocked.                                                               | Test: blocked instance + `bootstrap.createThread` → the RPC fails and no `thread.create` event was dispatched. Moving the gate below the bootstrap branch turns it red.                                                                                                                                                                                                                                                                                                          |
| I11 | **Never** ship the Settings row without its capability: against a server that does not advertise `allowSpendingCredits`, the row is absent.                                              | `settingsSearch.test.ts` parallel to the existing crew/subagent silent-failure gate at `:224-230`, **plus** an explicit `expect(capabilities.allowSpendingCredits).toBe(true)` in `ServerEnvironment.test.ts`. The second is not redundant: the compat lens checked, and that test asserts a _subset_ of capabilities (`:165-181`) — `crew` is not asserted at all — so adding the schema field and forgetting to advertise it would pass today. "+ its test" was doing no work. |
| I12 | **Eventually** — an instance that became blocked has its running turns interrupted, even if the tick that first saw it could not read the projection.                                    | Test: tick 1 blocks A and its `getShellSnapshot` fails; tick 2 succeeds → assert the interrupt is dispatched on tick 2. Deleting `interruptPending` turns it red — the safety lens wrote this test and ran both arms (`useInterruptPending: false` → 0 interrupts on tick 2).                                                                                                                                                                                                    |
| I13 | **Never** write more than one "Credit limit reached" activity entry per interrupted turn, however many retry ticks the instance's debt survives.                                         | **Multi-unit** test: two threads on one blocked instance, thread 1's interrupt dispatch fails every tick, run three ticks → assert thread 2 has exactly one activity entry and thread 1 has exactly one. Removing the `announced` guard turns it red.                                                                                                                                                                                                                            |

## 8. Shared resources

| Resource                                                                         | Atomic unit                                                                                | Other writers and their order                                                                                                                                                                                                                              | Crash between writes → result                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-thread subagent flag files (`ServerConfig.subagentThreadsDir/<thread>.json`) | one `writeFileStringAtomically` per file, all under `backendWriteSemaphore.withPermits(1)` | `reconcileThreadBackendsBody` (`SubagentBackend.ts:430-461`) and `writeThreadBackendForSession` (`:504-540`), pre- and post-`startSession`. This design adds **no new writer**: it calls the existing `reconcileAllBackends`, which takes the same permit. | Crash mid-batch leaves some files on the old value. The next `reconcileAllBackends` or session start rewrites them; a stale _enabling_ file is the only unsafe direction, bounded by the wrapper's own re-read at dispatch. |
| `ServerSettings` `settings.json`                                                 | `writeSettingsAtomically` (`serverSettings.ts:1017-1036`)                                  | only `ServerSettingsService.updateSettings` and `t3 theme set`. This design **never writes settings**.                                                                                                                                                     | n/a, read-only                                                                                                                                                                                                              |
| Provider instance snapshot `Ref`                                                 | `Ref.modify` in `makeManagedServerProvider:186-205`                                        | probe refresh and `applyUsageLimits`. This design **only reads**, via `providerRegistry.getProviders`.                                                                                                                                                     | n/a, read-only                                                                                                                                                                                                              |

This design writes exactly one shared resource, through its existing single-permit entry point, so no
pair is written in both orders.

## 9. Failure behaviour

| Failure                                                        | Behaviour                                                                                                                                                                                                                                                                                    | Operator sees / hears                                                        | Overriding intent                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| Settings read fails **at a gate**                              | fail **open** (allow) and log `credit-spend-guard.gate-unavailable`. _Alternative rejected:_ fail closed, which refuses every turn on this environment over a read that is an in-memory cache hit after startup; a server that cannot read its settings has already failed louder elsewhere. | nothing; existing behaviour continues                                        | —                                          |
| `getProviders` read fails **at a gate**                        | fail **open**, same as the settings read, and log `credit-spend-guard.gate-unavailable`.                                                                                                                                                                                                     | nothing                                                                      | —                                          |
| Settings or `getProviders` read fails **in the fiber tick**    | **skip the whole tick**, leaving `prevBlocked` and `interruptPending` untouched; log `credit-spend-guard.tick-failed { stage, cause }`. Cannot admit spend: the gates read neither.                                                                                                          | running turns continue one tick longer                                       | Stop button                                |
| Projection read fails while dispatching interrupts             | the instances owed a sweep go into `interruptPending` and are retried every tick until they land or unblock; log `credit-spend-guard.interrupt-skipped`. Without this the turn would **never** be interrupted (I12).                                                                         | running turns continue until the next successful tick                        | Stop button                                |
| `engine.dispatch(interrupt)` fails for one thread              | logged; that thread's instance stays in `interruptPending` for a retry; remaining threads still interrupted                                                                                                                                                                                  | that one thread keeps running for a tick                                     | Stop button                                |
| Activity append succeeds, interrupt fails                      | the timeline says the credit limit was reached but the turn keeps running until the retry lands                                                                                                                                                                                              | an explanation that is briefly ahead of the fact                             | Stop button                                |
| Activity append fails, interrupt succeeds                      | the turn stops and looks exactly like a user Stop press                                                                                                                                                                                                                                      | a stop with no stated reason; the refusal on the next turn start explains it | —                                          |
| Both fail                                                      | retried next tick via `interruptPending`                                                                                                                                                                                                                                                     | nothing until the retry                                                      | Stop button                                |
| ws gate's thread-shell read fails                              | fail **open** for the ws gate only, log, and let the **reactor** gate refuse authoritatively. The turn is still stopped; it costs the Queue its pause.                                                                                                                                       | the turn errors in-thread rather than pausing the queue                      | —                                          |
| `resolveThreadBackend`'s `creditsBlockedReason` read fails     | the caller passes `null` (not blocked) and logs; identical to the `readCursorUsage` null path below                                                                                                                                                                                          | offload continues                                                            | the `subagentBackendEnabled` master switch |
| `readCursorUsage()` fails or returns `null`                    | fail **open**: Cursor offload is _not_ blocked. Absence of a reading is not a reading of 100%. Log `credit-spend-guard.cursor-usage-unavailable` at warn when the toggle is off.                                                                                                             | offload continues                                                            | the master switch                          |
| `reconcileAllBackends()` fails after a Cursor block transition | logged; flag files keep their previous value, rewritten at the next session start (`writeThreadBackendForSession` runs around every `startSession`)                                                                                                                                          | a thread may offload once more before the block lands                        | the master switch                          |
| Guard fiber dies entirely                                      | `ignoreCause({log:true})` per item keeps it alive; if the fiber dies anyway, **refusals keep working** — the gates read live state — and only the interrupting and the Cursor flag-file rewrite stop.                                                                                        | already-running turns are not interrupted                                    | Stop button; the toggle still works        |
| Bootstrap turn refused                                         | the RPC fails **before** `thread.create`, so no thread, worktree, or setup-script run is left behind (I10)                                                                                                                                                                                   | the reason, in the new-thread surface; no orphan thread appears              | turn the switch on                         |
| Refused turn start, from the Queue                             | RPC fails; the draft returns to the composer if untouched; the queue **pauses**                                                                                                                                                                                                              | "Queued send failed: `<title>` — `<reason>` The queue is paused."            | resume the queue, or turn the switch on    |
| Refused turn start, typed directly                             | RPC fails; `setThreadError` shows the reason (P14)                                                                                                                                                                                                                                           | the reason, in the thread error surface                                      | retype after turning the switch on         |
| Turn interrupted by the guard                                  | activity entry "Credit limit reached - turn interrupted" precedes the interrupt                                                                                                                                                                                                              | distinguishable from a Stop press in the timeline                            | —                                          |
| Cursor offload refused mid-thread                              | wrapper exits 3 with its own message; the agent falls back to a Claude subagent, the wrapper's documented contract                                                                                                                                                                           | the subagent runs locally instead                                            | the master switch                          |
| Window dips to 99 then returns to 100                          | the instance re-enters `newlyBlocked` and an in-flight turn is interrupted a second time                                                                                                                                                                                                     | a second activity entry                                                      | —                                          |
| Server **downgraded** to a build without this feature          | the key is dropped on decode and the default `true` applies: **spend is re-enabled**. Deliberate (there is no code left to enforce it) but it is a silent re-enable, so it is called out here and in the user docs.                                                                          | nothing                                                                      | re-upgrade                                 |
| Client is an older build                                       | the server enforces regardless of client version; only the Settings _row_ is absent. With the A2 capability, a **newer client against an older server** hides the row rather than silently dropping the patch (P17).                                                                         | —                                                                            | any current client                         |

No timer is introduced, so there is no clock-start row: every transition is edge-driven off an
existing stream. The only latency is `readCursorUsage`'s existing 60 s cache — a freshness bound on
an input, not a bound this design chooses.

## 10. Irreversible steps and rollback

Nothing irreversible. No migration: the setting defaults to `true` and `PERSISTED_SERVER_SETTINGS_DEFAULTS`
strips defaults on write, so an existing `settings.json` is not rewritten. Rollback is reverting the
commit — with the caveat in the failure table that rolling back silently re-enables spend, which the
user docs will state.

## 11. Surface changes

- **API / event contract** — `ServerSettings` and `ServerSettingsPatch` gain one boolean;
  `ExecutionEnvironmentCapabilities` gains one optional flag. No new RPC, no new event type. Existing
  `settingsUpdated` carries it.
- **Client** — one Settings row (web, which desktop wraps) plus a settings-search entry, both
  capability-gated. Error state is the refusal message on the turn and the Queue's existing paused
  state. No loading state: the row reads the already-loaded settings snapshot. Multi-environment
  writes fan out per `scopedSettings.ts:232-237`; a row is hidden unless **every** connected
  environment advertises the capability, matching the crew and subagent gates.
- **Security and privacy** — none. Writing needs the existing settings write scope
  (`RpcAuthorization.ts:51-52`); the guard is read-only over settings. The refusal message names the
  provider instance, which on a single-user local server is exactly what the user needs to act.
- **Auditing / tracking** — five named log lines. Revision 2 listed nine; the simplicity lens called
  that disproportionate for a local single-user server with no alerting pipeline, and the four
  dropped ones were each derivable from something else that already exists:
  - `credit-spend-guard.turn-refused { threadId, instanceId, reason, gate: "ws" | "reactor" }` — the
    only record of a pre-dispatch refusal, since by design no event is written. The `gate` field is
    what tells an operator whether the Queue should have paused.
  - `credit-spend-guard.instance-blocked { instanceId, windowIds, usedPercents }` and
    `.instance-unblocked { instanceId }` — the transition pair, answering "what is the guard doing
    right now" without needing someone to have attempted a turn.
  - `credit-spend-guard.tick-failed { stage, cause }` — fiber health; `stage` distinguishes the
    settings read, the provider read, and the projection read (absorbing the former
    `.interrupt-skipped`).
  - `credit-spend-guard.gate-unavailable` — the fail-open path, so a turn that went through when it
    should not have is explicable.

  Dropped: `.interrupt-dispatched` (the thread activity entry is the durable record),
  `.cursor-offload-blocked` and `.cursor-usage-unavailable` (the `degraded` string written into each
  thread's flag file already carries the reason, and the sidebar renders it).

- **Alerting** — N/A: a local single-user server with no alerting pipeline.
- **Docs** — a short subsection in `docs/user/usage.md` under "Track subscription limits".

## 12. Tradeoffs and limitations

- **A cooperative interrupt, not a hard stop — and the gap is bigger than revision 1 said.** The
  safety lens read `ProviderTurnStallWatchdog.ts:237-241`: the watchdog **abstains entirely whenever
  the open-tool set is non-empty**, so a turn wedged inside a tool call is never stopped by anything
  automated, and the guard's cooperative interrupt is the same signal Stop's _first_ press sends —
  which such a turn can ignore. For SDK silence with no open tools the watchdog does hard-stop, in
  ~16 min worst case. _Alternative rejected:_ escalating to `thread.session.stop`. Escalation needs a
  "how long do we wait for the interrupt to land" bound, and that is a time bound with no measurement
  behind it — the exact shape that has burned this codebase before. _What we lose:_ a tool-wedged
  turn on a blocked instance keeps its session until the user presses Stop twice. The turn-start gate
  still stops the next turn. Follow-up in section 13 carries the measurement that would settle it.
- **Cursor's block is as fresh as the last tick.** _Alternative rejected:_ a dedicated Cursor poller,
  which duplicates `readCursorUsage`'s own 60 s cache. Instead the fiber evaluates Cursor on every
  provider-snapshot and settings change, bounding staleness to the provider health interval (5 min
  default) rather than "until the next session start". _What we lose:_ an account crossing 100%
  between ticks can dispatch subagents for up to that interval.
- **"Any window at 100%" is a blunt reading (P11).** _Alternative rejected:_ blocking only on the
  bucket that actually bills — Claude's `seven_day_overage_included`, Cursor's `onDemand`. Those live
  on a **different pipeline** (`account.usage.updated`, not `ServerProvider.usageLimits`) with
  different per-driver coverage, so it needs a second data path for a distinction the ask did not
  draw. _What we lose:_ with the switch off, hitting the five-hour window blocks work a subscription
  would have allowed for free after the reset — the conservative direction the switch's name promises.
- **Four of six drivers can never be blocked (P1).** Nothing tells the server how much Grok, OpenCode,
  Antigravity or Cursor-as-a-provider have used. _Alternative rejected:_ fail-closed, section 5. The
  Settings copy says so rather than leaving the user to discover it.
- **The wrapper is the enforcement point for Cursor subagents, not the process boundary.** An agent
  that ignores its instructions and runs `cursor-agent` directly bypasses the flag file. _Alternative
  rejected:_ denying the binary in the session environment — out of proportion, and the server does
  not own that spawn (the agent's own Bash tool does).

## 13. Open questions and follow-ups

- **Escalate an unlanded interrupt to `thread.session.stop`.** Trigger: measure how long a
  tool-wedged turn on a blocked instance actually persists, then pick the bound from that number.
  Explicitly not guessed here.
- **Consolidate the three `LIVE_SESSION_STATUSES` copies** (`BootTurnReconciler.ts:51`,
  `BackgroundTaskRecoveryWatchdog.ts:60`, and this design's). Pre-existing duplication this design
  adds to rather than fixes, deliberately: deduping one of two while filing the other is churn.
- **Align `useAvailableSettingsSearchItems`'s `.some()` filter with the panel's `.every()` gate.**
  Pre-existing, shared with the crew and subagent rows; only observable across mixed-version
  multi-environment connections.
- **Composer pre-flight indicator** — show that sends are blocked and why before the attempt.
- **Mobile Settings row** — same scope decision as the Task list and Background tab work.
- **Does "one of the usage limit" include the model-scoped weekly rows (`seven_day_<model>`)?**
  This design includes them. A Stage 7 task asserts the behaviour explicitly so it is visible rather
  than incidental. Settled by P11 unless the user says otherwise.

## 14. Review exit note

**Round budget:** four rounds (the design exceeds ~300 LOC across contracts, server and web).

**6a pillar sweep — `CONDITIONAL GO`.** All four must-fixes applied: (1) the §4/§9 settings-failure
contradiction, fixed at the root by removing the gate-facing cache; (2) gates check
`allowSpendingCredits` first; (3) the ws gate stated to run for bootstrap, above the branch, with I10
pinning it; (4) the missing failure rows added. One 6a finding **rejected**: it reported P10 "NOT
REPRODUCED", but it could not run vitest (sandbox EPERM) and its hand-written probe exercised the
`it.each([3,4,6])` fence cases rather than the non-BMP assertion that actually failed. Re-probed with
a third mechanism — the regex itself — which reproduces the split exactly (P10). Recorded rather than
re-opened.

**Round 1 lenses:**

- **Correctness — finding applied, re-runs in round 2.** Blocker: component D misidentified
  `ProviderCommandReactor.ts:766-773` as already implementing the resolution order; it computes two
  different values and neither is the rule. Confirmed by re-reading source (P15). Changed the
  component boundary: ws uses a new pure resolver, the reactor uses the exact post-ensure binding.
- **Simplicity — finding applied, re-runs in round 2.** Removed the `Services/` file, the Context
  tag, and the gate-facing `Ref`; both gate _sites_ kept, both arms having been built and measured.
- **Safety + observability — findings applied, re-runs in round 2.** Three fail-open holes in the
  cached blocked-set, all reproduced; the activity entry before the interrupt; the named log lines;
  the quantified watchdog gap now in section 12.
- **Compatibility — findings applied; re-runs in round 2** because its dimension (the settings and
  capability contract) changed. Added the A2 capability flag and eight files the list had missed.

**Round 2 (against revision 2):**

- **Correctness — quiescent after round 2.** Re-read the reactor and confirmed P15 and P16, then did
  the thing the design most needed: enumerated all six session-restart triggers and asserted the
  _direction_ of every ws/reactor divergence. None is unsafe. Its two findings were documentation
  (the divergence list was missing the two model-restart triggers; the pre-gate attachment claim
  needed stating). No pseudocode block, invariant or component boundary moved.
- **Compatibility — quiescent after round 2.** Re-derived the file list independently and
  re-verified all five "not needed" claims; both findings are additions to the plan rather than
  changes of shape. The load-bearing one: `ServerEnvironment.test.ts` asserts a _subset_ of
  capabilities, so it would not have caught a schema field that was never advertised — I11 now names
  an explicit assertion instead of assuming a test existed.
- **Simplicity — retired after round 2.** It found revision 2 had over-corrected: two new modules
  (an 11-line resolver with one caller, and an 8-line constant that would have been a third home for
  a set that already has two copies) and nine log names. All applied — both modules inlined, logs cut
  to five. Retired rather than re-run because the change is pure deletion: there is no new structure
  for a third pass to attack, and its remaining open question (consolidating the three constant
  copies) is carried to section 13 as a follow-up.
- **Safety — one finding applied, re-runs in round 3.** It confirmed the round-1 cache holes are
  fully closed and, importantly, checked the _replacement_ for the same class of bug: it verified
  that `getProviders` cannot transiently drop a live instance during a probe refresh or registry
  rebuild (`ProviderRegistry.ts:652-655,710-712,800-803`), which is what the live-read gate depends
  on. It then found a genuinely new defect in the interrupt path — `prevBlocked` was assigned before
  the projection read, so a failure there permanently lost the interrupt. Fixed with
  `interruptPending` and pinned by I12.

**Round 3 — safety lens only,** against the `interruptPending` logic, which was the one place round 2
added new behaviour rather than deleting it. Correctness and compatibility were quiescent and
simplicity retired, so re-running them to keep the round symmetrical would have bought nothing.

- **Safety — retired after round 3.** It confirmed `interruptPending` closes the round-2 defect
  (both arms run), that the set cannot grow unboundedly (an empty sweep clears the debt), that the
  toggle interaction is right in both directions, that section 9's four partial-pair rows match the
  model, and that I12 discriminates. Its one remaining finding was **Low and code-shaped**: on a
  retry tick the sweep re-appends the activity entry for threads whose interrupt already landed.
  Applied as the `announced` guard and pinned by I13. Retired rather than run a fourth round, because
  that finding is a property of the retry loop's implementation rather than of the design's shape,
  and the cheapest way to keep it honest is the I13 mutation on running code, which Stage 7 carries
  as a named task.

**Stage 6 exit: all four lenses closed, 6a `CONDITIONAL GO` with all four must-fixes applied.**
Three rounds against a four-round budget. Open questions carried into Stage 7 as verification tasks:
I13's mutation, and the model-scoped weekly window question in section 13.
