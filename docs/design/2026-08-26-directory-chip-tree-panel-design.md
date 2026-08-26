# Folder chips open a directory listing in the side panel — 2026-08-26

## Goal

Clicking a path chip in chat that names a **directory** should show that folder's contents in the
side panel, browsable, instead of a read error. Selecting a file opens it in a tab.

Today the click always opens a file viewer, which fails with one of two strings depending only on
whether the path happens to sit inside the workspace root:

- absolute, outside the workspace: `Failed to read '/Users/longngo/reports/.../2026-08-24/'.`
- workspace-relative: `Failed to read workspace file '<rel>' in '<cwd>'.`

**Reach (measured).** Directory paths chip from **inline code spans** (a path with an explicit
shape — `/…`, `./…`, `~/…`, a Windows drive — skips the extension check,
`markdown-links.ts:365-378`, test-locked at `markdown-links.test.ts:341-356`) and from **markdown
link destinations** (the reported case). They do **not** chip from plain prose:
`resolveChatFilePathMention` requires a known extension (`chatFilePathLinks.ts:145`). Teaching
prose to linkify bare directory names is a separate change with its own false-positive budget —
explicit non-goal, recorded as a follow-up.

## Baseline @ 65bd22933 (2026-08-26)

```
directory chip click: opens a file surface, renders a read error
  measured server-side against real fixtures: every directory spelling (`docs`, `docs/`, `docs//`,
  `./docs`, `docs/sub/..`, a symlink to it) yields failure=path_not_file
absence measurement: no file viewer can render a directory
  `grep -rn "includeFiles" packages/contracts/src apps/server/src apps/web/src` → 0 hits
regression floor: `pnpm verify` @ 65bd22933 → exit 0, 14 suite blocks,
  10,087 tests passed / 8 skipped / 0 failed
