# Mobile connection banner layout + web wake-up reconnect latency

**Date:** 2026-08-08
**Branch:** `fix/mobile-banner-and-reconnect-wake`
**Status:** Design — final, after three review rounds

Two independent defects, both reported from the same phone screenshot of the "Failed to
connect. Reconnecting…" banner:

1. The banner's layout collapses on a phone: the message becomes a ~60px ribbon of text
   eleven lines tall while the buttons keep their full width.
2. Returning to the app on a phone whose socket died costs **15 seconds** before the client
   even begins reconnecting.

Each ships as its own commit. Their diffs do not overlap.

> **Revision note.** The design shrank at every round, and each cut is recorded in place rather
> than deleted, because the reasoning is the useful part.
>
> - **Round 1** killed the largest piece of item 2 — a forced session replacement after a long
>   background — on measured cost, and turned item 1 from an automatic rule into an opt-in one
>   after two reviewers independently found it regressed `ThreadErrorBanner`.
> - **Round 2** found that a probe _timeout_ reaches the same replacement path, so the cost
>   argument that killed the forced reconnect applies to the 3s deadline too, and measured the
>   real cellular path to size the risk.
> - **Round 3** rejected the retry that would have removed that risk, on where it would have to
>   live.
>
> What survives is a two-class opt-in and a one-token change.

---

## Item 1 — the banner collapses on a phone viewport

### Goal

On a phone, the connection banner's message stays readable and the buttons stay usable. No
change to any other alert, at any viewport.

### Root cause (source-pinned + reproduced)

`Alert` (`apps/web/src/components/ui/alert.tsx:79-113`) lays out one flex row:

```
[icon shrink-0] [content min-w-0 flex-1] [action shrink-0]
```

The control is `shrink-0` and its buttons ("Reconnecting…" + "Connections") are
`whitespace-nowrap`, so the control claims its full intrinsic width at every viewport. The
message column gets whatever is left. On a phone there is almost nothing left.

Reproduced in a static harness built from the component's own emitted classes against the
app's built stylesheet, at a 390px viewport:

|                                            | content column              | banner height |
| ------------------------------------------ | --------------------------- | ------------- |
| today                                      | **63px**                    | **308px**     |
| with the fix                               | **294px**                   | **144px**     |
| dismiss-only control in the same container | 258px, control stays inline | 54px          |

The harness is required because Tailwind's `max-sm:` keys off the **viewport**, not the
container — an earlier attempt that put a 390px-wide `div` in a desktop-width window measured
no difference at all and would have "disproved" a real bug.

### Approach

Two classes, applied **only when the caller opts in** and the alert actually has a control:

- Row: `max-sm:flex-wrap`
- Content: `max-sm:basis-48`

`Alert` gains `stackControlOnNarrow?: boolean` (default `false`).
`ComposerBannerStack` — the composer's connection/update banner, the reported surface —
passes it. Nothing else does, so nothing else changes.

Within the opted-in caller the pair is self-selecting, which is what lets one flag serve both
the two-button banner and the dismiss-only ones the same stack renders. `flex-1` means a
flex-basis of `0`, so the row's hypothetical size always fits and it would never wrap. Giving
the content a 12rem basis on a phone makes the wrap decision reflect what the message needs: a
control that still fits beside 12rem of text — a lone dismiss `×` — stays inline; two buttons
do not, and drop below. `flex-1` still grows the content to the full line once the control has
moved down.

"Self-selecting" is a property of _this container's width_, not of the control, and the margin
should be recorded at the edit site rather than trusted. At 390px the composer's inline padding
(`index.css:419-422`) gives a 338px row, where the wrap threshold is a control wider than
**112px**. Measured across all eleven banner shapes the stack can render, exactly one crosses
it — the reported connection banner, at 190px. The widest non-target control is the update
offer at **96px**, so the headroom is 16px: relabelling "Update" to something longer, or adding
a third button, would silently flip a second banner to the stacked layout.

