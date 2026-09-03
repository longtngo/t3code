# One dropdown in the provider settings form — plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** the provider settings form renders every closed-set field through upstream's Base UI `ProviderSettingsSelect`, in all three variants; the fork's native `<select>` branch is gone.
**Spec:** docs/design/2026-09-03-provider-settings-single-select-design.md

## Global Constraints

- Written config shapes unchanged: a chosen style writes `{ outputStyle: "<style>" }`, the clear row omits the key.
- `selectedOptionValue` stays and is what the dropdown displays.
- Run web tests from `apps/web`; contracts tests from `packages/contracts`. Format with `pnpm exec vp fmt <files>` from the root before each commit. No repo-wide checks.

### Task 1: Contract — `outputStyle` becomes a `select` control

**Files:** Modify `packages/contracts/src/settings.ts` (`ClaudeSettings.outputStyle` annotation ~:716-719; `ProviderSettingsFormAnnotation.options` doc comment ~:415-424).

- [ ] Step 1: In `packages/contracts/src/settings.test.ts`, find the `outputStyle` annotation test (grep `outputStyle` near `providerSettingsForm`); add an assertion that the annotation has `control: "select"` and that `options[0]` is `{ value: "", label: "Use ~/.claude/settings.json" }`. Run `cd packages/contracts && pnpm exec vp test run src/settings.test.ts` → the `control` assertion fails.
- [ ] Step 2: Add `control: "select"` to the `outputStyle` annotation, keeping its options. Rewrite the `options` doc comment to the single semantic: "Renders the field as a dropdown over exactly these choices (`control: "select"`). The first entry is the default and is stored as an omitted key; an optional field puts its clear row (`value: ""`) first." Run → green; `pnpm run typecheck`.
- [ ] Step 3: Commit `feat(contracts): outputStyle is a select control`.

### Task 2: One render branch, in all three variants

**Files:** Modify `apps/web/src/components/settings/ProviderSettingsForm.tsx` (builder ~:115; `ProviderSettingsSelect` ~:198-237; grid variant ~:274-343; card/dialog dispatch ~:365-382; native branch ~:400-449; `ProviderSettingsFieldModel.options` comment ~:30-35), `apps/web/src/components/ui/input.tsx` (`:14-19`, `:87`), `apps/web/src/components/settings/ProviderSettingsForm.render.test.tsx`, `apps/web/src/components/settings/ProviderSettingsForm.test.ts` (`:100-118` comment only).

- [ ] Step 1: Rewrite `ProviderSettingsForm.render.test.tsx` first. Replace the `<select>`/`<option>` assertions with, for `it.each(["card", "dialog", "grid"])`: `expect(markup).toContain('role="combobox"')`, `expect(markup).toContain('aria-label="Output style"')` (use the field's real label), `expect(markup).not.toContain("<select")`; one case rendering with no stored style asserting the trigger text contains `Use ~/.claude/settings.json`; keep the existing "text fields do not render a dropdown" case. Run `cd apps/web && pnpm exec vp test run src/components/settings/ProviderSettingsForm.render.test.tsx` → the `grid` case FAILS today (free-text input) — record that line; card/dialog fail on the `<select` guard.
- [ ] Step 2: In `ProviderSettingsForm.tsx`: delete the `field.options !== undefined` native branch and its comment block; make the builder spread `options` only for `control === "select"` (upstream's shape); in `ProviderSettingsSelect` compute `const current = selectedOptionValue(value, field) || fallback` (keep `fallback = options[0]?.value ?? ""`); ensure the `grid` variant dispatches `control === "select"` to `ProviderSettingsSelect` exactly like card/dialog; remove the `ChevronsUpDownIcon` import if now unused and the `inputControlClassName`/`inputControlShellClassName` imports. Rewrite the `options` comment on `ProviderSettingsFieldModel`.
- [ ] Step 3: In `input.tsx`: remove the two names from the export list (`:87`) and rewrite the `:14-19` comment to describe the shell classes' in-file use only. Confirm no other importer: `grep -rn "inputControlShellClassName\|inputControlClassName" apps/web/src` → only `input.tsx`.
- [ ] Step 4: In `ProviderSettingsForm.test.ts:100-118` reword the comment: the dropdown shows the clear row for a value this build does not offer, which is what the driver will do (`catchDecoding` recovers it to unset at spawn). Assertions unchanged.
- [ ] Step 5: `cd apps/web && pnpm exec vp test run src/components/settings/ProviderSettingsForm.render.test.tsx src/components/settings/ProviderSettingsForm.test.ts src/components/settings/ProviderInstanceCard.test.ts && pnpm run typecheck && pnpm exec vp lint src/components/settings/ProviderSettingsForm.tsx src/components/ui/input.tsx` → green.
- [ ] Step 6: Commit `fix(web): one dropdown for provider settings, and a real one in the grid variant`.

### Task 3: Docs

**Files:** Modify `docs/design/2026-08-28-claude-output-style-design.md` (top: a "Superseded" note; §3 and `:141-145` left as history), `docs/fork/README.md` (new short invariant after the last numbered entry).

- [ ] Step 1: Add under the 2026-08-28 design's title: "**Superseded 2026-09-03** by `docs/design/2026-09-03-provider-settings-single-select-design.md`: the native `<select>` is gone; Base UI's Select holds `""` as an ordinary item (run in Chromium), and the placeholder colour marks unset."
- [ ] Step 2: Add to `docs/fork/README.md` a numbered entry "### 27. The provider settings form has one dropdown, upstream's": two sentences — the fork's native `<select>` (`69212ea7e`) was removed on 2026-09-03 after the premise it rested on was measured false; `selectedOptionValue` is fork-only and feeds upstream's `ProviderSettingsSelect`; a reconcile that brings back a `field.options !== undefined` branch is restoring a deleted duplicate.
- [ ] Step 3: `pnpm exec vp fmt` both files; commit `docs: supersede the native-select rationale; registry entry`.
