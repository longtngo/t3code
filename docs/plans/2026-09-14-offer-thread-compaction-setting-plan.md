# Offer to compact threads setting - plan

Design: `docs/design/2026-09-14-offer-thread-compaction-setting-design.md`.

## Task 1 - contracts (I3)

- `packages/contracts/src/settings.ts`: `offerThreadCompaction` in `ServerSettings` (default `true`,
  `catchDecoding` to `true`) next to `allowSpendingCredits`; `optionalKey(Boolean)` in
  `ServerSettingsPatch`.
- `packages/contracts/src/environment.ts`: `offerThreadCompaction: optionalKey(Boolean)` capability.
- Tests in `settings.test.ts`: default true; decode `{}` -> true; `"false"` degrades to true without
  losing a sibling key; patch rejects a string; patch accepts `false`.
- Commit `feat(contracts): offerThreadCompaction server setting`.

## Task 2 - server (I1, I2, I4, I5)

- `apps/server/src/environment/ServerEnvironment.ts`: advertise `offerThreadCompaction: true`;
  assert it in `ServerEnvironment.test.ts`.
- `ClaudeAdapter.ts`: yield `ServerSettingsService`;
  `handleResumeDialog` returns `{ behavior: "completed", result: "continue" }` before asking when it
  yields `false`.
- Test in `ClaudeAdapter.test.ts`: adapter built with an option reading a `Ref<boolean>`; with the
  Ref `false`, the dialog resolves `continue` and no `user-input.requested` is emitted; flip the Ref
  to `true`, a second dialog emits the question (I5).
- Commit `feat(server): skip Claude's resume compaction question when offers are off`.

## Task 3 - web + docs

- `ChatView.tsx`: `settings.offerThreadCompaction === false` early-return in
  `resumeCompactionBannerItem` (+ dep).
- `SettingsPanels.tsx`: `supportsOfferThreadCompaction` gate and a `serverScoped` row titled
  "Offer to compact threads" beside "Allow to spend credits".
- `settingsSearch.ts`: entry `offer-thread-compaction`, `requiresOfferThreadCompaction`,
  availability `hasOfferThreadCompaction`; `useAvailableSettingsSearchItems.ts` computes it;
  update `settingsSearch.test.ts` fixtures and add a gated/ungated case.
- `docs/user/composer.md`: one sentence naming the switch.
- Commit `feat(web): Offer to compact threads setting`.

## Invariant map

| Invariant | Site                                          | Pinned by                               |
| --------- | --------------------------------------------- | --------------------------------------- |
| I1        | `ClaudeAdapter.ts` `handleResumeDialog`       | Task 2 adapter test (setting false)     |
| I2        | same                                          | existing resume compaction adapter test |
| I3        | `settings.ts` `ServerSettings`                | Task 1 tests                            |
| I4        | `ServerEnvironment.ts`                        | `ServerEnvironment.test.ts` assertion   |
| I5        | `ClaudeAdapter.ts` live `getRawSettings` read | Task 2 setting flip                     |
| I6        | `shouldOfferResumeCompaction` `offerEnabled`  | logic test + tsc                        |
