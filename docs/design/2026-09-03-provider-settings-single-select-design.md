# One dropdown in the provider settings form — design

**Date:** 2026-09-03 · **Branch:** `fix/provider-settings-single-select`

## Goal

`ProviderSettingsForm.tsx` renders two dropdowns: the fork's native `<select>` when an annotation
has `options`, and upstream's Base UI `ProviderSettingsSelect` when it has `control: "select"`.
Keep one.

Baseline @ 8537c8bad: `grep -c 'field.control === "select"\|formAnnotation.options !== undefined'
apps/web/src/components/settings/ProviderSettingsForm.tsx` → 3 (two render branches plus the
builder site); the `grid` variant renders `outputStyle` as free text. Target: one branch, both
fields (`ClaudeSettings.outputStyle`, `AntigravitySettings.authMethod`) render through it in all
three variants, `outputStyle` can still be cleared.

## Premise, checked by running it

The fork chose the native `<select>` in `69212ea7e` because Base UI's `Select` reports `""` as
"no selection" (`select/store.js:20-33`, `stringifyAsValue(value) !== ''`) and the earlier
design inferred that a sentinel would be needed. That inference was never run. Run in real
Chromium (Vitest browser mode, `@base-ui/react@1.5.0`, a verbatim copy of
`ProviderSettingsSelect`): with items `""` and `"Concise"` and the key absent, the trigger shows
the empty item's label and the row is `aria-selected="true"`; clicking `Concise` writes
`{ outputStyle: "Concise" }`; clicking the clear row writes `""`, which
`nextProviderConfigWithFieldValue` + `clearWhenEmpty` turn into an omitted key. Written shapes
are byte-identical to today's. The one visible difference: an unset `outputStyle` carries
`data-placeholder`, so "Use ~/.claude/settings.json" renders in the muted placeholder colour
rather than the foreground. That is adopted as the behaviour — unset reads as unset.

jsdom cannot drive an open Base UI popup (the event loop wedges); `renderToStaticMarkup` emits
the trigger and a hidden input but no popup rows. Tests below are shaped around that.

## This is also a bug fix

The `grid` variant of the form (`ProviderSettingsForm.tsx:274-343`) never reads
`field.options`, so on Settings → Providers (`ProviderInstanceCard.tsx:962`, the main place an
existing Claude instance is edited) `outputStyle` renders as a free-text input today. That is
exactly the failure the fork's own comment says the closed set exists to prevent: a typed value
no driver accepts persists and silently does nothing. The single `control: "select"` branch
already covers `grid`.

## Approach

Keep upstream's `ProviderSettingsSelect`; delete the fork's native branch.

- `packages/contracts/src/settings.ts` — `ClaudeSettings.outputStyle` gains `control: "select"`
  and keeps its options with the `{ value: "", label: "Use ~/.claude/settings.json" }` row
  first. Rewrite the `options` doc comment to one semantic: a dropdown over exactly these
  choices; the first entry is the default and is stored as an omitted key; an optional field
  puts its "clear" row first.
- `apps/web/src/components/settings/ProviderSettingsForm.tsx` — remove the
  `field.options !== undefined` native branch; the `options` spread in the field-model builder
  becomes upstream's `control === "select"` one; drop the then-unused `ChevronsUpDownIcon` import;
  rewrite the `ProviderSettingsFieldModel.options` comment (`:30-35`). **Keep
  `selectedOptionValue`** and feed it to `ProviderSettingsSelect` as the current value: the form
  reads the raw `config` blob (`Schema.Unknown`), so a hand-edited or newer-build value such as
  "Creative" survives on disk while `catchDecoding` recovers it to `""` at spawn — showing the
  raw string would claim a style the driver is not using; the helper shows what the driver will
  do. Its existing tests (`ProviderSettingsForm.test.ts:100-118`) stay, comment reworded from
  "native select" to the placeholder row.
- `apps/web/src/components/ui/input.tsx` — `inputControlClassName` / `inputControlShellClassName`
  stay in use inside the file; their exports (`:87`) go dead and the comment at `:14-19` that
  names "a native `<select>`" as the reason to export them is rewritten. Unexport.
- Tests: `ProviderSettingsForm.render.test.tsx` (fork-only; upstream has no render test for
  this form) asserts native `<select>`/`<option>` markup. Static markup of Base UI's Select has
  no rows, so the per-option and selected-row assertions cannot be ported; they are replaced by
  `ProviderSettingsForm.test.ts`'s field-model assertions (option list, `selectedOptionValue`).
  The render test keeps what static markup can show: one `role="combobox"` trigger with the
  field's `aria-label` in **all three** variants including `grid` (the bug fix), the placeholder
  label when unset, and no `<select` element anywhere. Contracts `outputStyle` round-trips are
  unchanged.
- `docs/design/2026-08-28-claude-output-style-design.md` §3 and `:141-145` argue for the native
  select on the falsified inference; add a superseded-by note pointing here. `docs/fork/README.md`
  gets a new short entry (there is none today): the form has one dropdown, upstream's; a
  reconcile must not restore the native one.

## Surfaces

Web and desktop share the form. Mobile has no provider settings form (verified by the
reconcile-28 explore: annotations live only in contracts; the mobile app does not render them).
Reverse state: choosing the first row clears the key, same as before.

## Alternatives rejected

- Keep the native select, drop upstream's: works, but diverges from upstream on a file upstream
  edits often, and the only reason for it was a premise that turned out false.
- Keep both, route by `control`: the state the merge left; two chromes for one control.

## Tests to add

- Render: `outputStyle` renders one combobox whose displayed label is the clear row when the key
  is absent; selecting a style writes it; selecting the clear row omits the key (unit-level via
  `nextProviderConfigWithFieldValue`).
- Guard: no `<select` element in the rendered form for any annotated field.

## Review exit

One combined 6a/6b round (pillars + correctness, simplicity, compatibility), built and run in
Chromium: CONDITIONAL GO. Applied all six must-fixes: the correct Base UI constant and the
placeholder colour decision, the grid-variant bug fix named, `selectedOptionValue` kept with
its rationale, the render-test coverage accounted for, the doc claims corrected, the cleanup
list completed. Rejected: none.

## Follow-ups deferred

None.
