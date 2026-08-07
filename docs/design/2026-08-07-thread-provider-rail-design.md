# Per-thread provider accent rail — 2026-08-07

## Goal

Make each thread's provider permanently visible in the left-hand projects/threads list, drawn in
that provider instance's own accent colour.

Chosen from a rendered prototype set (variant **A**, accent rail; see
`~/reports/t3code/2026-08/2026-08-07/2026-08-07-thread-provider-indicator-prototypes.html`).
The trailing initials chip from variant F was explicitly rejected by the user as too busy.

## Approach

A 2.5px vertical bar pinned to the left edge of the thread row, filled with the resolved provider
instance's `accentColor`. It costs zero horizontal space, so no existing row content moves, and it
reads as a continuous colour column when sweeping the list.

Shipped on **all three row surfaces**: the v1 row, the v2 slim row, and the v2 card. One shared
component, so no surface can silently lose the indicator.

### Resolution — thread to accent colour

Two pure steps, both unit-tested:

1. **Thread → instance id**, mirroring the precedence the composer already uses
   (`ChatComposer.tsx:742-746`), so the rail can never disagree with the provider the composer
   reports for that thread:

   ```
   thread.session?.providerInstanceId ?? thread.modelSelection.instanceId
   ```

   The composer additionally falls back to the project's `defaultModelSelection`. **That branch is
   unreachable from a thread row and is deliberately omitted:** `OrchestrationThreadShell.modelSelection`
   is non-nullable and `ModelSelectionWire.instanceId` is a required field, so step 2 always yields
   an id. Keeping the fallback would mean a `useProject` lookup per row, in a list, for a branch
   that can never execute. The resolver is therefore total and returns a non-null id.

2. **Instance id → accent**, from the environment's `serverConfig.providers` snapshot list, which
   the row already reaches via `useEnvironment(thread.environmentId)`.

No server change, no contract change, no migration: `modelSelection` is already on
`OrchestrationThreadShell` and `accentColor` is already on the provider snapshot.

### Files

- `apps/web/src/components/threadProviderRail.logic.ts` — the two pure resolvers
- `apps/web/src/components/threadProviderRail.logic.test.ts` — their tests
- `apps/web/src/components/ThreadProviderRail.tsx` — the rail component
- `apps/web/src/components/Sidebar.tsx` — mount (v1 row)
- `apps/web/src/components/SidebarV2.tsx` — mount (slim row + card)

The component takes a `className` for its vertical inset rather than owning three hard-coded
geometries; each surface passes the inset that matches its row height.

## Verified premises (Hard Rule 8)

Probed against live code and the running instance before designing:

| Premise | Probe | Result |
|---|---|---|
| A thread knows its provider client-side | `OrchestrationThreadShell` schema | `modelSelection` present, resolves to a `ProviderInstanceId` — **no backend work** |
| Accent is reachable without settings | read `applyProviderInstanceSettings` | it overlays **`enabled` only**; `accentColor` comes from the provider snapshot, so the rail needs `serverConfig.providers` alone |
| v1 row can host an absolutely-positioned rail | `Sidebar.tsx:678` | row wrapper is `relative isolate`; base class has no `overflow-hidden` |
| v2 row can | `SidebarV2.tsx:762` | `relative … overflow-hidden rounded-md` — clips to the rounded rect, so the rail must be **vertically inset** to stay clear of the corner radius |
| Accent hex is trustworthy | `normalizeProviderAccentColor` | strict `/^#[0-9a-fA-F]{6}$/`, returns `undefined` otherwise — malformed values cannot reach the rail |
| Which sidebar is actually live | `data-sidebar-version` on the running app | **`v1`** — v2 defaults only on `nightly`/`dev`; a v2-only build would be invisible in production |
| Is the project-default fallback reachable? | `OrchestrationThreadShell` + `ModelSelectionWire` | **No** — `modelSelection` is non-nullable, `instanceId` required. Fallback dropped as dead code |
| Do any tests assert row DOM structure? | grep for row test-ids in test files | None — the only hits are fixture ids in `CommandPalette.logic.test.ts`. Adding a child is safe |

## Design review

One round, lenses run inline (correctness / simplicity / compatibility). Findings:

1. **Simplicity — applied.** The project-default branch of the resolver is unreachable (see the
   premise table). Dropped, removing a per-row `useProject` call.
2. **Correctness — confirmed.** `session.providerInstanceId` is `Schema.optional`,
   `modelSelection.instanceId` is required, so the `??` chain is total with no null tail.
3. **Compatibility — confirmed.** No DOM test asserts thread-row structure, so an added child
   breaks nothing.
4. **Correctness — carried into the design.** v2's row surface is `overflow-hidden rounded-md`;
   the rail must be vertically inset or it is clipped by the corner radius.

Exit: the remaining lenses produce only repeats at this size (<200 LOC, three mount points).

## Decisions

**No rail when the instance has no accent colour.** A neutral grey bar on every unconfigured
thread is noise carrying no information. Absence is the honest rendering.

**`pointer-events-none` on the rail.** It sits inside the row's click target; it must never
intercept a row click or a drag.

**`role="img"` + `aria-label="Provider: <name>"`.** A bare coloured sliver is meaningless to a
screen reader. This names the instance at zero visual cost — which also partially covers the
colour-collision limitation below.

## Tradeoffs and known limitations

- **Colour collisions are not resolved.** Three of the user's configured instances (Qwen, Gemma
  4 26B, and Codex/PersonalSub) share `#7c3aed`, so their rails are identical. The variant-F chip
  existed to disambiguate and was deliberately rejected as too busy. The `aria-label` names the
  instance, but a 2.5px bar is not a practical hover target, so visual disambiguation is genuinely
  absent for same-colour instances. Recorded as an improvement suggestion (warn on duplicate
  accents in Settings), not worked around here.
- **No contrast floor.** Accents are free-form user hex; a very dark accent on the dark sidebar
  renders a near-invisible rail. This is a **pre-existing** gap (the same untreated hex already
  drives the provider icon and picker), not one this change introduces, and fixing it properly
  spans every accent surface. Out of scope; listed as a follow-up.
- **v2 card rail length.** Insetting to clear the corner radius means the rail stops slightly
  short of the card's full height. Accepted: the alternative is corner clipping.

## Alternatives rejected

Full comparison with rendered mockups is in the prototype page. In brief:

- **Provider dot (B)** — recolours the existing status dot, overloading a glyph that means *state*.
- **Leading glyph (C)** — identifies the *driver*, but 5 of 7 configured instances are
  `claudeAgent`, so the same mark repeats on nearly every row.
- **Trailing chip (D)** / **rail + chip (F)** — disambiguates colours, rejected by the user as
  too busy.
- **Row wash (E)** — highest visibility, but turns a long list into a patchwork and fights the
  unread/active/selected row backgrounds.
- **Accent-ringed favicon (G, v2 only)** — zero width cost, but conflates *project* and *provider*
  in one glyph.

## Follow-ups deferred

- Warn in Settings when an accent duplicates one already in use, so new collisions are not created
  silently.
- A contrast floor (or fixed-luminance tint base) for user-set accents, applied across every
  accent surface rather than just the rail.
