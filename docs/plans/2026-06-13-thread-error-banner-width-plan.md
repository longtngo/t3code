# Thread error banner width — plan — 2026-06-13

## Task 1 — Regression test (red → green)

**File:** `apps/web/src/components/chat/ThreadErrorBanner.test.tsx`

- Assert long usage-limit-style error renders inside `flex-1` content area
  (`min-w-0 flex-1` ancestor of `data-slot="alert-description"`).
- Assert null error renders nothing.

**Commit:** `test(web): guard thread error banner description layout`

## Task 2 — Fix layout

**File:** `apps/web/src/components/chat/ThreadErrorBanner.tsx`

- Move `AlertDescription` to direct child of `Alert`.
- Nest `Tooltip` / `TooltipTrigger` / `TooltipPopup` inside description.

**Commit:** `fix(web): restore thread error banner readable width`

## Verification

- `pnpm exec vp test run --project unit apps/web/src/components/chat/ThreadErrorBanner.test.tsx` (from `apps/web`)
- `pnpm run typecheck`
