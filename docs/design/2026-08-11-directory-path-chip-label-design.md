# Directory path chips render with no label

## Goal

A path written as a directory — `/Users/x/reports/2026-08/engine-comparison-prototype/` — chips
with a folder icon and **no text at all**. The chip is a blank square with a dropdown arrow. Give
it the folder's name, on every surface that turns a path into a label.

## Root cause

Basename extraction assumed a filename. Four near-copies of the same helper took "the text after
the last separator" with no trailing-separator handling, so a directory path yielded `""`:

| Site | Consumer |
| --- | --- |
| `markdown-links.ts` `basenameOfPath` | `MarkdownFileLinkMeta.basename` → the chip label, and the copy-as-markdown text `[](href)` |
| `pierre-icons.ts` `basenameOfPath` | the composer inline chip label, the `@`-path menu label |
| `ChatMarkdown.tsx:1319` | the chip menu's `title` / `aria-label` ("View options for ") |
| `RightPanelTabs.tsx` `surfaceTitle` | the file-viewer tab title |

Probed directly rather than inferred: `basenameOfPath("…/engine-comparison-prototype/")` → `""`,
which is also why the icon was right. `inferEntryKindFromPath` asks "does the last segment contain
a dot", and `""` does not, so it answered "directory" — correct by accident.

## Approach

One directory-aware helper, `basenamePathSegment`, in `filePathDisplay.ts` (which already owned
`trimTrailingPathSeparators` and a private `basenameOfPath`). It trims trailing separators first,
and returns a separator-only path unchanged so `/` labels as `/` rather than as nothing. The two
duplicate helpers are deleted in favour of it; the remaining call sites now import it.

`inferEntryKindFromPath` gains an explicit trailing-separator check **before** the dotted-name
guess. This is required by the fix, not extra scope: once the basename is trimmed, `config.d/`
would start reading as a *file*, a regression the old accidental `""` never had.

## Alternatives rejected

- **Suppress chips for directory paths.** Removes a working affordance. Clicking one already gives
  a clean "'<path>' is a directory, not a file." message (`ws.ts:255`), and Copy path / Open in
  editor are genuinely useful on a folder. This would be a regression dressed as a fix.
- **Fall back to the full path when the basename is empty.** Papers over the extraction bug and
  produces an unbounded label in a chip sized for one segment.

## Deliberately not changed

`looksLikePosixFilesystemPath` keeps its own inline extraction. It asks "does this path end in a
filename", which is a different question — routing it through the directory-aware helper would let
`/data/notes.txt/` linkify on the strength of a trailing `.txt` segment. A comment now says so.

## Tradeoffs and limitations

- A directory path in **plain prose** (outside inline code or a markdown link) still does not chip:
  `chatFilePathLinks` gates on `classifyFileViewerKind`, which is extension-based. Unchanged here;
  the extension allow-list is the deliberate false-positive guard for prose.
- Clicking a folder chip opens the viewer, which reports "is a directory, not a file". Correct and
  legible, but a directory listing would be better. Left as a follow-up.
