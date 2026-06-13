# Sidebar idle provider dot — 2026-06-13

## Goal

Extend the sidebar thread-status indicator (shipped 2026-06-12) so **idle**
threads show a provider-colored dot in the same leading slot used for
spinner/check icons. Users can scan which provider backs each chat at rest;
working and completed states continue to replace the dot with spinner and
checkmark respectively, tinted by the provider instance accent color.

## Background — current architecture (verified against code)

- `resolveThreadStatusPill()` (`Sidebar.logic.ts`) returns `null` when no
  higher-priority status applies. Thread rows render nothing in the leading
  status slot in that case (`Sidebar.tsx`, `ThreadRowLeadingStatus`).
- Spinner/check + provider accent already ship via `ThreadStatusGlyph`,
  `useProviderAccentColor`, and `PROVIDER_ACCENT_STATUS_ICONS` (`spinner`,
  `check`). Action-required states (`approval`/`input`/`plan`) keep semantic
  colors.
- Provider accent comes from `session.providerInstanceId` → server config
  `accentColor` (`#RRGGBB`), with legibility guard (`isAccentColorLegible`).
- Aggregate surfaces (`resolveProjectStatusIndicator`, collapsed project
  header, "Show more") intentionally omit per-provider accent because they
  summarize many threads.

**Verification:** spinner/check/background-task work from
`docs/design/2026-06-12-sidebar-status-icons-design.md` is already on
`personal`. This item adds only the idle baseline indicator.

## Approach

Client-only, mechanical extension of the existing status-pill pipeline.

### A. Add `Idle` pill with `dot` icon

1. Extend `ThreadStatusIcon` with `"dot"`; add `"Idle"` label to
   `ThreadStatusPill`.
2. Add `dot` to `PROVIDER_ACCENT_STATUS_ICONS` (same accent rule as
   spinner/check).
3. At the bottom of `resolveThreadStatusPill`, after Completed/Plan Ready
   checks, return Idle when **all** of:
   - `thread.session.providerInstanceId` is set,
   - `session.status` is not `error` or `closed`,
   - `latestTurn` is null **or** `isLatestTurnSettled(latestTurn, session)` (avoids
     a dot during an in-flight turn when the shell is briefly out of order).
   Priority: Pending Approval > Awaiting Input > Working/Connecting >
   Working(background) > Plan Ready > Completed > **Idle**.
4. In `resolveProjectStatusIndicator`, **skip** `Idle` pills so project-level
   aggregates never show a misleading single-provider dot.

### B. Render the dot in `ThreadStatusGlyph`

- `dot` is not a Lucide glyph. Render a `size-2 rounded-full` span.
- Accent: `style={{ backgroundColor: accentColor }}` when legible.
- Fallback: `bg-muted-foreground/45` (neutral, distinct from semantic action
  colors).
- Keep the existing `size-3.5` tooltip trigger wrapper for alignment with
  spinner/check icons.

### C. No new server or contract changes

`providerInstanceId` is already on `ThreadSession` in the sidebar summary.
Accent resolution is already wired in `Sidebar.tsx` and
`ThreadRowLeadingStatus`.

## Alternatives considered

- **Always show idle dot for any thread with `session` (even without
  `providerInstanceId`).** _Rejected_: without an instance id we cannot resolve
  a meaningful provider accent; a generic muted dot on every row adds noise
  without answering "which provider".
- **Show provider driver badge/text instead of a dot.** _Rejected_: duplicates
  settings UI, hurts scan density; dot reuses the existing status slot.
- **Include idle dots in project aggregates.** _Rejected_: same rationale as
  2026-06-12 — aggregates span multiple providers; one dot misrepresents.
- **Derive idle provider from composer default instead of session.** _Rejected_:
  session `providerInstanceId` is the durable truth for threads that have run;
  composer default can differ mid-session.

## Files touched

- `apps/web/src/components/Sidebar.logic.ts` — `dot`/`Idle`, pill resolution,
  aggregate skip.
- `apps/web/src/components/ThreadStatusIndicators.tsx` — dot glyph rendering.
- `apps/web/src/components/Sidebar.logic.test.ts` — idle, no-instance, aggregate
  cases.

## Tradeoffs & known limitations

- Rows without `providerInstanceId` show no idle indicator (unchanged empty
  slot). Most live sessions set instance id server-side.
- Error/closed sessions and in-flight turns show no idle dot (empty slot).
- Tooltip reads "Idle" — does not include provider display name (deferred).
- Slightly more visual density in the sidebar; mitigated by small dot size.

## Follow-ups deferred

- Tooltip could include provider instance display name.
- Mobile sidebar parity if/when it shares these components.
