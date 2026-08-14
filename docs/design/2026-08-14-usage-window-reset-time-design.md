# Usage-window reset time in the vitals panel — design

**Date:** 2026-08-14
**Branch:** `feat/usage-window-reset-time`

## Goal

Show *when each usage window resets* on the 5-hour and 7-day rows of the vitals popover's
"Usage limits" block, alongside the existing pace treatment.

## Why it is missing (not an accidental regression)

The user recalls this from a previous version and is right, but it was not lost in a merge. Two
facts from history:

- Upstream once had `apps/web/src/components/usage/AccountLimits.tsx` + `apps/web/src/usage/
  limitsFormat.ts`, whose rows read `… 42% used   resets 8/15 13:34`. Commit `a3823306b`
  ("fix(web): limits reset text no longer wraps") is the last tuning of that text.
- The fork's own `3345155ef` ("feat(web): combined Vitals gauge") replaced that hover card with
  the current gauge and states the tradeoff outright: *"5h/7d windows colored by PACE (projection
  marker = elapsed-window fraction + signed over/under-pace diff, **replacing the reset time**)"*.
  The comment on `computeWindowPace` still says the diff is shown *"in place of a reset time."*

So the reset time was **deliberately traded away for pace**, and both old files are now gone from
upstream and the fork alike. This change re-adds the information *without* removing pace — the two
answer different questions ("am I burning it too fast?" vs "when do I get it back?").

## Premises validated before designing (Hard Rule 8)

| Premise | Probe | Result |
|---|---|---|
| The client already has a reset timestamp | read `UsageWindowView` in `lib/vitals.ts` | ✅ `resetsAt: string \| null`, already parsed by `parseUsageWindow` |
| No server/contract change needed | `computeWindowPace` already `Date.parse`s `resetsAt` | ✅ purely presentational |
| A clock already ticks for these rows | `useNow(30_000, true)` in `VitalsGauge` | ✅ `now` is already a prop on `WindowRow` |
| The repo has a 12/24-hour preference to respect | `apps/web/src/timestampFormat.ts` | ✅ `formatShortTimestamp(iso, timestampFormat)` |

