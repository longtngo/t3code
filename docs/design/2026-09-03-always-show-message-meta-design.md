# Always show message timestamp and actions — design

**Date:** 2026-09-03 · **Branch:** `feat/always-show-message-meta`

## Goal

A Settings → General switch, off by default, that keeps every message's timestamp row (and the
buttons in it: Copy, Revert) visible instead of revealing it on hover. Off keeps today's behaviour
byte for byte.

Baseline @ 8537c8bad: `grep -c alwaysShowMessageTimestamps packages/contracts/src/settings.ts` → 0;
`settingsSearch.ts` → 0. Regression floor: `pnpm run verify` → 13,028 passed, 0 failed.

## Approach

One boolean client setting, threaded to the two places the hover classes live.

- `packages/contracts/src/settings.ts` — `alwaysShowMessageTimestamps:
Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)))` in `ClientSettings`,
  `Schema.optionalKey(Schema.Boolean)` in `ClientSettingsPatch`. The parity guard in
  `settings.test.ts` covers only the server pair (measured: dropping the client mirror leaves
  138/138 green; typecheck catches it at the first `updateSettings` call), so this change adds
  the client arm to that guard — its own comment says the class of bug has shipped twice. Test:
  default false, explicit true survives decode, patch decodes.
- `apps/desktop/src/settings/DesktopClientSettings.test.ts` — the literal fixture lists every key;
  add it.
- `apps/web/src/components/settings/SettingsPanels.tsx` (General section) — a `SettingsRow` +
  `Switch` with `aria-label`, id `always-show-message-timestamps`, title "Always show message
  timestamps" (the title is one string, owned by the `settingsSearch.ts` entry and read back
  through `searchableSetting`), description "Keeps each message's timestamp row and its buttons
  visible instead of showing them on hover." Every non-legacy General switch also appears in the
  Restore-defaults surface, and this one does too: `changedSettingLabels` and its dependency
  array, the `restoreDefaults` patch, and a per-row `SettingResetButton`
  (`showSkillsInSlashMenu` is the template: `SettingsPanels.tsx:542`, `:627`, `:705`,
  `:2314-2326`). Without those four the confirmation dialog cannot name the setting and
  "Restore default settings" cannot reset it.
- `apps/web/src/components/ChatView.tsx` → `MessagesTimeline` — the value rides
  `TimelineRowSharedState` beside `timestampFormat`, which already takes the same path. The
  `MessagesTimeline` prop is optional with a `false` default like the file's `skills` /
  `hideEmptyPlaceholder` props: a required prop costs 45 fixture edits in
  `MessagesTimeline.test.tsx` (measured) for nothing. Both the memo object and its dependency
  array get the field — that array already drifts unnoticed (`suspendEndScrollMaintenanceForDisclosure`
  is in the deps and not the object), so nothing lints an omission.
- `apps/web/src/components/chat/MessagesTimeline.tsx` — one pure helper in
  `MessagesTimeline.logic.ts`, `messageMetaVisibilityClasses(alwaysVisible, hoverGroup)`,
  returns `"opacity-100"` or `"opacity-0 focus-within:opacity-100 <hover>:opacity-100"`; the user
  row (`:1380`, hover class `group-hover:`) and `AssistantMessageMeta` (`:1526-1531`, hover class
  `group-hover/assistant:`) both call it, so the two group names cannot be copy-pasted into
  each other, and the helper is what gets unit-tested rather than static markup (AGENTS.md
  forbids asserting classes on rendered markup). The inline assistant meta (`:1481`) passes
  `alwaysVisible={ctx.alwaysShowMessageTimestamps && !message.streaming}`: while a null-turn
  assistant message is still streaming the row has no timestamp and no Copy (both are gated on
  `!streaming`), so forcing it visible would paint an empty strip; it stays on hover-reveal
  until the message settles. The standalone `assistant-meta` row already passes `alwaysVisible`
  and is untouched — which also means turns that end in tool work show their meta permanently
  today regardless of the switch; the description above is worded not to promise otherwise.
  With the switch on, the Revert button is visible while disabled during a running turn, as it
  is on hover today.

No new hook: the panel reads `settings.alwaysShowMessageTimestamps` like its neighbours, and the
timeline reads it once at the `ChatView` boundary. A pre-hydration flash is a non-issue here
(opacity, not a remount), so the `useLegacySidebarEnabled` hydration gate is not copied.

## Surfaces

- Web and desktop: covered (desktop wraps web).
- Mobile: not applicable. `ThreadFeed.tsx` already renders the row unconditionally (no hover on
  touch), and mobile keeps its own local preferences rather than reading `ClientSettings`.
- Reverse state: the same switch turns it off; off restores the hover classes verbatim.
- Docs: no `docs/user/` page enumerates General rows; one sentence in `docs/user/composer.md`
  beside its other "Settings → General" references.

## Alternatives rejected

- CSS `@media (hover: none)` auto-reveal — solves touch laptops, not the ask (an explicit
  preference on pointer devices).
- A `data-` attribute on the timeline root with a CSS rule — one fewer prop, but the timeline's
  row classes are Tailwind literals and the `alwaysVisible` precedent already exists; mirroring
  it keeps both meta rows on one mechanism.

## Tests

- contracts: default/override/patch for the field (mirrors `legacySidebarEnabled` tests).
- web: `MessagesTimeline` already has logic tests; add one assertion that the user meta row and
  inline assistant meta drop the `opacity-0` class when the flag is on and keep it when off, if a
  render-level test exists for those rows; otherwise cover through the class-selection helper.
- `settingsSearch.test.ts` checks id uniqueness only; nothing asserts a catalogued id is
  rendered, so the plan adds a `SettingsPanels` assertion that the General panel renders a row
  for this id (the one direction in which the catalog and the panel can drift and hide the
  feature).

## Review exit

6a (pillar sweep) and 6b (correctness + simplicity) ran in parallel, one round. Applied from 6b: the
Restore-defaults surface, the streaming edge, the one-string title, the rename from the earlier
"meta" spelling, the description wording, the schema snippet. Applied from 6a: the parity-guard
claim was false and the guard gains a client arm; the timeline prop is optional; the class helper
replaces two hand-written class strings; deps-array note. Rejected: none. A second 6b round is not needed — every applied edit is a wiring
addition inside surfaces the same lens already traced.

## Follow-ups deferred

None.