```

## Mechanism of the current failure (source-pinned, reproduced)

`readTrustedFile` realpaths the directory successfully, then delegates to the cwd-relative reader.
`NodeFSP.open(dir, "r")` **succeeds** on darwin, so the `EISDIR` branch never fires; the `stat`
guard at `WorkspaceFileSystem.ts:219-225` raises `WorkspacePathNotFileError`, which declares no
`cause`. `trustedReadErrorMessage` (`ws.ts:267-278`) therefore reads `code === null` and falls
through every branch to the generic message.

## Approach

**One rule: when a file read fails, ask for a directory listing of the same path. If the listing
succeeds, the path was a folder — render it. If it fails, the read error stands.**

That is the whole mechanism. The listing request _is_ the directory test, so there is no separate
probe, no typed-failure plumbing, no filename heuristic, and no stale-result gate (a stale failure
now produces a listing request that fails, and the view self-corrects).

### What was cut, and why — all three were measured wrong

- **A trailing-slash fast path** (skip the read when the chip text ends in `/`). Rejected: the
  server realpaths _before_ opening, and darwin's `realpath("/x/file.txt/")` **succeeds and strips
  the slash**, so a regular file with a trailing slash reads fine today and the "optimization"
  would break it. Verified directly: `realpath` → `/private/tmp/fpcheck/file.txt`, while
  `open()` on the raw path throws `ENOTDIR`. It also bought no error flash (the viewer renders
  "Loading…" during the read, not an error) and created a second root convention.
- **Routing on `inferEntryKindFromPath`.** It calls `Makefile`, `LICENSE` and `.env` directories.
- **Plumbing `failure` / `resolvedPath` onto `ProjectQueryState`.** `ProjectQueryState<A>` is one
  shared interface, so both fields would land on all four hooks with two permanently null. The
  listing request answers the same question without them.
- **A new `projects.statPath` probe.** An extra round trip, and a listing endpoint still needed.

### Data source: extend `filesystem.browse`, do NOT use `projects.listEntries`

`projects.listEntries` was the obvious reuse and it is disqualified. It is a frecency-ranked
recursive **search index**. Measured against the real `@ff-labs/fff-node` with production options:

|                   | outcome                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| non-git directory | **every dotfile and image silently absent** — `~/reports` returns 0 of its 162 PNGs                     |
| `~/reports`       | 3,304 entries, **28.9% of directories missing children**, `truncated: false`                            |
| `~`               | 3.4 s, 25,000-entry alphabetical prefix, **2.78 MiB frame**, +421 MB RSS                                |
| `/`               | 15,046 ms, then `ready=false`, 0 entries                                                                |
| any root          | native index **+ recursive FS watcher retained 15 min**, uncancellable; failures cached the same 15 min |
| every call        | `mixedSearch` is **synchronous — 0.3-1.7 s of blocked event loop**, freezing every client               |

`filesystem.browse` already reads one level of an arbitrary absolute path with no index, and
already does the path normalization this feature needs: `~` expansion, rejection of a relative path
with no `cwd`, and a 512-char cap (`FILESYSTEM_PATH_MAX_LENGTH`). Raw `readdir` does none of those —
it returns `ENOENT` for `~` and resolves a relative path against the **server process cwd**.

Extending it was built and measured at **+20/−3 across 2 files**, versus **+127 across 6** for a new
`listDirectory` RPC, with zero changes to `rpc.ts`, `ws.ts`, `RpcAuthorization.ts` or
`client-runtime`, and **zero test edits** across all four existing consumers (web CommandPalette,
WorkspaceMemberEditor, shared helpers, and mobile `AddProjectScreen`).

```
FilesystemBrowseInput  += includeFiles?: boolean
FilesystemBrowseEntry  += kind?: "file" | "directory" | "other"
FilesystemBrowseResult += listedFiles?: boolean, truncated?: boolean, totalCount?: number
```

All optional, so every combination decodes. Decoding is not the hard part of skew, though: a server
that predates `includeFiles` drops it and answers with the legacy directories-only, `kind`-less
listing, which is a well-formed success and a plausible answer to the new question. Taken at face
value it renders every subdirectory as a file — clicking one produces the exact read error this
feature exists to remove — and reports a folder holding only files as empty. `listedFiles` is the
server saying it understood the ask; without it the client keeps the read error, which is the most
that server can support. `app.t3.codes` against a pinned local server is the normal remote
configuration, so this is not a corner case.

Behavior changes **only** when `includeFiles` is set:

- non-directory entries are returned, and every entry carries `kind`;
- `EACCES`/`EPERM` is **reported** instead of degrading to an empty array (autocomplete keeps the
  quiet behavior — an unreadable folder must not render as an empty one);
- entries are sorted directories-first, then by name;
- the listing is capped and reports `truncated` + `totalCount`.

Emitting `kind` only under `includeFiles` is load-bearing: attaching it unconditionally broke three
`toEqual` assertions in `WorkspaceEntries.test.ts`.

Two corrections to claims made against `browse` in an earlier draft, both falsified by measurement:
its hidden-entry filter is **not** a problem here (`showHidden` is true whenever the input ends in a
separator, which this call always does — `browse("~/reports/")` returned all 47 entries including
`.claude` and `.gitignore`), and it does return a server-normalized `parentPath`. The client does
not read `parentPath`: each entry already carries the `fullPath` the server built from it, and
recursing on that is one fewer join to get wrong.

**`kind` must come from `stat`, not `dirent.isDirectory()`.** Verified: `/etc`, `/tmp` and `/var`
are symlinks, so `isDirectory()` is **false** for all three and they would render as unopenable
files. Symlink dirents get a `stat` (follow); a dangling one and any fifo/socket/device is `other`.
`other` rows are **inert** — this is what keeps a FIFO unclickable, and a FIFO matters: measured, a
`readTrustedFile` on one blocks a libuv thread forever, and **four of them wedge the default 4-thread
pool**, taking an unrelated file read from 0.3 ms to 6.8 s and WebSocket frame compression from
0.9 ms to 5.7 s for every connected client.

### Bounds

- **Entry cap** (10,000) with `truncated` + `totalCount` surfaced in the UI. The largest single
  level on this machine is 19,477 entries (100 KB deflated); 1M synthetic entries would be a
  2.43 MiB frame and 327 ms of synchronous encode. Refusing to silently omit is the whole reason
  `listEntries` was rejected, so a capped listing must say so.
- **A 2-permit semaphore** around the `includeFiles` readdir. Pre-existing exposure via `browse`,
  but the threadpool starvation above is real and RPC concurrency is `"unbounded"`
  (`ws.ts:2900`, no `concurrency` passed). Measured readdirs are 0-9 ms for every real directory,
  so the queue is not a latency cost.

### Rendering

A small hand-rolled lazy tree, `DirectoryListingView.tsx`: rows indent, directories expand in
place, each expansion is one `browse` call for that path, `other` rows are inert.

`@pierre/trees` `FileTree` (what the workspace Files view uses) was priced and rejected for this:
its options carry **no expansion callback**, its public model exposes **no row enumeration**, and an
unloaded directory reports `hasChildren: false` — lazy feeding would require polling the model on
every `subscribe` notification, at 136 lines against 88, hinging on chevron behavior the reviewer
could not prove without a browser. `ChangedFilesTree` + `turnDiffTree` are bound to diff nodes and
need a complete path list up front.

**Fidelity note:** this is a real expanding tree, but it is our own, not the same component as the
Files view, so it will not match it pixel-for-pixel.

### Where it renders

Inside the existing viewers — no new right-panel surface kind. The `trustedFile` surface already
**is** "a panel addressed by an absolute path".

- `TrustedFileView` covers **both** its mounts: the right panel and the standalone `/viewer/$`
  route, which has no thread ref and which a swap-based design could not reach at all.
- `FilePreviewPanel` gets the same treatment for the workspace-relative branch.
- Opening a listed file is the caller's business, via a prop. Note `FilePreviewPanel` already has a
  **required `onOpenFile(relativePath, repoCwd?)`** with workspace-relative semantics
  (`FilePreviewPanel.tsx:88`), so the new prop takes a different name and the workspace panel
  relativizes a child against its own `cwd` (prefix test on the client's own root, which is why the
  root must not be a realpath) — inside the workspace it opens the **editable** viewer, outside it
  opens read-only.

This avoids an entire class of defect found by building the alternative: no `directory:` tab id to
normalize (five spellings produced five tabs), no cross-surface handoff (`openDirectory` could not
derive the `file:` surface id, leaking a dead tab and closing the user's Files explorer as
collateral), no persisted-store migration, no version bump, no downgrade hazard, and no
`Exclude<RightPanelKind, …>` build break.

## Tradeoffs, limits, threat model

- **Discovery, not new capability — with one honest exception.** `readTrustedFile` has no sandbox
  by deliberate decision (`WorkspaceFileSystem.ts:274-290`) and `orchestration:read` is the
  boundary. Content access is unchanged. What is genuinely new is **hidden-file name discovery**:
  `browse` today enumerates directories only, and `listEntries` drops dotfiles, so
  `includeFiles` is strictly stronger on that one axis. Measured, and stated plainly: `readdir($HOME)`
  returns 80 entries of which **63 are dot-entries, including `.ssh`, `.aws`, `.gnupg`, `.netrc`
  and `.secrets`**, and a symlinked child **is** followed wherever it points. (An earlier draft
  claimed the opposite on both counts — those were `listEntries` measurements wrongly carried over.)
  Context, not excuse: the same standard pairing grant also carries `terminal:operate`, i.e.
  arbitrary command execution, so against a default-paired peer this is noise. The case where it is
  not noise is an operator who mints an `orchestration:read`-only link from Connections settings.
  Accepted; a hidden-entry filter would recreate exactly the silent-omission dishonesty that
  disqualified `listEntries`.
- **An unreadable directory** keeps today's permission error: this is "browsable directories".
- **A directory named `site.html` or `shots.png`** never issues a text read (`usesRawBytes`), so it
  renders a broken iframe/image rather than a listing. Follow-up.
- **Retention moved to the client.** Zero retained server state — no index, no watcher, no cached
  failure — but `Atom.swr` holds one entry array per expanded node for 5 minutes, per device.
- Web only. Mobile's chip handler is a **silent no-op** for out-of-workspace paths
  (`ThreadFeed.tsx:1595-1613`).

## Files touched

- `packages/contracts/src/filesystem.ts` — four optional fields, one of them `listedFiles`
- `apps/server/src/workspace/WorkspaceEntries.ts` — `includeFiles` behavior, `stat`-based `kind`, cap, semaphore
- `apps/web/src/components/files/DirectoryListingView.tsx` — new
- `apps/web/src/components/files/TrustedFileView.tsx`, `FilePreviewPanel.tsx` — render the listing on read failure
- `apps/web/src/components/files/projectFilesQueryState.ts` — the listing query and the skew gate
- `apps/web/src/components/files/directoryListing.logic.ts` — new, the path arithmetic and the gate predicate
- `apps/web/src/components/ChatView.tsx`, `routes/viewer.$.tsx` — pass the open-file callback

Not touched: `rpc.ts`, `ws.ts`, `RpcAuthorization.ts`, `client-runtime`,
`rightPanelStore.ts`, `RightPanelTabs.tsx`, `FileBrowserPanel.tsx` (whose drag/context-menu emits a
**root-relative** composer mention — correct for a workspace root, wrong for `~/reports`).

Also **not** doing: mapping `WorkspacePathNotFileError` to `'X' is a directory, not a file.` An
earlier draft adopted that from review; it is wrong, because `path_not_file` also fires for
`/dev/null` and `/`, so the message would print `'/dev/null' is a directory, not a file.` The dead
`EISDIR` branch stays as it is.

## Review exit note

6a pillar sweep: **CONDITIONAL GO**, all seven must-fixes applied or dissolved by the rewrite.
6b lenses: round 1 Correctness / Simplicity / Performance+Observability / Compatibility+Security;
round 2 re-ran Correctness, Simplicity and Performance+Security against the rewritten data source,
render location and fast path. Round 2 falsified six claims, including two the design had just
adopted from round 1 reviewers (the fast path, and `resolvedPath` being required and faithful).
Exiting the loop: the remaining unreviewed surface is the hand-rolled renderer, which carries no
protocol or persistence risk and is covered by the implementation review and the sanitize pass.

## Follow-ups deferred

- Prose mentions of bare directory names do not chip at all.
- FIFO read hangs the RPC indefinitely and can wedge the libuv pool (pre-existing, reachable today
  by naming a FIFO directly).
- Mobile directory chips are a silent no-op.
- Image/HTML-named directories bypass the read and so never get a listing.
- `TrustedFileView.tsx:2-3` documents a read sandbox that was retired.
