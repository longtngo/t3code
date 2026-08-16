# Collapsible composer context strip

## Problem

The composer context strip (`BranchToolbar`) renders a full-width row under the composer showing
the workspace ("Local checkout" / "Worktree") and the branch. It is unconditional whenever the
thread has a project and git controls, and it costs vertical space on every thread. On a phone that
space is the scarcest thing on screen.

## What is being built

An **icon-only disclosure toggle** in the composer footer that collapses and restores the strip,
with the choice persisted per device.

Three prototype variants were built and reviewed with the developer
(`~/reports/t3code/2026-08/2026-08-16/2026-08-16-composer-context-strip-collapse-prototype.html`).
The icon-only toggle was chosen over a labelled branch chip for a reason worth recording, because
it inverts the obvious answer:

A labelled chip looks better until you type a real branch name. `useLabelsOverflow` already
measures the strip and sets `data-compact` on it, at which point every label animates to
`max-w-0` / `opacity-0` and the controls become icon-only; labels are separately capped at
`max-w-[240px]` with `truncate`. So on a phone with a 45-character branch, **today's UI already
shows nothing but a glyph**. A labelled chip in the footer would reach the same place while also
competing with the model picker for horizontal room. The icon-only toggle costs a fixed ~28px at
every name length.

## Design

### State

One client setting, `composerContextStripCollapsed`, default `false` (today's behaviour, so nothing
changes for anyone until they press the button).

Client settings persist to `localStorage` (`apps/web/src/hooks/useSettings.ts`), which means the
setting is **already per-device**. A phone and a laptop hold independent values, so "collapsed on
my phone, expanded on my desktop" falls out of a single boolean with no viewport-dependent default
and no second key. This is the whole reason the setting is client-side rather than server-side.

Reads follow the `useLegacySidebarEnabled` precedent exactly:

```ts
collapsed = clientSettingsHydrated && settings.composerContextStripCollapsed;
```

Holding at the default until hydration means the majority (expanded) never sees a shift, and users
who opted into collapsed see the strip resolve once on load rather than the whole tree remounting.
Mirroring the existing hook keeps one rule in the codebase instead of two.

### Placement

The toggle sits at the **end of the footer's left control group**, after the mode controls or the
`···` compact menu, marked `shrink-0`.

Not the right-hand group, even though the approved prototype drew it there: that group is Stop and
Send, and on a phone a secondary control adjacent to Send is a mis-tap waiting to happen. The left
group is `overflow-x-auto` and the model picker is `flex: 0 1 auto`, so the model name shrinks
before the toggle does and the toggle cannot scroll out of reach.

### The icon carries state

The button renders a workspace glyph drawn from the same family `MobileRunContextSelector` uses:
`FolderGitIcon` when the thread runs in a worktree, `FolderIcon` for a local checkout. This is the
one signal that survives to zero label width, and it costs no new query — `envMode` and
`activeWorktreePath` are already resolved in `ChatView`.

Two icons, not the selector's three. The selector distinguishes "will create a worktree" from
"already in one" because it is the control that makes that choice; a collapsed strip only has to
answer "is this the ordinary place", so the extra state would be a distinction without a decision.

**Explicitly out of scope:** accenting the icon when the branch differs from the repository default.
That needs the ref list (`refs.find(r => r.isDefault)`, `BranchToolbarBranchSelector.tsx:491`),
which is loaded inside the branch selector's combobox. Pulling a refs query up into the composer
footer for every thread is a real cost on a surface this repo watches closely, and it is separable.
Recorded as a follow-up rather than smuggled in.

### Reverse state

The same button toggles both ways and carries `aria-expanded` plus `aria-controls` pointing at the
strip. Collapsed: "Show workspace". Expanded: "Hide workspace".

Two states render no footer at all: the collapsed mobile prompt row
(`showCollapsedMobilePromptRow`) and the mobile pending-answer path (`hidden sm:flex`). The toggle
is unreachable there, but so is every other footer control; the persisted state still applies and
expanding the composer brings the toggle back. No new one-way door.

### Shell coupling

`chat-composer-glass-shell-with-context` is what reserves the `2.25rem` extension and clips the
composer's bottom edge so the strip can dock into it. It must follow the _rendered_ strip, not the
_available_ strip, or a collapsed strip leaves a notch cut out of the composer for nothing.

## Surfaces

- **Web / desktop** — the change. Desktop keeps today's default (expanded) and gains the same toggle
  as a density option.
- **Mobile (React Native)** — no equivalent strip exists in `apps/mobile`, so there is nothing to
  mirror. "Mobile" in the request meant the narrow web viewport.
- **Contracts** — one new optional client-settings key; no server, no wire protocol, no migration.
- **Providers** — not provider-shaped.

## Testing

- Contracts: the new key decodes to `false` by default and round-trips through the patch schema.
- Logic: `shouldRenderComposerContextStrip` — available and not collapsed, and hidden either way
  when no strip applies.
- Component: `aria-expanded` tracks the strip, `aria-controls` names it, the label states the
  direction, and the worktree glyph differs from the local-checkout one.

Each test is proven by inverting the thing it covers and confirming it goes red first.

**Not covered, deliberately.** The web unit project renders with `renderToStaticMarkup` and has no
DOM, so the click path (button → `updateClientSettings` → re-render) has no cheap test; the
`!collapsed` write it performs is a one-liner in `ChatView`, whose only other exercise would be
mounting `ChatView` itself. Called out rather than papered over with a test of the mock.
