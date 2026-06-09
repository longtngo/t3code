# Drop non-image files as file-path references — Design (2026-06-09)

## Goal

Today the composer only accepts **images** via drag-drop and clipboard paste; every
other file type is rejected with `"Unsupported file type for '<name>'. Please attach
image files only."`. We want dropping a non-image file (pdf, md, html, csv, …) to
instead surface the file's **absolute filesystem path** into the composer as text, so
the LLM can `Read` the file directly with its own tools — bypassing t3code's
attachment/interpretation layer entirely.

Success: drag a `report.pdf` from the OS file manager onto the composer → its absolute
path is inserted into the prompt at the cursor → the model reads the file directly when
the turn runs.

## Background (verified in code)

- **Desktop is Electron 41.5.0** (`apps/desktop/package.json`). The renderer (apps/web)
  talks to the main process through a `contextBridge`-exposed `window.desktopBridge`
  (`apps/desktop/src/preload.ts`, typed by `DesktopBridge` in
  `packages/contracts/src/ipc.ts`). The web app reads it via direct `window.desktopBridge`
  checks (`apps/web/src/localApi.ts`, `apps/web/src/env.ts`).
- **Browsers do not expose a file's absolute path.** Electron 41 also removed the legacy
  `File.path`. The supported replacement is **`webUtils.getPathForFile(file)`**, which
  must run in the renderer/preload with the real `File` object and is explicitly designed
  to be exposed through `contextBridge`. It returns `""` for files with no backing path
  (e.g. most clipboard blobs).
- **The agent runs on the same host as the server** with a per-thread `cwd` +
  `additionalDirectories` and the SDK `Read` tool (`apps/server/src/provider/Layers/ClaudeAdapter.ts`).
  Injecting an absolute path as message **text** is sufficient for the model to read it
  (subject to the normal permission boundary; see Limitations).
- **Composer text** lives in a Zustand draft store and is edited through a Lexical editor.
  `applyPromptReplacement(start, end, text)` (ChatComposer.tsx) inserts text Lexical-aware,
  updates the draft + cursor; `readComposerSnapshot()` returns the live cursor.
- **Drop path** today: `onComposerDrop` → `Array.from(dataTransfer.files)` →
  `addComposerImages(files)` (which rejects non-images). **Paste**: `onComposerPaste`
  filters for `image/` and ignores everything else.

## Approach (chosen)

> **Superseded in part by the upload-fallback addendum**
> (`2026-06-09-drop-file-path-upload-fallback-design.md`): the "browser → error" step below
> is replaced by an upload-and-reference fallback, and the desktop path is now used only when
> the active environment is the **primary/same-host** one (a desktop local path is wrong for a
> remote/SSH agent). The shipped fallback error is `"Couldn't attach: <names>."`.

On **drop**, split the dropped files into images vs non-images:

1. **Images** → existing `addComposerImages` flow (unchanged).
2. **Non-images** → for each, resolve its absolute path via a new desktop-bridge method
   `getPathForFile(file): string` (only when `shouldUseLocalFilePath` is true: desktop app +
   primary environment). Collect the non-empty paths and **insert them into the composer
   prompt as text at the current cursor**, one per line, via `applyPromptReplacement`. Paths
   are surrounded by whitespace so they don't glue onto adjacent text.
3. Files without a usable local path fall through to the upload fallback (see addendum).

New bridge surface:

- `packages/contracts/src/ipc.ts` — add `getPathForFile: (file: File) => string` to
  `DesktopBridge`. Verified against Electron docs: `webUtils.getPathForFile(file)` returns
  the path **synchronously**, is meant to be exposed through `contextBridge`, and returns
  `""` for files with no filesystem backing.
- `apps/desktop/src/preload.ts` — `getPathForFile: (file) => webUtils.getPathForFile(file)`
  (import `webUtils` from electron). Synchronous, no IPC round-trip.
