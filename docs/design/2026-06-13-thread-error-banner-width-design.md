# Thread error banner width — 2026-06-13

## Goal

When a thread hits a provider/runtime error (e.g. Codex usage limit), the red
error banner above the chat must be wide enough to read the message. Today the
text collapses into a ~16px column and shows unreadable fragments like
"Yo / hit / y...".

## Root cause

PR #3016 refactored `Alert` from a CSS grid layout to flex with slot-based
child partitioning (`icon` / `content` / `action`). `ThreadErrorBanner` wrapped
`AlertDescription` inside `Tooltip` via `TooltipTrigger`'s `render` prop:

```tsx
<Tooltip>
  <TooltipTrigger render={<AlertDescription />}>{error}</TooltipTrigger>
</Tooltip>
```

`Alert` only recognizes direct children whose `data-slot` (or component
displayName) is `alert-title`, `alert-description`, or `alert-action`. The
`Tooltip` wrapper has none of those, so it is classified as an **icon** and
rendered inside the `size-4 shrink-0` icon column. The error body shares that
16px-wide slot.

`ProviderStatusBanner` was updated in the same PR and does not have this bug
because `AlertTitle` / `AlertDescription` are direct children of `Alert`.

## Approach

Restructure `ThreadErrorBanner` so `AlertDescription` is a **direct child** of
`Alert`, matching `ProviderStatusBanner`. Nest the tooltip inside the
description for full-text hover:

```tsx
<AlertDescription className="line-clamp-3">
  <Tooltip>
    <TooltipTrigger>{error}</TooltipTrigger>
    <TooltipPopup>...</TooltipPopup>
  </Tooltip>
</AlertDescription>
```

No change to `alert.tsx` — the slot model is correct; only the consumer was
wrong.

## Alternatives considered

| Option | Rejected because |
|--------|------------------|
| Teach `Alert` to recurse into wrappers for nested slots | Broader blast radius; hides misuse at call sites |
| Drop tooltip, use native `title` attribute only | Loses styled popup with `max-w-96` + `whitespace-pre-wrap` |
| Add `AlertTitle` ("Runtime error") + description | Out of scope; banner already shows the message body |

## Files touched

- `apps/web/src/components/chat/ThreadErrorBanner.tsx` — layout fix
- `apps/web/src/components/chat/ThreadErrorBanner.test.tsx` — regression guard

## Design review (1 round)

**Correctness:** Fix restores content to `flex-1 min-w-0` column; line-clamp and
tooltip behavior unchanged.

**Simplicity:** Smallest diff — one component, no shared abstraction.

**Compatibility:** Only `ThreadErrorBanner` used the anti-pattern (`grep`
confirmed). Other `Alert` usages place titled/described slots as direct children.

**Exit:** No new findings on re-read.

## Known limitations

- Long errors still clamp to 3 lines in the banner; full text requires hover
  (unchanged from before).

## Follow-ups deferred

- None.