**The pair depends on CSS source order** and that must be recorded in a comment at the edit
site: `flex-1` is the `flex: 1 1 0%` shorthand, which also sets `flex-basis`, and `basis-48`
has identical specificity. Both installed Tailwind versions (4.2.1 and the 4.3.0 `apps/web`
resolves) emit `.max-sm\:basis-48` after `.flex-1`, so `12rem` wins — verified by compiling
both, not assumed. If that ever inverted, the basis would stay `0`, the row would silently
never wrap, and no test would fail.

### Why opt-in and not automatic (round 1 finding)

The original design applied the classes to every alert with a control and claimed "no change
to any alert whose control is a lone dismiss button." **That claim was false**, and two
reviewers found the same counterexample independently.

`ThreadErrorBanner` (`apps/web/src/components/chat/ThreadErrorBanner.tsx:16`) wraps its alert
in `mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))]` — a **shrink-to-fit** box. `w-fit`
resolves to the text's fit-content width and does not grow to accommodate a 12rem basis, so
the row ends up narrower than `192 + icon + gaps + control` and the lone `×` wraps to its own
line. Measured in Chromium at 390px:

| error text                     | today                    | automatic rule                   |
| ------------------------------ | ------------------------ | -------------------------------- |
| `"Cancelled."`                 | 154×**54**px, `×` inline | 154×**106**px, `×` wrapped below |
| `"Turn failed: rate limited."` | 238×**54**px, `×` inline | 238×**106**px, `×` wrapped below |

Every short thread error on a phone — the common shape — would have doubled in height with a
bare `×` orphaned underneath. The dismiss-only guard measured in the table above holds only in
a full-width container; `ThreadErrorBanner` is not one.

A viewport-keyed rule also cannot deliver what "fix it for every caller" would need anyway:
the same bug exists in `LegacySidebar.tsx:2958` (a `Download ARM build` button squeezing its
text) at a **16rem container** on a desktop-width viewport, where `max-sm:` never fires. So the
automatic rule regressed one caller and did not fix the other. Opt-in makes the blast radius
exactly the caller that was reported broken.

### Alternatives rejected

- **Automatic (every alert with a control).** Regresses `ThreadErrorBanner`, above.
- **Condition on `controlAlignment === "center"`**, which happens to exclude
  `ThreadErrorBanner`. Rejected: vertical alignment and wrap policy are unrelated; that
  exclusion is a coincidence, not a rule, and the next caller breaks it.
- **Container queries** (`@container` + `@max-[28rem]:`), which would key off the alert's own
  width and fix the desktop sidebar case too. Rejected: `container-type: inline-size` applies
  inline-size containment, which is hostile to the `w-fit` caller it would need to protect.
  Worth revisiting if the sidebar case is ever picked up.
- **`max-sm:w-full` on the control.** Forces a wrap unconditionally, so the lone `×` in the
  same stack would also drop to its own line.
- **A caller-side reach-through** (`[&>div]:max-sm:flex-wrap` from `ComposerBannerStack`).
  Same file count as the prop, but reaches through a component's internals from outside.
- **Dropping the secondary "Connections" button on small viewports.** Fixes the screenshot with
  a caller-local diff, but removes an affordance.

### Known limitations

- The wrapped control lands left-aligned under the icon column rather than indented to the
  text. Right-alignment or an indent needs a class that also applies on the non-wrapped line.
- `LegacySidebar.tsx:2958` keeps the bug. It is not the reported surface, the legacy sidebar is
  no longer the default, and its worst case (16rem desktop container) is out of reach of this
  mechanism. Recorded as an improvement suggestion.

---

## Item 2 — 15 seconds lost on the wake-up path

### Goal

Cut the time between "user turns the phone on" and "the client starts reconnecting" when the
socket died while the app was backgrounded.

### Root cause (source-pinned + measured)

The supervisor understands three application-active wake reasons
(`packages/client-runtime/src/connection/wakeups.ts:5-9`) and treats them very differently
(`supervisor.ts:421-435`):