That last one is load-bearing: the deleted `limitsFormat.ts` hardcoded `hourCycle: "h23"`, and
upstream shipped a bug for exactly this class (#4438, "respect time format for sidebar snooze").
Re-porting the old helper verbatim would re-introduce it.

## Approach

**1. One pure formatter in `lib/vitals.ts`** (where the module's tested pure logic lives):

```ts
formatWindowReset(resetsAt: string | null, nowMs: number, format: TimestampFormat): string | null
```

Behaviour, carried over from the proven deleted helper:

| Case | Output |
|---|---|
| `null` / unparseable | `null` — the row simply omits the text |
| already past | `"now"` — providers refresh lazily, so a stale instant lingers briefly |
| < 24h away | `"14:20"` (time only) |
| ≥ 24h away | `"8/21 14:20"` (date + time) |

The time half delegates to `formatShortTimestamp` so the user's 12/24-hour setting is honoured;
only the date prefix is added locally.

**2. Thread `timestampFormat` as a prop**, `VitalsGauge` → `VitalsDetail` → `LimitsBlock` →
`WindowRow`. `VitalsGauge` reads it once via `useClientSettings`; the inner components stay pure.
This matters for tests: `VitalsGauge.test.tsx` renders with `renderToStaticMarkup` and no store
provider, so a hook inside `WindowRow` would silently serve the default and make the preference
untestable. A prop lets tests drive both formats explicitly.

**3. Render it right-aligned on the existing footer line**, `whitespace-nowrap`:

```
5% used · pace 6%                    resets 14:20
```

Right-aligning uses the empty half of a line that is currently short, keeps the `·` chain from
growing unbounded, and mirrors the old layout. `whitespace-nowrap` with no fixed column width is
the direct lesson of `a3823306b`, which fixed wrapping caused by fixed widths.

## Blast radius

`WindowRow` also renders `extraWindows` (Codex/Cursor). Those pass `windowMs: null`, so they have
**no pace at all** today — their footer is just `X% used`. They gain the most from this change, and
it needs no special-casing.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| Append to the `·` chain (`5% used · pace 6% · resets 14:20`) | Longest single line in a 288px popover; the old code's wrapping bug came from exactly this pressure |
| Countdown form (`in 2h`) | The deleted `formatResetIn` existed and was **removed** by `a3823306b` as a "redundant countdown suffix"; an absolute time is what the user asked for ("when the window limit will reset") |
| Put it in the header row beside the label | That slot holds the pace diff, the row's severity-coloured headline |
| Restore `AccountLimits.tsx` wholesale | It is gone from upstream too; the gauge is the live surface, and restoring a parallel panel would duplicate it |

## Tradeoffs / limitations

- Providers that expose no `resetsAt` show nothing extra — correct, since there is nothing to say.
- Minute precision only, refreshed on the existing 30s tick; a reset can read one minute stale for
  up to 30s. Matching the pace clock is preferable to adding a second timer.
- The date prefix uses `M/D` ordering. It is only shown ≥24h out (in practice the 7-day window).

## Design review

**6a (pillar sweep): skipped, deliberately.** None of its triggers fire — no service boundary, API
or event contract, no data-model or migration change, no new external/third-party dependency, no
deployment/rollout change, and no personal data, money movement, bulk mutation, or agentic side
effect. The change renders a field the client already holds. Recorded here rather than defaulted.

**6b (lenses): correctness + simplicity.** No conditional lens triggered (no new entry point or
trust boundary, no new query pattern or hot-path loop, no contract/config change, no failure-capable
background path, no new abstraction). Round 1 produced two findings, both applied; nothing else was
new, so the loop exits after one round.

| # | Lens | Finding | Resolution |
|---|---|---|---|
| 1 | Correctness | Right-aligning with `ml-auto` inside the current footer `div` is **inert** — that div is not a flex container, so the reset text would just append inline and re-create the wrapping pressure the design set out to avoid | Footer becomes `flex items-baseline justify-between gap-2`; the layout is asserted in a test, not eyeballed |
| 2 | Correctness | `formatShortTimestamp` returns `""` (not `null`) for an unparseable date, so delegating without a guard would render a bare `resets` with no time | Parse and validate in `formatWindowReset` first; return `null` before delegating |

Finding 1 is the [resource-queue-meter-layout-fixed] failure mode again: a flex utility silently does
nothing when its container isn't the layout mode it assumes.

**Timezone flake risk (raised by the correctness lens):** `Intl` renders in local time, so asserting
literal clock strings against fixed ISO inputs would pass here and fail under another `TZ`. The repo
already has the answer — `Sidebar.snooze.test.ts` builds inputs via a local-time `localDate()` helper
and asserts loose patterns. Tests follow that convention.

## Amendment during implementation — the footer can overflow

Worst-case width was checked rather than assumed, and the first layout was wrong:

| Half | Worst case (7-day, dated reset, 12-hour clock) | ≈ width @ 11px mono |
|---|---|---|
| left | `30% used · pace 37%` | ~125px |
| right | `resets 8/21 12:20 PM` | ~132px |
| gap | | 8px |
| **total** | | **~265px** |

Usable width inside the `w-72` (288px) popover after `px-4` padding is ~**256px**, so that case
overflows by ~9px. `whitespace-nowrap` prevents the *words* breaking but does nothing about the
line as a whole.

Fixed by adding `flex-wrap` to the footer container (with `gap-x-2`): the common case stays one
line, and the rare wide case drops the reset onto a second line, still right-aligned, instead of
spilling out of the panel. Truncating the left half was rejected — it would render `70% used ·
pac…`, and the pace figure is *also* readable from the bar's projection marker while the reset time
is recoverable from nothing else. A test asserts `flex-wrap` is present so the guard can't be
dropped silently.

Also reverted during implementation: the block header's right-hand caption was briefly changed from
`pace` to `pace · resets`. That legend labels the pace diff on each row's *header* line, whereas the
reset sits on the footer line — the extended caption implied a column that does not exist, and the
reset text is self-labelling anyway.

## Follow-ups deferred

None identified.
