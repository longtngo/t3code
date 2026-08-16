# Local Models settings tab (GUI for `localModels`) — 2026-06-18

## Goal

Make the sidebar local-model manager's configuration (`ServerSettings.localModels` —
mlx-serve + ds4 engines) editable from a **new Settings tab**, instead of hand-editing
`settings.json`. Deferred follow-up from the ds4 engine work
([[ds4-local-model-engine-merged]]). Prototype approved by the user
(`~/reports/t3code/2026-06/2026-06-18-local-models-settings-prototype.html`): args as
removable chips, RAM budget in GB with `0 = auto`, ds4 enable gating, and a read-only
discovered-models mirror per engine.

## Validated premises (Hard Rule 8)

- **`localModels` is client-visible.** It lives in `ServerSettings.fields`, so
  `useSettings()` (which merges server+client settings) exposes `settings.localModels`,
  including the nested `ds4` block (this branch is off `personal` @ f1cc2c11b which shipped
  ds4). ✓ (read `apps/web/src/hooks/useSettings.ts`)
- **Write path needs a contract change (design review CRITICAL).** `localModels` is a
  `ServerSettings` field, but it is **NOT** in `ServerSettingsPatch` (the RPC wire contract
  for `server.updateSettings`). As-is, `updateSettings({localModels})` optimistically
  updates the local atom but the server decoder strips the unknown key → **nothing
  persists**. Fix: add `localModels` to `ServerSettingsPatch` as a **whole-object
  replacement** entry (`Schema.optionalKey(LocalModelsSettings)`), mirroring the existing
  `providerInstances` precedent (settings.ts:587-591), and handle it as a replacement in
  `applyServerSettingsPatch` (serverSettings.ts:104-110): `...(patch.localModels !== undefined
? { localModels: patch.localModels } : {})`. `applyServerSettingsPatch` is a `deepMerge`,
  so a _replacement_ entry (not a merge) is required — otherwise removing a `perModel` /
  `ds4.perModel` key would never persist (deepMerge adds/overwrites, never deletes). The web
  always sends the **full** `localModels` object (read-modify-write from the current value),
  exactly as it does for `providerInstances`. ✓ (mechanism corrected by design review)
- **Discovered-models stream is reusable from the settings page.**
  `usePrimaryEnvironmentId()` + `useLlmModels(envId, envId != null)` are app-global hooks
  (the sidebar uses them). When no primary env exists, the mirror is simply omitted. ✓
- **Routing is file-based.** A `routes/settings.local-models.tsx` file auto-registers
  `/settings/local-models` (TanStack generates the route tree); the nav adds one item. ✓

## Approach

### Route + nav (one new section, mirrors the others exactly)

- `apps/web/src/routes/settings.local-models.tsx` — `createFileRoute("/settings/local-models")`
  lazy-loading `LocalModelsSettingsPanel` from `SettingsPanels`, identical shape to
  `settings.providers.tsx`.
