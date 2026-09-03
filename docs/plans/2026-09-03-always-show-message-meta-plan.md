# Always show message timestamps — plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** a General switch `alwaysShowMessageTimestamps` (default off) that keeps every message's timestamp row and its buttons visible.
**Spec:** docs/design/2026-09-03-always-show-message-meta-design.md

## Global Constraints

- Default off: with the setting off, both meta rows keep the same class set they have today.
- Every `ClientSettings` key needs its `ClientSettingsPatch` mirror; Task 1 adds the client arm to the parity guard so the suite enforces it.
- The `MessagesTimeline` prop is OPTIONAL with a `false` default; do not edit `MessagesTimeline.test.tsx` fixtures.
- Run web tests from `apps/web`, contracts from `packages/contracts`, desktop from `apps/desktop`. Format with `pnpm exec vp fmt <files>` from the root before each commit. No repo-wide checks.

### Task 1: The setting (contracts + desktop fixture)

**Files:** Modify `packages/contracts/src/settings.ts` (`ClientSettings` beside `legacySidebarEnabled` ~:363; `ClientSettingsPatch` beside its mirror ~:1653), `packages/contracts/src/settings.test.ts` (decode cases beside `legacySidebarEnabled` ~:315-331; parity guard ~:727-757), `apps/desktop/src/settings/DesktopClientSettings.test.ts` (fixture, after `legacySidebarEnabled`).

- [ ] Step 1: Add to `settings.test.ts`:

```ts
it("keeps message timestamps on hover unless the user opts in", () => {
  expect(decodeClientSettings({}).alwaysShowMessageTimestamps).toBe(false);
  expect(
    decodeClientSettings({ alwaysShowMessageTimestamps: true }).alwaysShowMessageTimestamps,
  ).toBe(true);
  expect(
    decodeClientSettingsPatch({ alwaysShowMessageTimestamps: true }).alwaysShowMessageTimestamps,
  ).toBe(true);
});
```

- [ ] Step 2: Beside the existing server parity `it` (~:727-757) add the same check for `ClientSettingsSchema` vs `ClientSettingsPatch`, reusing `fieldsMissingFromMirror`. If a client key genuinely lacks a mirror today, list it with a comment rather than widening the mirror. Run `cd packages/contracts && pnpm exec vp test run src/settings.test.ts`: the decode test fails; the parity test passes. Prove the parity test bites: temporarily delete the `legacySidebarEnabled` line from `ClientSettingsPatch`, run, see it FAIL, restore. Record both outcomes in your report.
- [ ] Step 3: In `ClientSettings`: `alwaysShowMessageTimestamps: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),` with a one-line comment "Keeps each message's timestamp row visible instead of revealing it on hover." In `ClientSettingsPatch`: `alwaysShowMessageTimestamps: Schema.optionalKey(Schema.Boolean),`.
- [ ] Step 4: Add `alwaysShowMessageTimestamps: false,` to the desktop fixture. Run the contracts test file and `cd apps/desktop && pnpm exec vp test run src/settings/DesktopClientSettings.test.ts` → green. `pnpm run typecheck` in `packages/contracts`.
- [ ] Step 5: Commit `feat(contracts): alwaysShowMessageTimestamps client setting`.

### Task 2: Timeline honours it

**Files:** Modify `apps/web/src/components/chat/MessagesTimeline.logic.ts` (+ its `.logic.test.ts`), `apps/web/src/components/chat/MessagesTimeline.tsx` (props interface ~:325, `TimelineRowSharedState` ~:194, `sharedState` memo ~:643-695 and its deps, user meta row ~:1380, inline `AssistantMessageMeta` call ~:1481, `AssistantMessageMeta` class ternary ~:1526-1531), `apps/web/src/components/ChatView.tsx` (the `<MessagesTimeline … timestampFormat={timestampFormat}>` site ~:8335; `settings` is the `useEnvironmentSettings` object ~:1520-1528).

- [ ] Step 1: In `MessagesTimeline.logic.test.ts` add:

```ts
describe("messageMetaVisibilityClasses", () => {
  it("reveals on hover of the named group unless always visible", () => {
    expect(messageMetaVisibilityClasses(false, "group-hover:")).toBe(
      "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
    );
    expect(messageMetaVisibilityClasses(false, "group-hover/assistant:")).toBe(
      "opacity-0 focus-within:opacity-100 group-hover/assistant:opacity-100",
    );
    expect(messageMetaVisibilityClasses(true, "group-hover:")).toBe("opacity-100");
  });
});
```

Run `cd apps/web && pnpm exec vp test run src/components/chat/MessagesTimeline.logic.test.ts` → fails (no export).

- [ ] Step 2: In `MessagesTimeline.logic.ts` export

