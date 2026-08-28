# Own the Claude `outputStyle` setting — design

Date: 2026-08-28
Branch: `feat/claude-output-style`

## Goal

Let t3code choose the Claude CLI's **output style** for every session it spawns, as a
user-facing per-instance setting on the Claude provider. An output style is part of the
CLI's _system prompt_, so it carries more weight than injected `CLAUDE.md` context.

Today the only way to set it is `~/.claude/settings.json`, which t3code does not own —
and t3code's own `configDirPath` setting can relocate the Claude config dir out from
under that file.

Default is **unset**: send nothing, no behaviour change for anyone who does not opt in.

## Baseline @ b93716a5a (2026-08-28)

```
outputStyle reaches the spawned claude process
  cmd: ps -axww -o command | grep 'claude --output-format stream-json' | head -1
  out: claude --output-format stream-json ... --settings {"autoCompactWindow":600000}
       (no outputStyle key — absence measured; this is the acceptance test)

outputStyle settable anywhere in t3code
  cmd: grep -rc outputStyle packages/contracts/src/settings.ts \
         apps/server/src/provider/Layers/ClaudeAdapter.ts
  out: 0 and 0

regression floor
  cmd: pnpm verify
  out: EXIT=0 — 14 blocks, 10,260 tests passed, 10 skipped, 0 failed
```

## Premises, validated live (Hard Rule 8)

Measured against the installed CLI (2.1.250), not read from a doc.

| Premise                                                                      | Probe                                                                                                                                         | Result                                                                                         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `--settings` JSON carrying `outputStyle` reaches the system prompt           | `claude -p "Quote the part of your system prompt describing your Output Style" --settings '{"outputStyle":"Explanatory"}' --setting-sources=` | Model returned `# Output Style: Explanatory` plus the full style text. **Confirmed.**          |
| Inline `--settings` wins over the user's `~/.claude/settings.json`           | Same prompt with `--setting-sources=user,project,local` while that file holds `outputStyle: "Concise"`                                        | Returned `Explanatory`. **t3code genuinely owns the value.**                                   |
| The built-in style set is exactly four                                       | `strings <cli> \| grep -oE 'name:"(Concise\|Proactive\|Explanatory\|Learning)"'`                                                              | `Concise`, `Explanatory`, `Learning`, `Proactive`.                                             |
| An invalid value fails loudly in the CLI                                     | `claude -p hi --settings '{"outputStyle":"NoSuchStyleXyz"}'`                                                                                  | rc=0, no warning, silently ignored. **It does not** — which is why t3code must constrain it.   |
| No `--output-style` CLI flag exists (so `launchArgs` cannot already do this) | `claude --help \| grep -i style`; `strings <cli> \| grep -oE '"--?output-style[a-z-]*"'`                                                      | No flag. `--settings` is the only route. **Not already shipped by another mechanism.**         |
| The SDK's `Settings` type accepts the key                                    | `grep -n outputStyle apps/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`                                                        | `:5574  outputStyle?: string;`                                                                 |
| The provider settings form is a web-only surface                             | `grep -rln providerSettingsForm apps/mobile/src apps/web/src packages/client-runtime/src`                                                     | Four hits, all under `apps/web/src/components/settings`. Mobile has no provider settings form. |

## Approach

Clone `autoCompactWindow` — the existing example of exactly this shape — and change
nothing else. No new form control, no new form-contract surface.

### 1. Contracts — `packages/contracts/src/settings.ts`

```ts
export const CLAUDE_OUTPUT_STYLES = ["Concise", "Explanatory", "Learning", "Proactive"] as const;
const CLAUDE_OUTPUT_STYLE_PATTERN = new RegExp(`^(?:|${CLAUDE_OUTPUT_STYLES.join("|")})$`);
```

One source of truth for the four names.