- `SettingsSidebarNav.tsx` — add `"/settings/local-models"` to the `SettingsSectionPath`
  union and a `SETTINGS_NAV_ITEMS` entry `{ label: "Local Models", to, icon: CpuIcon }`
  (CpuIcon matches the sidebar's local-models section), placed after Providers.

### `LocalModelsSettingsPanel` (own file `LocalModelsSettings.tsx`)

Lives in its **own file** `apps/web/src/components/settings/LocalModelsSettings.tsx`
(design review: every non-trivial panel — Connections/Diagnostics/Keybindings/SourceControl
— is its own file; only the smallest legacy panels share the already-1469-line
`SettingsPanels.tsx`, which was _just_ split for lazy-loading). The route lazy-imports it.

Reuses `SettingsPageContainer` / `SettingsSection` / `SettingsRow` / `SettingResetButton`
(from `settingsLayout.tsx`) — same vocabulary as every other panel. Reads via
`useSettings((s) => s.localModels)`; writes via a small local helper:

```ts
const lm = useSettings((s) => s.localModels);
const { updateSettings } = useUpdateSettings();
const patchLm = (next: Partial<LocalModelsSettings>) =>
  updateSettings({ localModels: { ...lm, ...next } });
const patchDs4 = (next: Partial<Ds4Settings>) =>
  updateSettings({ localModels: { ...lm, ds4: { ...lm.ds4, ...next } } });
```

Sections:

1. **Memory budget** — one row. A **GB number input** bound to `ramBudgetBytes`
   (`bytes → GB` for display = `bytes / 1e9`, `GB → bytes` on commit = `Math.round(gb * 1e9)`;
   `0` stays the auto sentinel). Reset → `DEFAULT_UNIFIED_SETTINGS.localModels.ramBudgetBytes`
   (0). Status line shows live `ramUsedBytes / ramBudgetBytes` + system memory from the
   `useLlmModels` sample when available (best-effort; omitted if no sample).
2. **mlx-serve engine** — rows: Models directory (`modelsDir`, text + reset), Default
   launch args (`defaultArgs`, **chip editor**), an advanced `<details>` for `perModel`
   overrides, and the read-only **discovered-models mirror** (the engine's models from the
   `useLlmModels` sample, online dot + port + size).
3. **DeepSeek V4 engine (ds4)** — an enable **Switch** in the section header bound to
   `ds4.enabled`; the card dims (and inputs disable) when off. Rows: Server binary
   (`ds4.binaryPath`), Models directory (`ds4.modelsDir`), Default launch args
   (`ds4.defaultArgs`, chip editor), advanced `perModel`, discovered-models mirror.

### Components added (small, local to the settings folder)

- **`ArgsChipEditor`** — renders `readonly string[]` as removable chips + an "add" affordance
  (a tiny inline text input that commits a token on Enter/blur). One arg = one array element
  (no shell-split). Used by both engines and per-model overrides. Disabled-state aware.
- **`DraftInput`** reuse — the commit-on-blur text input at `components/ui/draft-input.tsx`
  (`{ value, onCommit }`), already used by the General panel for `addProjectBaseDirectory`.
  Directory/binary fields use it directly so they commit on blur/Enter, not per keystroke.
  (Design review: the component is `DraftInput`, not "CommitTextInput".)
- **`GbNumberInput`** — a thin wrapper over `DraftInput` (or its commit-on-blur primitive)
  with the bytes↔GB mapping (`bytes/1e9` display, `round(gb*1e9)` commit; `0` = auto). The
  pure mapping lives in `*.logic.ts` and is unit-tested.
- **`PerModelOverrides`** — advanced (`<details>`) list: rows of `(modelId text,
ArgsChipEditor, remove)` + "Add override", editing the `perModel` record. Kept in v1
  (the user approved the prototype with it) but behind the advanced disclosure, with the
  discovered-models mirror directly above so ids can be copied; a discovered-model **picker**
  for the key is the deferred follow-up that de-footguns it.
- **`DiscoveredModelsList`** — read-only; filters the `useLlmModels` sample's provider whose
  `name === engineId` and lists its models. **Reuses a shared presentational helper** —
  extract `ModelStatusDot` / `ModelMeta` / the `DOT_CLASS` status→color map out of
  `SidebarLocalModels.tsx` (into `lib/llmModels` or a sibling) so the sidebar and this mirror
  share one copy and can't drift (design review).

### Save semantics

Each control commits on a natural boundary (blur / Enter / toggle / chip add-remove) and
calls `patchLm`/`patchDs4`, which optimistically updates server state and fires the
`server.updateSettings` RPC — identical to every existing settings control. No explicit
"Save" button (consistent with the rest of Settings; the prototype's "changes save
automatically" line stays).

## Files touched

**Contract/shared (required — design review CRITICAL):**

- `packages/contracts/src/settings.ts` — add `localModels: Schema.optionalKey(LocalModelsSettings)`
  to `ServerSettingsPatch` (whole-object replacement, like `providerInstances`).
- `packages/shared/src/serverSettings.ts` — add the `localModels` replacement to
  `applyServerSettingsPatch`'s `nextWithReplacements`.

**Web:**

- `apps/web/src/routes/settings.local-models.tsx` (new) — lazy-loads `LocalModelsSettings`.
- `apps/web/src/routeTree.gen.ts` — regenerated by the TanStack vite plugin (run dev/build
  once); commit the generated diff. Not hand-edited.
- `apps/web/src/components/settings/SettingsSidebarNav.tsx` — `CpuIcon` import (add it to the
  `lucide-react` import), nav item, and `"/settings/local-models"` in `SettingsSectionPath`.
- `apps/web/src/components/settings/LocalModelsSettings.tsx` (new) — the panel + the
  `ArgsChipEditor` / `GbNumberInput` / `PerModelOverrides` / `DiscoveredModelsList` pieces.
- `apps/web/src/components/settings/LocalModelsSettings.logic.ts` (+ `.logic.test.ts`) — pure
  helpers (bytes↔GB, arg add/remove) for unit tests.
- `apps/web/src/lib/llmModels.ts` (or a sibling) + `SidebarLocalModels.tsx` — extract the
  shared `DOT_CLASS` / `ModelStatusDot` / `ModelMeta` so both consumers share one copy.
- Tests: `.logic.test.ts`; a browser test mirroring `SettingsPanels.browser.tsx` for render +
  one save round-trip.

Reset defaults (from the schema, design review): `modelsDir` `~/llm/models`, `ramBudgetBytes`
`0`, `defaultArgs` **`["--reasoning-budget","0"]`** (not `[]`), `perModel` `{}`; `ds4`
`{enabled:false, binaryPath:"ds4-server", modelsDir:"~/ds4/gguf", defaultArgs:[], perModel:{}}`.
Use `DEFAULT_UNIFIED_SETTINGS.localModels` as the source of truth for resets.

## Alternatives considered

- **Add a section to the existing Providers tab** rather than a new tab. Rejected — the
  user explicitly asked for a new tab, and local engines are conceptually distinct from the
  cloud/agent providers (codex/claude/…).
- **Raw text field for args** (space-split). Rejected (user chose chips) — ambiguous for
  args containing spaces; chips map 1:1 to argv tokens the manager passes.
- **A JSON textarea editor** for the whole `localModels`. Rejected — defeats the purpose
  (the user wants a GUI, not a prettier JSON box); no validation/affordances.
- **Live "Save" button with dirty-state.** Rejected — inconsistent with the rest of
  Settings, which auto-commits per control.
- **Discovered-models list omitted.** Rejected (user chose to include it) — it grounds the
  config in what's actually on disk.

## Tradeoffs & limitations

- **Whole-`localModels` write per edit.** Each control sends the full object. Concurrent
  edits from two clients last-writer-wins on the whole `localModels` blob (same as any other
  object-valued setting; acceptable for a single-user local tool).
- **`perModel` keys are free-text modelIds.** No dropdown of discovered models in v1 (could
  add later); a typo'd key is simply inert until a matching model exists.
- **GB rounding.** `ramBudgetBytes` round-trips through GB (`*1e9`), so a hand-edited
  byte-precise value is rounded to the nearest GB on the next GUI commit. Acceptable for a
  RAM budget; documented in the field help.
- **Discovered mirror needs a primary environment.** On a fresh app with no environment, the
  mirror is omitted; config still fully editable.

## Follow-ups deferred

- `perModel` model-id picker sourced from discovered models.
- Inline validation (e.g. warn if a dir doesn't exist) — the manager already degrades
  gracefully, so this is cosmetic.
- A "test / dry-run launch" affordance per engine.