| reason                         | behavior on wake                                                           |
| ------------------------------ | -------------------------------------------------------------------------- |
| `application-active`           | probe the live session, **15s** timeout (`CONNECTION_PROBE_TIMEOUT`)       |
| `application-active-probe`     | probe the live session, **3s** timeout (`MOBILE_CONNECTION_PROBE_TIMEOUT`) |
| `application-active-reconnect` | skip the probe, replace the session immediately                            |

**The web client emits only `application-active`** (`apps/web/src/connection/platform.ts:93-99`)
— the slowest of the three, and the only one no other client uses. The fast path was built for,
and only wired into, the native app.

Measured against the real supervisor on a virtual clock, with a transport that is dead but has
not closed (every probe hangs) — seconds until a replacement session opens:

| wake reason                      | measured |
| -------------------------------- | -------- |
| `application-active` (web today) | **15s**  |
| `application-active-probe`       | **3s**   |
| `application-active-reconnect`   | **~0s**  |

**Bound on the real-world saving.** That measurement isolates the probe path. In the real
client, effect's RPC pinger runs concurrently — a 5s ping period with a one-cycle pong check
(`effect/unstable/rpc/RpcClient.ts:1160-1181`) — so it closes a dead socket 5–10s after timers
resume, and the close path then sleeps the first backoff rung (3s, `supervisor.ts:32`).
Whichever fires first wins. The honest claim is **8–13s today → 3s**.

That covers the dead-socket case only. On a socket that is alive, today's outcome and the new
one are identical — the probe returns and the session is kept — _unless_ the probe exceeds 3s,
in which case the change is a loss, not a win. That branch is the risk section below.

### Approach

**One change: the web emits `application-active-probe` instead of `application-active`** — the
`Stream.callback` type parameter and the `Queue.offerUnsafe` literal in
`apps/web/src/connection/platform.ts:93,98`. No new module, no threshold, no new state, and a
one-token rollback.

`application-active-probe` is already `isApplicationActiveWakeup` (a wake still resets the
backoff ladder) and already `shouldResubscribeAfterWakeup` (shell and thread subscriptions
still re-issue — `state/shell.ts:184`, `state/threads.ts:551`).

This ships with a known, bounded risk rather than a claim of safety. Read the next two sections
together: the first says what the risk is, the second says why the fix for it was rejected.

### The risk being accepted (round 2 finding)

**A probe timeout reaches the same expensive replacement path that got the forced reconnect
killed.** `supervisor.ts:449` sets `wakeProbeFailed`, read at `:685`, and `:722-730` then skips
the backoff and immediately builds a new session — a new object, so `subscribeDynamic`'s
`switchMap` (`rpc/client.ts:208-218`) fires and **every cost listed below applies verbatim**.
The earlier draft claimed that list "does not happen on the probe path at all" and that this
change had "no new failure modes". Both were wrong: they hold for a _successful_ probe. On a
timed-out probe the full bill lands, on a link that was alive.

**Today the fork's probe never fires first, and at 3s it would.** effect's pinger writes a ping
every 5s and fails if the previous pong is still outstanding at the next tick
(`RpcClient.ts:1160-1181`), so the transport itself declares a socket dead well before a 15s
probe can. Shortening to 3s does not just tighten a timeout — it **moves authority over the
wake liveness decision** from the transport to the fork's probe, and it does so with a deadline
nobody has measured on this deployment.

**Measured on the real path.** `tailscale ping` to the phone on cellular (T-Mobile, direct
path, radio held warm by the pings themselves):

```
126ms  52ms  407ms  57ms  429ms  237ms  518ms  401ms
```

Warm median ~230ms, warm max **518ms**, a tenfold spread across eight consecutive samples —
and that is the _best_ case. A real wake adds RRC idle→connected promotion, a CGNAT mapping
that cellular rebinds while the radio idles (so the first packet needs path re-discovery, with
DERP fallback), and a possible TCP retransmit whose RTO floor is 1s and doubles. Exceeding 3s
on a healthy link is plausible; exceeding 6s twice in a row is not.

