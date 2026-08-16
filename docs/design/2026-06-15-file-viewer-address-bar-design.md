# File viewer address bar + $HOME sandbox + Copy path — 2026-06-15

## Goal

Three changes to the file-preview side panel and the inline file chip:

1. **Editable address bar** in the preview header — type any path (URI-like) to retarget the preview.
2. **Replace security-by-obscurity with a real sandbox** — currently the backend reads _any_
   absolute path and the UI merely hides it (`basenameOf`). Since the user has native terminal
   access, hiding is moot. Expose the real path in the UI; instead restrict backend reads to
   `$HOME` (`~`) and below.
3. **"Copy path"** as a third item in the inline file-chip dropdown.

## Current state (verified in code)

- `WorkspaceFileSystem.resolveReadPath` (`WorkspaceFileSystem.ts:69`) expands `~`, accepts any
  absolute path as-is, resolves relatives against `cwd`. **No containment check** — `/etc/passwd`
  is readable today. Both `readFile` and `readFileAsHtml` go through it.
- `FileViewerSidebar.tsx:332-334` shows `basenameOf(current.path)` with the absolute
  `resolvedPath` only in the `title` tooltip — the obscurity layer.
- `ChatMarkdown.tsx:348-351` — the markdown chip dropdown has `Open as Markdown` / `Open as HTML`.

## Approach

### 1. Address bar (`FileViewerSidebar.tsx`)

Replace the static filename span with an `AddressBar` input that shows the full path
(`resolvedPath` once loaded, else `current.path`). Enter navigates (pushes a history entry, kind
inferred from extension, default `markdown`); Escape reverts; blur reverts. Truncates when
unfocused. Reuses existing `navBaseCwdRef` so a typed _relative_ path resolves against the current
file's directory; absolute / `~` paths pass straight to the backend.

### 2. Read sandbox (backend)

New pure helper `apps/server/src/workspace/readAccess.ts`:

- `allowedReadRoots(cwd?)` → `[homedir, tmpdir, (absolute cwd)]`.
- `isWithinAllowedRoots(absolutePath, roots)` — lexical containment against any root.

Boundary chosen at checkpoint: **$HOME + OS tempdir + workspace cwd** (user picked the most
permissive of three). Tempdir keeps handoff/temp reports previewable; workspace projects (even
outside `~`) stay readable.

**Security correction from design review (CRITICAL):** the first cut derived the third root from
the request's `cwd`, but `cwd` is client-supplied — a caller could send `{cwd:"/", path:"/etc/passwd"}`
and read anything, defeating the sandbox. Fixed by deriving the project roots from _server_ state:
the read RPC handlers (`ws.ts`) read `ProjectionSnapshotQuery.getCommandReadModel().projects[].workspaceRoot`
and pass them as trusted `allowedRoots` into the read. The client `cwd` is used **only** to resolve
relative paths, never to authorize. Fails safe to no extra roots if the read model can't load.

Two checks in `WorkspaceFileSystem.ts`:

- **Lexical** (`authorizeReadPath`), before any FS access in `readFile`/`readFileAsHtml` — blocks
  out-of-root paths with no existence oracle.
- **Realpath** (`authorizeRealPath`), after the file is known to exist — catches symlinks inside an
  allowed root that point outside (e.g. `~/link → /etc/passwd`). On the HTML path it runs only on a
  cache miss (the cached bytes were validated when rendered). Home/tmp roots + their realpaths are
  memoized once per process; per-read realpath work covers only the trusted roots + the target.
  Both raise `WorkspaceFileSystemError` → "Could not open file" with detail
  "Path is outside the allowed read roots (~, temp dir, or project)".

### 3. Copy path (`ChatMarkdown.tsx`)

Add `<MenuItem onClick={copyPath}>Copy path</MenuItem>` to the markdown chip dropdown. Copies the
chip's `text` (the path as written) via `navigator.clipboard`, toast on success/failure.

## Alternatives considered

- **Boundary: `$HOME` only vs `$HOME`+tmp+projects.** User chose the latter. tmp keeps
  handoff/temp reports previewable; project roots keep out-of-home projects readable.
- **Trust client `cwd` as a root vs server-known project roots.** Trusting `cwd` is a sandbox
  bypass (see CRITICAL above); chose server-derived project roots.
- **Address bar replaces vs pushes history.** Pushes — consistent with in-report link nav, keeps
  the Back button working; self-navigation is de-duped.
- **Copy path on HTML chips too.** HTML chips have no dropdown (single button). Out of scope.

## Files touched

- `apps/server/src/workspace/readAccess.ts` (new) + `readAccess.test.ts` (new)
- `apps/server/src/workspace/Layers/WorkspaceFileSystem.ts` (+ `.test.ts`)
- `apps/server/src/workspace/Services/WorkspaceFileSystem.ts` (shape: `allowedRoots` param)
- `apps/server/src/ws.ts` (trusted project roots)
- `packages/contracts/src/project.ts` (doc comments)
- `apps/web/src/components/FileViewerSidebar.tsx`
- `apps/web/src/components/ChatMarkdown.tsx`

## Known limitations / follow-ups deferred

- `$HOME` is an allowed root, so the read RPC can reach `~/.ssh`, `~/.aws`, etc. for a holder of
  the read scope. This matches the user's "limit to $HOME" intent and the pre-existing posture
  (`filesystemBrowse` already lists any host dir under read scope). An extension allowlist or a
  stronger scope for reads is a possible future hardening.
- "Copy path" on HTML chips / preview header.
- Non-md/html extensions in the address bar render as markdown (no raw-text view yet).
- No web-component test yet for AddressBar / Copy path (server-side sandbox is covered).

## Prototype-first

User asked to see a prototype before full commit. Implement on `feat/file-viewer-address-bar`,
typecheck + test + screenshot, check in **before** merge/release.
