# Settlement sweep log storm — design

**Status:** revised after Stage 6b review (correctness, simplicity, observability)
**Branch:** `fix/settlement-log-storm`

## Goal

`ThreadSettlementReactor` sweeps every 60 seconds. When a thread group's pull-request lookup
fails, the group-level catch logs `Cause.pretty(cause)` — a ~30-line stack — and does so on
_every_ sweep for as long as the group stays a settlement candidate.

The failure is already handled one layer down: `GitManager` caches a failed PR lookup with
exponential backoff, so spawning `gh` is throttled. **Only the logging is not.**

### Baseline @ 6bdee4556 (2026-09-01)

```
warnings:                  472
bytes of those warnings:   1,300,255
total log bytes in window: 1,368,765   -> 95.0% of ALL server log output
lines per warning:         min 15 / median 30 / max 39   (~2,755 B each)
regression floor:          pnpm verify green, 11,326 passed / 20 skipped / 0 failed
```

Independently reproduced by review at 1,297,797 B / 98.6% on the tight first→last-warning window.
Both are right; they differ only in window boundary.

## Scope: ONE site, not two

The file has **three** `Cause.pretty` catch sites. Across the entire 126 MB log:

| site                     | fired   |
| ------------------------ | ------- |
| sweep-level (`:143`)     | 0       |
| per-thread (`:120`)      | 0       |
| **group-level (`:132`)** | **472** |

Only the group-level catch changes. The original draft said "both catch sites"; that was wrong on
both the count and the scope.

## Approach

### The decisive precedent

This fork already solved this exact problem 700 lines away, in the same failure family:
`shouldLogPrLookupFailure` / `forgetPrLookupFailureLog` (`GitManager.ts:1077-1109`), fork-only,
commit `00120435b` (2026-08-12), _"report an unchanged PR lookup failure once, not once per
poll"_ — written when the same errors produced 37,944 lines in 22 hours.

The natural experiment sits inside the measured window: same process, same repositories, same
failures, two code paths.

| path                                           | warnings in window |
| ---------------------------------------------- | ------------------ |
| upstream reactor (no dedup)                    | 472                |
| fork `GitManager` (`shouldLogPrLookupFailure`) | 9                  |

So this design **mirrors that idiom** rather than inventing a second one with different semantics.

### 1. Structured scalar annotations, not a prose reason

Replace `{ threadIds, cause: Cause.pretty(cause) }` with
`Effect.annotateLogs({ threadCount, workspaceRoot, branch, errorTag, causeTag, detail })`.

Two measured reasons this beats the original "one-line reason":

- **A squashed reason cannot identify the repository.** `Cause.squash` returns the _outermost_
  error, and 430 of 472 warnings squash to one byte-identical string spanning 6 repositories. The
  repo path lives only in a third-level nested cause, which a one-liner discards.
  `SourceControlProviderError` already carries `cwd`/`repository`/`command` as fields; its
  `message` getter just omits them. Naming `workspaceRoot`/`branch` explicitly is what makes the
  line actionable — and `GitManager`'s equivalent already annotates `branch`.
- **`threadIds` is most of the bytes, not the cause string.** Passed as an object arg it goes
  through `util.inspect`, which explodes any array of more than one element across lines (median
  group 3 threads, max 12). Scalars render flat. Change (1) _alone_ was measured at 411 B/record —
  still 91.5% of all log output — which is why it is not sufficient on its own.

### 2. Change-only dedup, no TTL

**`failureKey` = the walked cause-tag chain + the squashed error's `message`.** Not `detail`, and
not a single-hop `causeTag`. Both were measured wrong in round 2:

- **`detail` must stay out of the key.** It adds zero discrimination (2 distinct keys with it, 2
  without, over all 472 events) and `GitManager.ts:1183-1188` — the precedent this mirrors —
  excludes it in a comment: _"`detail` carries raw command output, which can differ run to run for
  one standing condition and would defeat the dedupe."_ `contracts/src/git.ts:373` warns the same.
  Keep it as an annotation; never as a key.
- **A one-hop `causeTag` collapses a hang into an exit.** The window's single `gh` timeout and its
  429 exit-1s both render `GitHubCliCommandError`. Walking the `.cause` chain distinguishes them
  and costs **0 extra records** over the real population.
- **`message` must be annotated.** Without it the two `Effect.die` sites (`:70`, `:82`) are
  byte-identical and share `failureKey = "Error//"`, so the second is suppressed forever — a
  defect silenced by a change meant to quiet an expected condition. Every error class here already
  interpolates `detail` into its `message`, so annotating `message` strictly dominates.

A `Map<lookupKey, failureKey>` in `make`'s closure (**not** inside `sweep` — inside, it is
recreated every 60s and the whole feature is an inert no-op). Log when the key is unseen or its
`failureKey` changed; otherwise stay silent. Delete the entry on a **successful** lookup, so a
recovered-then-recurring failure reports again instead of being suppressed as a repeat.

Bound it at **2,048** with the capacity + evict-oldest idiom already used 9 times across 4 files
in this server, mirroring `prLookupFailureStreakByKey` / `PR_LOOKUP_CACHE_CAPACITY`. The number
matters and must be stated: eviction is insertion-ordered and re-`set`ting a key does not refresh
its position, so at a capacity near the live key count a churning space evicts the hot key every
sweep. Measured at capacity 4, the hot key logged 20/20 sweeps — dedup fully defeated. At 2,048
against 12 real keys it is unreachable, but the margin is the safety.