**The native precedent does not cover this regime.** `MOBILE_CONNECTION_PROBE_TIMEOUT` is only
ever reached on native after a background of **under 10 seconds**
(`apps/mobile/src/connection/app-state-wakeups.ts:14-17` routes anything longer to
`-reconnect`) — a warm radio, a live NAT mapping, no server backlog. This design applies it to
backgrounds of unbounded length. 3s has never run in the conditions it is being asked to
survive.

**A second, self-inflicted path to a false timeout.** `-probe` is in
`shouldResubscribeAfterWakeup`, so the same `visibilitychange` that starts the probe also fires
the shell and thread resubscriptions on the _same socket_. If the thread cursor is more than
`THREAD_RESUME_MAX_GAP = 1_000` events behind head (`apps/server/src/ws.ts:359`) the server
sends a full window rather than deltas, and the probe's reply queues behind it. "Returned to a
phone after agents ran for a while" is simultaneously the biggest resume payload and the exact
case this design exists for.

### Why the risk is bounded enough to ship anyway

The two conditions have to hold **together**: the socket is genuinely alive _and_ the probe
round trip exceeds 3s. Much of the scary tail fails that conjunction.

- A phone asleep on cellular for minutes has almost certainly had its NAT mapping rebound, so
  the socket is dead and the timeout is _correct_ — that is the case this change is for.
- A short background leaves the radio warm, where the measured distribution (median ~230ms,
  max 518ms) sits an order of magnitude inside the deadline.
- The head-of-line case needs a cursor more than 1,000 events behind, which needs the client to
  have _missed_ events. A socket that stayed alive and delivering keeps the cursor current and
  resumes with deltas. The overlap is real only where a mobile browser froze the page while the
  socket stayed up — narrow, and unmeasured in either direction.

And the consequence of being wrong is an **unnecessary reconnect**, not a lost write. Drafts,
images and contexts survive (`ChatView.tsx:5535-5560`), scroll position is not keyed on the
connection, and the app already performs this exact reconnect on every network blip and every
server restart. The one sharp edge — a thread-history window reset — requires the >1,000-event
gap, which is the case where a resume was going to happen regardless.

Set against that: 8–13s saved on every wake onto a genuinely dead socket, which is the daily
complaint. The rollback is one token.

### Why the retry that would have removed the risk was rejected (round 3 finding)

The obvious fix is to retry the wake probe once: dead transport detected at 6s, a single
transient stall absorbed. It is one line — `Effect.retry({ times: 1 })` between `timeoutOrElse`
and `forkChild` — and review confirmed it fits the control flow exactly, keeps the signal race
intact (interrupts are not retried), and does not corrupt `wakeProbeFailed`. It was still
rejected, on cost:

- **There is no fork-local seam.** `RpcSession.layer` is hard-wired into `driverLayer`
  (`packages/client-runtime/src/connection/layer.ts:18-20`), so the retry can only live in
  `supervisor.ts`.
- **`supervisor.ts` is the worst place this fork can diverge.** It is byte-identical to
  `origin/main` today, and upstream is actively iterating on this exact control flow — its last
  commits there include a from-scratch connection rewrite (which this fork already paid a
  579-commit reconcile for), the commit that _created_ the `-probe`/`-reconnect` split this
  design consumes, and, most recently, `ae7b27de8 fix: prevent reconnect loops during server
stalls (#5561)` — a fix in the same neighbourhood as the stall the retry addresses. A
  divergence inside `monitorConnectedLease` maximises reconcile cost and stands a real chance of
  being superseded.
- **Native pays for a web problem.** Native reaches `-probe` only after backgrounds under 10
  seconds, where the socket is least likely to be dead — so it gains little from the retry and
  pays doubled detection when the socket genuinely is dead.
