# Account switcher UI polish — 2026-06-05

## Goal

Three follow-ups to the composer Claude account switcher (fa0a94a5):

1. Render the account switcher **before** the model picker in the composer footer.
2. The trigger shows the instance **display name** (the provider label, e.g. "PersonalSub") instead of the auth email.
3. The switcher is **disabled once the thread has started** (after the initial message), unconditionally.

## Approach

1. **Reorder** — swap the `<AccountSwitcher>` and `<ProviderModelPicker>` JSX blocks in `ChatComposer.tsx`'s footer. Pure markup move; both live in the same scrollable left-side flex group.
2. **Label** — in `AccountSwitcher.tsx`, the trigger renders `activeAccount.displayName` instead of `auth.email ?? displayName`. Menu rows keep displayName + email subtitle — the email remains discoverable where disambiguation matters.
3. **Disabled** — `disabled={threadHasStarted(activeThread)}` in `ChatComposer.tsx`, replacing `lockedProvider !== null`.

## Why `threadHasStarted` instead of `lockedProvider`

`deriveLockedProvider` (ChatView.logic.ts) intentionally degrades to `null` for
custom instance ids that don't narrow to a registered driver kind (e.g.
`claude_personal`) whenever `thread.session.provider` is absent. In that state a
started thread still showed an enabled account switcher — switching there would
silently break session continuation, since continuation keys are account-bound.
`lockedProvider !== null` implies `threadHasStarted`, so the new condition is a
strict superset: same behavior in the common case, closes the custom-instance
gap.

## Alternatives rejected

- **Fixing `deriveLockedProvider` to resolve instance ids → driver kinds**: larger
  blast radius (the null-degrade is load-bearing for rollback/fork semantics per
  its own doc comment); the switcher only needs "has the thread started".
- **Keeping email on the trigger with a shorter truncation**: doesn't match the
  ask; emails are long and the label is the user-chosen disambiguator anyway.
- **Hiding (not disabling) the switcher after start**: a vanishing control reads
  as a bug; disabled + tooltip ("Account is locked for this thread") explains why.

## Review follow-ups (applied during sanitization)

- **Disabled tooltip never rendered.** A native `disabled` button doesn't
  dispatch the pointer/hover events the tooltip listens for, so the
  "Account is locked for this thread" tooltip could never open in exactly the
  state it explains. Fixed by moving `TooltipTrigger` to a wrapper span around
  the `MenuTrigger`/`Button`; hover tests added for both tooltip states.
- Removed the email-era `sm:max-w-52` trigger cap (display names are short;
  `max-w-44` remains as the defensive ceiling).

## Files touched

- `apps/web/src/components/chat/AccountSwitcher.tsx` — trigger label + tooltip
  wrapper restructure
- `apps/web/src/components/chat/AccountSwitcher.browser.tsx` — test updates
- `apps/web/src/components/chat/ChatComposer.tsx` — order + disabled condition

## Known limitations / follow-ups

- None anticipated; the email is still visible in the dropdown rows and settings.