- **`ClaudeSettings.outputStyle`** — `TrimmedString.check(isPattern(...))`, decoding
  default `""`, and `Schema.catchDecoding(() => Effect.succeed(Option.some("")))`.
  The handler must be exactly that shape: it takes an `Effect<Option<T>>`, and the
  shorthand `() => ""` neither typechecks nor fails safely — forced through, it _Dies_
  and takes the whole `ServerSettings` decode with it, which `loadSettingsFromDisk`
  (`apps/server/src/serverSettings.ts:472-483`) answers by keeping
  `DEFAULT_SERVER_SETTINGS` and writing them back, costing the user every provider path
  permanently.
- **`ClaudeSettingsPatch.outputStyle`** — the same pattern check with **no**
  `catchDecoding`, so a typo fails that one update with a schema error instead of a
  generic whole-settings failure. That is the precedent the existing comment at the
  patch boundary states.
- **`order`** — insert `"outputStyle"` after `"autoCompactWindow"`.

Empty string is inside the pattern, so clearing works through the same path
`autoCompactWindow` already uses (`clearWhenEmpty: "omit"`).

**What `catchDecoding` is and is not for.** It is _not_ the mechanism that lets an older
build read a settings file written by a newer one — Effect Schema's default
`onExcessProperty: "ignore"` already drops a key the old build has never heard of, and
that was measured in both directions. `catchDecoding` protects _this_ build against a
value outside its own pattern: a fifth built-in style added by a future Claude Code, or
garbage. Without it that one value fails a decode, and the two blobs fail _differently_:

- on `providers.claudeAgent` (typed `ClaudeSettings`) it fails the whole `ServerSettings`
  document, and `loadSettingsFromDisk` answers that by keeping `DEFAULT_SERVER_SETTINGS`
  and writing them back — measured: a custom `binaryPath` reverted to `"claude"`;
- on `providerInstances.*.config` (`Schema.Unknown`, the blob the form actually writes) it
  fails the per-driver decode at `ProviderInstanceRegistryLive.ts:146-166`, which marks
  the whole Claude instance **unavailable** with `Invalid config for instance '<id>'`.

Both are worse than recovering to `""`, so the handler stays.

### 2. Adapter — `apps/server/src/provider/Layers/ClaudeAdapter.ts` (~:4861)

```ts
const settings = {
  ...,
  ...(autoCompactWindow ? { autoCompactWindow } : {}),
  ...(claudeSettings.outputStyle ? { outputStyle: claudeSettings.outputStyle } : {}),
};
```

Conditional spread, omitted entirely when unset, matching the surrounding lines. The
existing `Object.keys(settings).length > 0` guard means an all-unset settings object
sends no `--settings` flag at all.

**Observability is already free.** `ClaudeAdapter.ts:4949` records
`"claude.query.settings_json": encodeJsonStringForDiagnostics(settings)` on the session
span, so the chosen style shows up in session diagnostics with no new instrumentation.

### 3. Form — a native `<select>`, branched on `options`

The settings form must not be able to produce an invalid value, because **nothing
downstream rejects one**. The form writes `providerInstances.<id>.config`, which is
`Schema.optionalKey(Schema.Unknown)` (`packages/contracts/src/providerInstance.ts:130`),
and editing the default instance _resets_ the legacy blob
(`SettingsPanels.logic.ts:261-273`). `ClaudeSettingsPatch` therefore never sees a value
typed into the form. Measured end to end: a user types `concise`, it persists, the field
displays `concise` back, the registry decode recovers it to `""` as a **success** so
nothing logs, and the CLI receives no style at all. That is the same silent-no-op class of
bug this feature exists to fix.

So:

- add `options?: readonly { readonly value: string; readonly label: string }[]` to
  `ProviderSettingsFormAnnotation`, and the same field to `ProviderSettingsFieldModel`;
- copy it through in `deriveProviderSettingsFields`, which today copies only `control`,
  `placeholder`, `clearWhenEmpty`, and the switch default;
- render a native `<select>` in `ProviderSettingsFieldRow` **when `field.options` is
  present**, styled with the same classes as `Input`.

**No new `ProviderSettingsFormControl` member.** Branching on the data rather than on a
new union tag is what keeps this from becoming a second `folder` — a control type that is
declared at `settings.ts:495` and has no render branch, so it silently renders a text box
today. A union member can be half-wired; a branch on `options` cannot be.