- **It forces edits to two upstream tests.** `supervisor.test.ts:1019` would _hang_ rather than
  fail (its `TestClock.adjust("3 seconds")` never reaches the second attempt), and `:996` too if
  the retry were unconditional. The design had already declined to rename those two
  misleadingly-named tests to avoid churn; the retry forces edits to them anyway.
- **Two plausible spellings are silently inert.** Attaching the retry _after_ `forkChild` type-
  checks clean under `--strict` and passes every existing test while doing nothing, because
  `forkChild`'s error channel is `never`. So does putting the timeout outside the retry. A
  change whose failure mode is "green on arrival, feature absent" is a poor thing to carry as a
  permanent fork divergence.

For 2–7 seconds beyond what the one-token change already delivers, that is not a trade worth
making. Recorded as follow-up 2, to be reconsidered **only** if the instrumentation in follow-up
1 shows real churn — and if upstream has not solved it first.

### Other alternatives rejected

- **A middle constant (~6s).** Same worst case as the retry, same shared-code problem, and it
  still turns one unlucky stall into a teardown.
- **Delay the wake emission ~500ms** so the radio is up before the probe starts. Fork-local and
  it directly attacks the cold-radio tail, but it is another unmeasured constant and it delays
  the resubscribe too. Noted, not taken.
- **Leave the probe alone and cut the 3s first backoff rung instead.** Shaves 3s off the
  pinger-detected path only, and touches every platform's reconnect ladder. Deferred.

### Effect on the native client

None. The only file that changes is the web platform layer.

**Consequence to record:** after this, `application-active` has no emitter anywhere in the
product — the desktop app ships the web bundle — so the 15s `CONNECTION_PROBE_TIMEOUT` branch
becomes unreachable in production. It stays in place: it is upstream code with upstream tests,
and deleting it is fork-owned churn. The two supervisor test names that call it "desktop"
become misleading; noted rather than renamed, for the same reason.

### Why the forced-reconnect half was dropped (round 1 finding)

The original design also emitted `application-active-reconnect` after ≥10s hidden, skipping the
probe entirely for a further ~3s. All three reviewers rejected it, and the cost accounting is
decisive. A session _replacement_ is categorically more expensive than a _resubscribe_, because
`subscribeDynamic` switches on session object identity
(`packages/client-runtime/src/rpc/client.ts:208-218`). Per wake, per connected environment:

- **A full, unbounded shell snapshot over HTTP.** `state/shell.ts:203` gates on
  `lastAuthoritativeSession === session`, which a new session always fails, so it runs
  `GET /api/orchestration/shell` — five unbounded table scans, no limit parameter
  (`apps/server/src/orchestration/http.ts:49-61`,
  `Layers/ProjectionSnapshotQuery.ts:1854-1899`). This does not happen on a _successful_ probe —
  but it does happen on a timed-out one, which is why (b) exists.
- **Every mounted query atom re-executes**, because query atoms depend on `rpcGenerationAtom`
  and `generation` increments only on a successful establishment (`state/runtime.ts:487-521`,
  `supervisor.ts:688`). `staleTime` does not protect it.
- **Every open terminal replays its scrollback**, up to ~512KiB each
  (`state/terminal.ts:43`, `state/terminalSession.ts:65`).
- **Thread history can be discarded.** If the resume cursor is more than
  `THREAD_RESUME_MAX_GAP = 1_000` events behind head (`apps/server/src/ws.ts:359`), the server
  sends a fresh window and `applyItem` replaces all loaded history
  (`state/threads.ts:330-338`) — a user who paged back through a long thread is snapped to the
  last 10 user turns. A long background on a busy thread is exactly the condition that both
  exceeds 1,000 events and would have triggered the forced reconnect.
- **Sends are refused mid-replacement.** The replacement publishes `connecting`
  (`supervisor.ts:283`), `ChatView.tsx:1775` derives "environment unavailable" from
  `phase !== "connected"`, and `ChatView.tsx:5141` routes sends into the offline outbox, which
  refuses attachments, context chips, first messages and second queued turns
  (`ChatView.logic.ts:620-706`). A user unlocking their phone after 15s onto a **healthy**
  socket would be told _"Attachments and context can't be queued while disconnected."_
