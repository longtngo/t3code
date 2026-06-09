# Drop file-path reference — web/remote upload fallback (2026-06-09, addendum)

Extends `2026-06-09-drop-file-path-reference-design.md`. That feature inserts a dropped
non-image file's **absolute path** into the composer via Electron `webUtils.getPathForFile`
— which only works on **desktop with a same-host agent**. This addendum covers the other
cases, confirmed by deep research (no browser API exposes a real path; and even a desktop
path is wrong for a **remote/SSH agent**).

## Goal

When `getPathForFile` returns `""` (plain browser, or a desktop file with no resolvable
path, or any remote-agent case), still let the model read the dropped file: **upload the
bytes to the agent host, write them under the server's attachments dir, and insert that
server-side absolute path** into the composer — reusing the exact insertion mechanism from
the base feature. Both branches converge on "an absolute path the agent can `Read`".

## Approach

`addComposerFilePaths` becomes **async**. For each non-image file:
1. `window.desktopBridge?.getPathForFile(file)` → if non-empty **and** the active environment
   is local (`isLocalEnvironment(environmentId)` — see the locality-gate follow-up below), use
   it (zero-copy, unchanged). A desktop-resolved path is meaningless to a remote/SSH agent.
2. Otherwise, read the file as base64 and call a new RPC `attachments.upload`, which writes
   the bytes on the **server (= agent host)** and returns its absolute path.
3. Collect all resolved paths (local + uploaded) and insert them once via
   `buildFilePathInsertion` + `applyPromptReplacement` (snapshot read *after* the awaits so
   the cursor is current).

### New RPC: `attachments.upload`

- **Contract** (`packages/contracts`): input `{ threadId, fileName, dataBase64 }`, result
  `{ path }`, plus an `AttachmentUploadError`. Register in `rpc.ts` (WS_METHODS + `Rpc.make`
  + group) and add `attachments.upload` to `EnvironmentApi` (ipc.ts). A size constant
  `ATTACHMENT_UPLOAD_MAX_BYTES` (20 MB raw, in the new `attachment.ts`) bounds the payload.
- **Server** (`apps/server/src/ws.ts` + a writer in `attachmentUpload.ts`): decode base64,
  enforce the size limit, **sanitize the filename** (basename only; strip separators / NUL;
  fall back to `"file"`), and write to
  `<attachmentsDir>/uploads/<threadSegment>/<uploadId>/<sanitizedFileName>`. The `uploadId`
  (uuid) subdir avoids collisions
  and keeps the original name/extension so the path is meaningful to the model. Return the
  absolute path. Path safety: the target is built from `attachmentsDir` + a fresh uuid +
  a sanitized basename, then re-checked to be inside `attachmentsDir` (reusing
  `resolveAttachmentRelativePath`'s containment check pattern). Auth scope:
  `AuthOrchestrationOperateScope` (same as `projects.writeFile`).
- **Client** (`packages/client-runtime/src/wsRpcClient.ts`, `apps/web/src/environmentApi.ts`):
  add the `attachments` namespace; ChatComposer calls it via
  `readEnvironmentApi(environmentId)` (it already has `environmentId` in props).

### Agent read access

Uploaded files live under `attachmentsDir`, which is **not** in the agent's
`additionalDirectories` (only `cwd` is) — so a `Read` would hit a permission prompt. Add
`serverConfig.attachmentsDir` to `additionalDirectories` in `ClaudeAdapter` queryOptions so
reads of uploaded files are seamless. This is the same dir where image attachments already
live; it's server-owned scratch space, not the user's repo.

## Why this shape (alternatives rejected)

- **Write into the project `cwd`** (so it's already in `additionalDirectories`, no adapter
  change) — rejected: pollutes the user's working tree / git status with dropped files.
- **Reuse `projects.writeFile`** — text-only (`Schema.String`); corrupts binary (PDF), and
  writes within `cwd`. Need a binary-capable, attachments-scoped RPC.
- **Route through the turn `attachments` payload + server-side prompt injection** — defers
  the path to send-time, doesn't show it in the composer, and is the heavier
  "attachment-pipeline" path the base design already rejected. Inserting the path as text at
  drop time keeps both branches identical.

## Security / correctness notes

- **Filename sanitization** is the main risk; mitigated by basename-only + char-strip + a
  fresh uuid dir + a final containment check against `attachmentsDir`. No caller-supplied
  path segments reach disk.
- **`additionalDirectories` widening** grants the agent read of the whole `attachmentsDir`
  for every thread. Acceptable: t3code is a personal/single-user server and `attachmentsDir`
  only holds the user's own attachments. (Follow-up if multi-tenant: per-thread subdir +
  per-thread additionalDirectory.)
- **Orphans**: uploading at drop-time writes a file even if the turn is never sent. Accepted
  for v1 (attachmentsDir is scratch); GC is a follow-up.
- **Size**: 20 MB cap; oversize → error toast naming the file. No progress UI for v1.

## Files touched

contracts: `attachment.ts` (new schemas) or `project.ts`, `rpc.ts`, `ipc.ts`,
`provider.ts` (size const). server: `ws.ts`, `attachmentStore.ts`,
`provider/Layers/ClaudeAdapter.ts`. client: `client-runtime/src/wsRpcClient.ts`,
`apps/web/src/environmentApi.ts`, `apps/web/src/components/chat/ChatComposer.tsx`.
Tests: server writer (sanitize/size/containment), contracts mocks.

## Follow-ups

- **Locality gate — DONE (2026-06-09).** The "use the desktop local path only for a same-host
  agent" rule is now a first-class `isLocalEnvironment(environmentId)` helper on the env runtime
  (`apps/web/src/environments/runtime/service.ts`, exported via the runtime index), replacing the
  inline `readEnvironmentConnection(id)?.kind === "primary"` proxy the sanitize pass introduced.
  `shouldUseLocalFilePath`'s input field is correspondingly renamed `isPrimaryEnvironment` →
  `isLocalEnvironment`. Locality semantics now live in one place; behavior is unchanged.
- Orphan GC for `uploads/`; upload progress indicator; per-thread isolation for multi-tenant;
  optional File System Access API capture + write-back (Chromium-only) as a later nicety.