- **No `localApi.ts` accessor** — access inline in ChatComposer as
  `window.desktopBridge?.getPathForFile(file) ?? ""`. (Review: localApi is for environment
  APIs; a one-line null-guard doesn't warrant indirection.)

Paste stays image-only: clipboard files generally have no filesystem path, so
`getPathForFile` would return `""` anyway. Out of scope for v1 (documented as a follow-up).

### Resolved details (from design review)

- **Split before the existing handler.** `onComposerDrop` partitions
  `dataTransfer.files` into images (`type.startsWith("image/")`) and the rest. Images →
  `addComposerImages(imageFiles)` (unchanged, keeps its `pendingUserInputs` guard).
  Non-images → `addComposerFilePaths(otherFiles)`.
- **Single insertion.** `addComposerFilePaths` resolves each path via the bridge, collects
  the **non-empty** ones, joins with `\n`, and calls `applyPromptReplacement` **once** at
  the current cursor (`readComposerSnapshot().cursor`). Whitespace format: prefix a `\n`
  only when the char before the cursor is non-whitespace, suffix a trailing `\n` so the
  user can keep typing. `applyPromptReplacement(..., { focusEditorAfterReplace: true })`
  handles focus/cursor — so the drop handler skips its trailing `focusComposer()` when a
  path was inserted (avoids a RAF focus race).
- **Pending-plan-question case is fine.** `applyPromptReplacement` already routes to
  `onChangeActivePendingUserInputCustomAnswer` when a pending question is active, so path
  insertion works there (unlike image attachment, which is blocked). Intentional — text is
  always valid input.
- **Errors via `setThreadError`** (matches the existing non-image image-error flow), not a
  toast. Files that can't be resolved or uploaded are named in the shipped message
  `"Couldn't attach: <names>."`; on full success the handler does not clear the error (so it
  can't stomp an image error from the same mixed drop).
- **Deferred (low value):** dropping a non-image while a `/`-command or `@`-mention menu is
  open inserts at the cursor like any other text; `applyPromptReplacement` re-runs
  `detectComposerTrigger`, so the menu state stays consistent. Not special-cased.

### Path insertion format

Bare absolute path, one per line. Rationale: the user asked to literally "show the full
file path", and a bare path is exactly what the `Read` tool consumes. We do **not** quote
or wrap in backticks — keeping the inserted text identical to what the model receives and
fully user-editable. Multiple files → newline-separated so each is independently readable.

## Alternatives considered

1. **Dedicated non-image "file reference" attachment chip** carried through the message
   payload (new `ChatAttachment` variant). *Rejected:* large blast radius — new contract
   type, draft-store persistence, payload assembly in `buildUserMessageEffect`, and mobile
   parity — for no added capability: the agent ultimately just needs the path as text. The
   user explicitly wants to *see* the full path and bypass the interpretation layer, which
   text insertion does directly with ~1/5 the surface area.
2. **Read the file contents and inline them** (like images → base64). *Rejected:*
   directly contradicts the ask ("read the files directly, bypassing the interpretation
   layer"); also reintroduces size limits and loses the model's native file tooling
   (ranged reads, re-reads, grep).
3. **Main-process IPC handler that returns the path** instead of a sync preload accessor.
   *Rejected:* `File` objects can't cross IPC; `webUtils.getPathForFile` is specifically
   meant to be called in the preload with the live `File`. A sync accessor is simpler and
   has no round-trip.

## Files touched

- `packages/contracts/src/ipc.ts` — `DesktopBridge.getPathForFile`.
- `apps/desktop/src/preload.ts` — implement via `webUtils.getPathForFile`.
- `apps/web/src/components/chat/ChatComposer.tsx` — split drop handling; insert paths;
  new fallback error. (Possibly a tiny accessor in `localApi.ts`.)

## Tradeoffs / limitations

- **Desktop-only.** Plain-browser drops of non-images can't resolve a path; they get the
  fallback error. Acceptable — paths are inherently a native capability.
- **Permission boundary.** If the dropped file lives outside the thread's `cwd` /
  `additionalDirectories`, the model's `Read` may prompt for / be denied permission. That
  is the existing, user-controlled permission model; v1 does not auto-widen
  `additionalDirectories` (possible follow-up).
- **Paths with spaces** are inserted bare; the model handles them fine since the whole line
  is the path, but a future tweak could wrap them if it proves ambiguous in practice.

## Follow-ups deferred

- Paste support for files that *do* carry a path.
- Optional: auto-add a dropped file's directory to the thread's allowed read dirs.
- Optional: mobile parity (document picker → path is meaningless on mobile sandbox; likely N/A).