A native `<select>` also represents unset as `""` directly. The repo's Base UI `Select`
cannot: `hasSelectedValue` returns false for `""`
(`apps/web/node_modules/@base-ui/react/select/store.js:20-33`), so it would need a
non-empty sentinel mapped back to `""` on store, and its click path could not be confirmed
in a probe.

The empty option must not be labelled _Claude's default_: `--setting-sources` is still
`user,project,local`, so leaving it unset hands control to the user's own
`~/.claude/settings.json`, not to Claude's built-in default. Label: **"Use Claude's own
setting"**.

## Alternatives rejected

Measured, not argued. All four arms were built and executed against the real repo files
and the real `@base-ui/react`; the form-layer diff is against the current tree.

| Arm                                         | Form-layer diff | Invalid value reachable from the UI?             |
| ------------------------------------------- | --------------- | ------------------------------------------------ |
| Text input (clone `autoCompactWindow`)      | +23/−1          | **yes** — persists, displays back, sends nothing |
| Base UI `Select` + `"select"` union member  | +71/−2          | no, but needs a non-empty sentinel               |
| **Native `<select>` branched on `options`** | **+60/−1**      | **no**                                           |
| `<input list=…>` datalist                   | +64/−1          | **yes** — still a text box                       |

- **Text input.** The cheapest arm, and the one the first draft of this design chose, on
  the argument that `ClaudeSettingsPatch` rejects a typo at save time. That argument is
  false for the path the form uses (see §3), so this arm ships the silent no-op.
- **Base UI `Select` with a `"select"` union member.** Costs more than the native
  element, needs a sentinel because the widget cannot hold `""`, and adds a union member
  that can be half-wired. Its `onValueChange` path could not be confirmed under happy-dom.
- **Datalist.** Suggests the four names but remains a free text field; the typo persists.
- **`launchArgs` with an `--output-style` flag.** Falsified — no such flag exists in
  2.1.250. This is why the task exists.
- **Hardcode `Concise`.** Changes behaviour for every user of the fork without a choice.
- **Warn instead of preventing.** A log inside `catchDecoding` cannot reach the settings
  form, which reads the raw `Unknown` blob and never runs this schema; and the recovery is
  a _successful_ decode, so the registry's existing error log does not fire either.
  `packages/contracts` is also specified as "no heavy runtime logic". The silent part is
  the UI showing a value that does nothing, and only the UI can fix it.
- **Enumerate custom (user-authored) styles.** `~/.claude/output-styles/` does not exist on
  this machine, and reading it needs a server-side scan plus an RPC to feed the form.
  Follow-up, not scope.

## Files touched

- `packages/contracts/src/settings.ts` — `CLAUDE_OUTPUT_STYLES`, pattern, `ClaudeSettings`
  field, `ClaudeSettingsPatch` field, `order`, `options` on
  `ProviderSettingsFormAnnotation`
- `packages/contracts/src/settings.test.ts` — decode default, accepted values, recovery,
  patch accept/reject
- `apps/web/src/components/settings/ProviderSettingsForm.tsx` — `options` on
  `ProviderSettingsFieldModel`, copied through `deriveProviderSettingsFields`, native
  `<select>` branch