```ts
/** Class list for a message's timestamp/actions row: hover-revealed within `hoverGroup`, or pinned visible. */
export function messageMetaVisibilityClasses(
  alwaysVisible: boolean,
  hoverGroup: "group-hover:" | "group-hover/assistant:",
): string {
  return alwaysVisible
    ? "opacity-100"
    : `opacity-0 focus-within:opacity-100 ${hoverGroup}opacity-100`;
}
```

Run → green.

- [ ] Step 3: In `MessagesTimeline.tsx`: add `alwaysShowMessageTimestamps?: boolean` to the props interface and destructure it with `= false`; add `alwaysShowMessageTimestamps: boolean` to `TimelineRowSharedState`; put it in BOTH the `sharedState` memo object and its dependency array. User meta row (~~:1380): keep the layout classes and replace the four opacity/hover classes with `messageMetaVisibilityClasses(ctx.alwaysShowMessageTimestamps, "group-hover:")` through `cn(...)` (confirm the row's context variable name). `AssistantMessageMeta` (~~:1526-1531): replace the inline ternary with `messageMetaVisibilityClasses(alwaysVisible, "group-hover/assistant:")`. Inline assistant meta call (~:1481): add `alwaysVisible={ctx.alwaysShowMessageTimestamps && !row.message.streaming}`.
- [ ] Step 4: In `ChatView.tsx` pass `alwaysShowMessageTimestamps={settings.alwaysShowMessageTimestamps}` beside `timestampFormat`.
- [ ] Step 5: `cd apps/web && pnpm exec vp test run src/components/chat/MessagesTimeline.logic.test.ts src/components/chat/MessagesTimeline.test.tsx && pnpm run typecheck` → green with 0 typecheck errors (a required prop would show 45).
- [ ] Step 6: Commit `feat(web): always-show message timestamps in the timeline`.

### Task 3: Settings surface

**Files:** Modify `apps/web/src/components/settings/settingsSearch.ts` (catalog, beside the other General entries ~:326-349), `apps/web/src/components/settings/SettingsPanels.tsx` (General section; mirror `showSkillsInSlashMenu` at `:542`, `:627`, `:705`, `:2314-2333`), `apps/web/src/components/settings/settingsSearch.test.ts`, `docs/user/composer.md`.

- [ ] Step 1: In `settingsSearch.test.ts` add a guard that every General catalog id is mounted:

```ts
it("mounts every General catalog entry in the General panel", () => {
  const source = readFileSync(new URL("./SettingsPanels.tsx", import.meta.url), "utf8");
  for (const item of SETTINGS_SEARCH_ITEMS.filter((item) => item.to === "/settings/general")) {
    expect(source, item.id).toContain(`searchableSetting("${item.id}")`);
  }
});
```

Import `readFileSync` from `node:fs`; follow the repo's existing pattern for Node built-in imports in tests (grep for `@effect-diagnostics nodeBuiltinImport:off` or `NodeFS`). Run: passes today. Then add the catalog entry `{ id: "always-show-message-timestamps", title: "Always show message timestamps", to: "/settings/general", searchTerms: ["copy revert hover meta row actions"] }` and run again → FAILS (not mounted yet). That failure proves the guard works; if it does not fail, stop and report.

- [ ] Step 2: In `SettingsPanels.tsx`: add the `changedSettingLabels` entry (label "always show message timestamps"), its dependency, the `restoreDefaults` key, and a `SettingsRow` next to the `showSkillsInSlashMenu` row:

```tsx
<SettingsRow
  {...searchableSetting("always-show-message-timestamps")}
  description="Keeps each message's timestamp row and its buttons visible instead of showing them on hover."
  resetAction={
    settings.alwaysShowMessageTimestamps !==
    DEFAULT_UNIFIED_SETTINGS.alwaysShowMessageTimestamps ? (
      <SettingResetButton
        label="always show message timestamps"
        onClick={() =>
          updateSettings({
            alwaysShowMessageTimestamps: DEFAULT_UNIFIED_SETTINGS.alwaysShowMessageTimestamps,
          })
        }
      />
    ) : null
  }
  control={
    <Switch
      checked={settings.alwaysShowMessageTimestamps}
      onCheckedChange={(checked) =>
        updateSettings({ alwaysShowMessageTimestamps: Boolean(checked) })
      }
      aria-label="Always show message timestamps"
    />
  }
/>
```

- [ ] Step 3: `docs/user/composer.md`: one sentence near its "Settings → General" mention: "Settings → General → Always show message timestamps keeps each message's timestamp and buttons visible instead of revealing them on hover."
- [ ] Step 4: `cd apps/web && pnpm exec vp test run src/components/settings/settingsSearch.test.ts && pnpm run typecheck && pnpm exec vp lint src/components/settings/SettingsPanels.tsx src/components/settings/settingsSearch.test.ts` → green.
- [ ] Step 5: Commit `feat(web): General switch for always-show message timestamps`.