- **It can be strictly slower.** On a slow-but-live link, discarding a healthy lease costs up to
  `CONNECTION_ESTABLISHMENT_TIMEOUT` (15s, `supervisor.ts:33`) where a probe would have
  succeeded in under a second.
- **It aborts in-flight connects.** `waitForEstablishmentInterrupt` returns `true` for
  `-reconnect` (`supervisor.ts:383-386`), so repeated screen toggles can each discard an attempt
  that was nearly done, with no debounce anywhere on the path.
- **`visibilitychange` is not the native `AppState`.** The 10s threshold was calibrated against
  an OS that genuinely suspends the app. On the web, `hidden` also means a tab switch, an
  occluded window, or the notification shade. "The same rule" is not the same rule when the
  input means something different.

All of that to save 3 seconds over the probe path. The probe already banks 8–13s → 3s, on one
token, with no new failure modes. **Dropped**, and recorded as a follow-up gated on
instrumentation rather than shipped blind.

### Alternatives rejected (other levers on the same latency)

- **Shorten the ping period** (effect's hardcoded 5s → 2s). Cuts foreground detection, not the
  wake path; costs idle bandwidth on cellular; needs a vendor patch to a file upstream drift has
  silently deleted patches from before. Deferred, evidence-gated.
- **Drop the first backoff rung to 0.** Shared upstream code on every platform's reconnect
  ladder, and the wake path this fixes bypasses the ladder anyway. Deferred.
- **Shorten `CONNECTION_ESTABLISHMENT_TIMEOUT`.** Different symptom; risks aborting slow-but-live
  cellular connects. Not touched.

---

## What this design does NOT claim

The screenshot that prompted this shows a banner at 10:15 on a phone that, per the server log,
had made no successful websocket upgrade since 09:29. **That is not evidence of slow
reconnection and this design does not explain it.**

It is also not evidence of a stall: the upgrade log line is deduplicated by
`(host, offered-extensions)` shape (`apps/server/src/ws.ts:2569-2584`), so it fires once per
shape per boot and cannot be counted. The server logs nothing per connection, so the log is
silent either way — a negative grep here proves nothing.

Whether that phone was retrying and failing (a dead Tailscale path on cellular) or was wedged
and not retrying at all is **unresolved**, and no cheap probe on this machine answers it.
Recorded as a follow-up requiring instrumentation, not folded into this design.

---

## Files touched

| File                                                   | Item | Change                                                                                                    |
| ------------------------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/ui/alert.tsx`                 | 1    | opt-in prop (destructured, see below) + two conditional classes + the source-order and threshold comments |
| `apps/web/src/components/chat/ComposerBannerStack.tsx` | 1    | pass the prop                                                                                             |
| `apps/web/src/connection/platform.ts`                  | 2    | emit `application-active-probe`                                                                           |

All three are currently identical to `origin/main` — the fork's first divergence in each — and
`alert.tsx`'s exact `cn()` block was last touched upstream by `cec1bb9de`. Accepted: the
alternatives that avoid touching them are worse (above), and each diff is small and
comment-anchored.

**`stackControlOnNarrow` must be destructured out of `Alert`'s props.** `Alert` spreads
`...props` onto its root `<div>` (`alert.tsx:43-78`), so an un-destructured prop reaches the DOM
as `stackcontrolonnarrow="true"` — and only in the one caller that passes it, since a `false`
would be dropped with a console warning. `ThreadErrorBanner.test.tsx:17` already guards exactly
this failure mode for the sibling `controlAlignment` prop.

## Test plan

- **Item 1** — jsdom cannot lay out, so a class assertion would only restate the
  implementation. The real check is the 390px-viewport harness measurement above, which has now
  been run across all eleven shapes `ComposerBannerStack` can render plus the `ThreadErrorBanner`
  `w-fit` shape: exactly one changes (the reported banner, 188px → 124px tall, content column
  114px → 312px) and every other shape is byte-identical. Re-run against the deployed build.
  Existing `ComposerBannerStack` and `ThreadErrorBanner` tests must stay green; note
  `ThreadErrorBanner.test.tsx:18` asserts the row's class string as a _substring_
  (`"flex gap-2 items-start"`), so it is order-sensitive — opt-in means that banner's string is
  untouched, but any future automatic variant would have to respect it. Add the mirror
  DOM-leak assertion for the new prop in `ComposerBannerStack.test.tsx`.
- **Item 2, the emitter** — the web `wakeupsLayer` has **zero** test coverage today
  (`apps/web/src/connection/platform.test.ts` covers SSH pairing and bearer caching only).
  Export it and add one behavioral test: a `visibilitychange` while visible emits
  `application-active-probe`; while hidden, emits nothing. This pins the platform contract the
  whole item rests on and would catch a silent revert to the slow reason.
- **Item 2, the deadline** — deliberately left uncovered, and worth stating so the gap is not
  mistaken for coverage. Both existing probe tests (`supervisor.test.ts:996,1019`) drive the
  probe with `Effect.never`, i.e. a transport that is _hung_, so they cover the mechanism and
  not the risk: nothing exercises a probe that would have succeeded just past the deadline.
  Adding that test would assert a behavior this change does not alter (the supervisor's handling
  of a timeout is unchanged); the open question is the deadline's _value_, which only real-world
  measurement answers — follow-up 1.
- Full `pnpm run verify` before merge (Hard Rule 7).

## Follow-ups deferred

1. **Determine whether the phone at 10:15 was retrying-and-failing or wedged.** Needs
   client-side instrumentation — `apps/web/src/rpc/wsReconnectLog.ts` exists and is opt-in via
   `localStorage["t3.wsReconnect"]`, wired through
   `apps/web/src/connection/wsReconnectTimeline.ts` — or a per-connection server log line that
   is not shape-deduplicated.
2. **Retry the wake probe once**, if (1) shows the 3s deadline firing on links that were alive.
   The mechanism is settled (one line, `Effect.retry({ times: 1 })` between `timeoutOrElse` and
   `forkChild`); what is not settled is whether it is worth a divergence in `supervisor.ts`.
   Check whether upstream has changed that control flow first — it is iterating on it. If it is
   taken, review the **built output**, not the source: two spellings are inert and green.
3. **Re-open the long-background forced reconnect** only if (1) shows the probe path leaves real
   latency on the table, and then with a threshold that plausibly means "the OS suspended us"
   (minutes, not 10s) and a fix for the shell-snapshot refetch it triggers.
4. Ping-period and first-backoff-rung levers, above — evidence-gated on (1).
5. `LegacySidebar.tsx:2958`'s alert has item 1's bug at a 16rem desktop container, which a
   viewport-keyed rule cannot reach.
6. **The probe deadline is uniform across target kinds.** `supervisor.ts:425-427` picks the
   timeout from the wake reason alone and never consults `target._tag`, so a constant named
   `MOBILE_CONNECTION_PROBE_TIMEOUT` and calibrated on a single loopback-or-LAN connection now
   also governs relay (through T3 Connect) and SSH targets — the highest-RTT classes in the
   system, and ones the native client never has. The retry covers this for now; a per-target
   deadline is the real answer if relay environments start churning on wake.
7. **The probe is invisible to the client's only latency instrumentation.**
   `trackRpcRequestSent` is driven by `EnvironmentRpcRequestObserver`, invoked at
   `rpc/client.ts:137`, while the probe calls the protocol client directly
   (`rpc/session.ts:126`). It already carries
   `Effect.withSpan("clientRuntime.connection.rpcSession.probe")`, so timing it there and
   logging behind the existing `localStorage["t3.wsReconnect"]` flag is nearly free — and it is
   what would let follow-up (1) answer the deadline question with a distribution instead of an
   argument.