Iterate `groups.entries()`, not `groups.values()` (`:88`) — the latter discards the key the map
needs. Spread annotations conditionally (`GitManager.ts:1198-1207`); an absent `causeTag` must not
render as the literal `undefined`, and linked-PR groups have no `workspaceRoot`/`branch`.

Say so in the message text, as `GitManager` does, so the operator knows the dedup exists.

**No TTL, no timestamps, no sweep-scoped pruning.** All three were in the first draft and all
three were measured to be wrong:

| arm                                 | logs  | bytes     | vs baseline |
| ----------------------------------- | ----- | --------- | ----------- |
| upstream today                      | 472   | 1,297,797 | 100%        |
| change (1) alone                    | 472   | 193,979   | 14.95%      |
| first draft: (1) + 15-min TTL map   | 19    | 9,033     | 0.70%       |
| **chosen: (1) + change-only dedup** | **7** | **2,086** | **0.16%**   |

- **The TTL costs 2.7x the output and buys nothing.** It was calibrated to how often `gh` re-runs,
  not to how often an operator needs telling that a standing condition still stands. The fork
  already made this call the other way in 2026-08 and has lived with it without complaint.
- **Sweep-scoped pruning is inert and harmful.** It emits 7 with pruning and 7 without, and when a
  single-thread group flaps in and out of candidacy — which happens every time a turn runs in that
  thread — it produced 20 logs where age/capacity bounding produced 3.
- **One map, two key spaces.** The obvious seen-set (`new Set(groups.keys())`) holds no thread
  ids, so it silently deletes every per-thread entry each sweep. Dropping pruning removes the
  coupling entirely — and this design touches only the group site anyway.

### 3. Keep the full cause at debug level

Emit `Cause.pretty(cause)` at `logDebug`, **outside** the dedup guard. Otherwise the 25-line cause
is simply deleted and recovering it needs a redeploy; with it, `T3CODE_LOG_LEVEL=Debug`
(`cli/config.ts:86`) is the escape hatch. One line.

## Deviation from the approved instruction

The instruction approved a TTL. The measurement says change-only + forget-on-success is 2.7x
quieter (7 vs 19 logs), matches the fork's existing idiom instead of adding a second one, and
carries less divergence through future upstream merges. Change (2) is still a suppression with the
same intent; only its expiry rule differs. Flagged rather than silently swapped.

## Alternatives rejected

- **Change (1) alone.** Measured: still 472 records and 91.5% of log output. Not sufficient.
- **`Cache.make({ capacity, timeToLive })` keyed on key+reason.** The right tool _if_ a TTL is
  kept — ~4 lines, bounding included, and `GitManager` already uses `Cache.makeWith` three times.
  Rejected only because the TTL itself is rejected. Noted as the answer if liveness ever wins.
- **Fix it in `GitManager`.** Wrong layer: `branchPullRequest` must propagate the error, so
  silencing belongs at the consumer.
- **Do nothing.** Bounded and self-limiting, but 95%+ of log output buries every other warning
  (472 settlement warnings vs 38 other WARN lines in the window).

## Tradeoffs and limitations

- Upstream code (#8600), one commit old and likely to churn, so every added line is divergence
  re-merged forever. Chosen shape is ~12 lines at one site.
- **Reason-change detection is per error class, not per condition.** With the chain walked, a
  hang is distinguished from an exit; but "not a GitHub repo", "network down" and "auth expired"
  still all collapse to `GitHubCliCommandError`. A rate limit reads differently. Stated as a
  limitation rather than claimed as a feature.
- **The debug escape hatch is global.** `T3CODE_LOG_LEVEL=Debug` turns on 48 other `logDebug`
  sites in `apps/server/src`, not just this one.
- `Cause.pretty` is evaluated eagerly even when the debug record is filtered out. Measured at
  3.6 ms per 472 groups — not worth a lazy wrapper.
- `Cause.squash` prefers Fail over Die, so a concurrent defect can be dropped from the tag where
  `Cause.pretty` would show it — mitigated by (3) keeping the full cause at debug.
- Suppression means frequency is no longer readable from the log. Accepted: the condition, not its
  repetition rate, is the actionable part, and `GitManager` made the same trade.

## Test

`ThreadSettlementReactor.test.ts:200` already stubs `branchPullRequest`, so the focused test
AGENTS.md requires is cheap: two identical consecutive failures produce one warning record; a
changed failure produces a second; a success between them re-arms.

## Review exit

Round 1: three lenses (correctness, simplicity, observability), all built and ran against the 472
real events; the design was rewritten from scratch. Round 2: batched correctness + observability
on the new shape, two blockers, both payload-level and both free on the measured population, now
applied. Exiting here: round 2's findings all pointed the same direction — mirror the cited
precedent more faithfully — and the residual risk is implementation-level, which Stage 8's review
and Stage 9's sanitize cover. Simplicity was not re-run in round 2; its recommendation was adopted
wholesale, so its dimension was unchanged.

## Follow-ups deferred

- The sweep-level catch (`:143`) is unsuppressed and would be a 60/hour storm if
  `getShellSnapshot()` ever failed. Has never fired; not in scope.
- Neither log carries the repository today, including the `GitManager` precedent, which annotates
  `branch: main` with no `cwd` and is ambiguous across all 6 repos. One-field win, separate change.