- `apps/web/src/components/settings/ProviderSettingsForm.test.ts` — the Claude field key
  list is an exact-equality assertion and gains `"outputStyle"`; plus a new assertion that
  the field carries the four options and the unset row, since the key list alone would
  pass on a half-wired control
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` — conditional spread
- `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` — style set, and style unset
  asserted with `Object.hasOwn(settings, "outputStyle") === false`. A falsy check would let
  an unconditional-spread mutation survive and start sending `{"outputStyle":""}`.

Three further literals gain `outputStyle: ""`. Only the first is a typecheck failure; the
other two are untyped `assert.deepEqual` expected values that fail at runtime:

- `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts:112` (typed
  `ClaudeSettings`)
- `apps/server/src/serverSettings.test.ts:237`
- `apps/server/src/serverSettings.test.ts:875`

## Tradeoffs and limitations

- **The style list is pinned to CLI 2.1.250.** A fifth built-in will not be offered until
  the constant is updated. `catchDecoding` makes that a recovered value rather than a
  broken settings file or an unavailable provider instance.
- **Custom output styles are not selectable.** Follow-up.
- **Unset means "whatever the config files say", not "Claude's default"** — see §3.
- **The patch schema is not the UI's gate.** It still guards a hand-written
  `providers.claudeAgent` patch and the legacy blob, which is worth having, but the
  dropdown is what actually protects the form. A hand-edited `settings.json` can still
  carry a bad value; it recovers to `""`.
- **A padded name is accepted, not rejected.** `TrimmedString` runs before the pattern, so
  `" Concise "` decodes to `"Concise"` and works — whereas the raw CLI would ignore it.
  That is the friendlier behaviour and is left as is.
- **Mixed client/server versions are handshake-safe.** New server + old web: the field is
  invisible (the form is schema-driven from the client's bundled schema) and editing
  another field does not drop the value, because the config blob is copied wholesale. Old
  server + new web: the value is accepted and stored but stripped at the old server's
  per-driver decode, so it is a no-op until the server is upgraded. Mobile has no provider
  settings form and is unaffected.
- **A downgrade keeps the value where the UI writes it.** An older build that decodes and
  re-encodes `ServerSettings` strips `providers.claudeAgent.outputStyle` but preserves
  `providerInstances.*.config.outputStyle`, which is the blob the form writes — so a
  downgrade-then-upgrade keeps the setting for anyone who set it through the UI, and loses
  it for anyone who hand-edited only the legacy block.
- **No live-session effect.** Read at session spawn; changing it does not restyle a running
  session. Consistent with every other setting in this object.

## Follow-ups deferred

- Enumerate custom styles from `~/.claude/output-styles/` (needs a server read + RPC).
- `providerInstances.*.config` is `Schema.Unknown` and is never validated on save, for any
  provider. Every driver's settings therefore accept arbitrary values from the form and
  fail (or silently recover) only at spawn. That is a deliberate design — config is
  driver-specific and validated at use — but it means per-field UI constraints are the only
  real guard. Worth a separate look at validating the blob against the driver's
  `configSchema` at the update RPC.
- `launchArgs` is set in the live settings file but was absent from the running session's
  argv — worth confirming that path still flows, separately from this change.

## Review exit note

Round 1: 6a pillar sweep (`CONDITIONAL GO`) plus Correctness, Simplicity, and
Compatibility lenses, all dispatched to build and run the design rather than read it.
Security & privacy was not run: the change adds no entry point, no trust boundary, no
dependency, and no personal data — a closed enum written by the machine's owner.

Round 2 re-ran all three lenses against the revision. Compatibility returned `GO`;
Simplicity found no blockers; Correctness returned **`NO-GO`**, having proved that the
patch-boundary validation this design leaned on never runs on the path the settings form
actually writes. That falsified the reason the `select` had been dropped in round 1, so the
control choice was reopened.

Round 3 settled it with a pre-registered decision rule — _the cheapest arm that makes an
invalid value unreachable from the UI_ — by building and executing all four arms. The
native `<select>` won on both halves of that rule, and the reviewer that recommended it is
also the one that built and ran it, so the chosen form path has been implemented once
already outside this repo.

Applied across the three rounds: the `catchDecoding` blocker and its corrected rationale
(two different failure modes, neither of them the old-build path), the three missing
literals and the correction that only one of them is a typecheck failure, the dropped
`CLAUDE_OUTPUT_STYLES` constant — since **reinstated**, because the form options are now a
real second consumer — the `Object.hasOwn` assertion that closes a surviving mutation, the
mixed-version bullet, the downgrade bullet, and the observability sentence.

Round 4 was not run: round 3 produced a decision rather than new defects, and the form path
it chose was itself built and executed rather than reviewed on paper.
