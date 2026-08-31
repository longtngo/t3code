# Video files open in the viewer — 2026-08-31

## Goal

Clicking a chat path chip that names a **video** (`/Users/me/reports/demo.mp4`, or the same path
written as a `file://` URL) should play the video, and seeking should work. Today it renders a read
error.

Reported by the developer as: clicking
`file:///Users/longngo/reports/data-download/2026-08/2026-08-31/2026-08-31-download-center-demo.mp4`
"shows error too".

**Scope: absolute-path video only** — the `/viewer` byte route behind `TrustedFileView`, which is
both the reported case and the only surface a `file://` chip can reach. Workspace-relative video
(`/api/assets`, `FilePreviewPanel`, mobile) is a separate branch, drained before release. See
"Scope split".

Non-goals: audio files; the directory-listing fallback for raw-byte kinds. Both recorded as
follow-ups.

## Baseline @ 881e95e5d (2026-08-31)

Measured with a throwaway probe in `apps/web` over the real pure functions (deleted after the run),
and reproduced independently by two reviewers against copied repo sources:

```
absence measurement — no viewer surface can render a video
  classifyFileViewerKind("/Users/longngo/reports/x/demo.mp4")     -> null
  trustedViewKind("/Users/longngo/reports/x/demo.mp4")            -> "code"   (i.e. a TEXT read)
  resolveMarkdownFileLinkTarget("file:///…/demo.mp4")             -> chips, so the click is reachable
  findChatFilePathMentions("… /Users/longngo/reports/x/demo.mp4") -> 0        (prose does not chip)

  grep -rniE "accept-ranges|content-range" apps packages          -> 0 hits
  classifyViewerPath(".mp4")                                      -> null -> HTTP 400, before auth

regression floor: pnpm verify @ 881e95e5d -> exit 0, 14 suite blocks,
  11,234 passed / 20 skipped / 0 failed
```

## Mechanism of the current failure (source-pinned)

Two independent stops, both must be removed.

1. **Client.** `classifyFileViewerKind` (`apps/web/src/lib/codeFileTypes.ts:62-72`) has no video
   branch, so it answers `null`; `trustedViewKind` collapses `null` to `"code"`
   (`TrustedFileView.tsx:86-92`), so `usesRawBytes` is false and the view issues a **text** read.
   `readTrustedFile` reads the first 1 MiB and hits its NUL-byte guard
   (`WorkspaceFileSystem.ts:242-247`), returning `WorkspaceBinaryFileError`:
   `Workspace file 'demo.mp4' in '/Users/…' is binary and cannot be previewed as text.`
2. **Server.** `classifyViewerPath` (`apps/server/src/http.ts:733-755`) recognises only markdown /
   html / image / text and returns `null` for `.mp4`, which the route turns into **HTTP 400
   `Invalid or unsupported file path`** (`http.ts:784-787`) — before authentication.

## Approach

**Add `video` as a fourth raw-byte kind mirroring `image`, and give the `/viewer` byte path HTTP
Range support by porting effect's own range parser.**

`image` is the precedent to copy: it already solves "bytes the text reader must never see", pins
`Content-Type` through `headers` (because `HttpServerResponse.file` drops its `contentType`
option — `http.ts:502-506`), stat-guards against a directory named `foo.png`, and refuses the
local-navigation auth waiver. Video inherits all four.

### Extension set

`.mp4`, `.webm`, `.mov`, `.m4v`, `.ogv` — the set the repo already treats as video at
`pullRequestMarkdown.logic.ts:26`. Lives in `packages/shared/src/filePreview.ts` beside the image
and text lists, with its extension→MIME map, so the classifier and the `Content-Type` pin cannot
drift.

### Range is required, and the reason is seeking — not Safari

An earlier draft justified Range partly on "Safari and iOS refuse a source that answers 200". That
claim is **withdrawn**: it contradicts the same draft's own observation that attachment videos
already play through `/api/assets`, which answers 200, and no WebKit was available locally to
settle it. Do not cite it again without a measurement on a real iPhone.

The seeking argument needed no such claim and was measured directly. Two arms, one variable, both
throttled to 150 KB/s so the seek target sits past the buffered region, same file, same headless
Chromium:

```
ARM A (Range)     after load: buffered [0, 16.8s]
                  seek to 80% -> new request  Range: bytes=2392064-  -> 206
                  SEEK LANDED: true   (wanted 88.19s, got 88.19s)

ARM B (200 only)  after load: buffered [0, 16.8s]
                  seek to 80% -> NO new request
                  'seeked' fired but currentTime snapped back to 0
                  SEEK LANDED: false  (wanted 88.19s, got 0s)
```

Arm B is a _silent_ failure: the scrubber moves, `seeked` fires, playback restarts at zero. For a
screen recording — the reported case — scrubbing is the primary interaction.

### Port the parser, do not write one

`.repos/effect-smol/packages/effect/src/unstable/http/HttpStaticServer.ts:285-345` already contains
a complete `parseRange`, and `:110-145` the exact 206/416/`Content-Range` shape. It is not exported
(`HttpStaticServer.d.ts` confirms), so it is ported rather than imported — but per AGENTS.md,
vendored patterns beat invented ones. A reviewer ported it verbatim and ran 13 cases against the
real 3,014,000-byte file, byte-comparing every body: all correct, including `bytes=-500` (suffix),
`bytes=0-` (open-ended), multi-range and malformed (ignored → 200, RFC-legal), `bytes=999999999-`
(→ 416 `bytes */3014000`), and `bytes=3013990-99999999` (clamped).

**Port `parseRange` (`:285-345`) only — not `serveFile`.** `HttpStaticServer.ts:88-100` evaluates
`if-none-match` / `if-modified-since` and can return a **304 before the range branch**, which would
break a player issuing a conditional range request. That matters here specifically because the route
emits both `ETag` and `Last-Modified` (see Authorization below), so conditional requests will happen.

Hand-rolling is where this stops being one helper. Measured against the exact platform code, the
two omissions that matter both fail badly:

```
bytes=0-9999999998 on a 1000-byte file
  -> content-length: 9999999999, sends 1000 bytes, then HOLDS THE SOCKET OPEN INDEFINITELY
bytes=5000- on a 1000-byte file
  -> content-length: -4000, Node destroys the connection
```

`contentLength` is computed from the caller's `offset`/`bytesToRead` and never re-clamped against
the stat, while `createReadStream` silently stops at EOF. Clamping `end` and returning 416 for
`start >= size` is the load-bearing part.

### Bounding the response, not the request

The image cap (`VIEWER_MAX_IMAGE_BYTES`, 64 MiB) exists because "an unbounded stream over Tailscale
is an unexplained stall" (`http.ts:497-500`). An earlier draft raised it to 2 GiB for video and
claimed Range made the cap a rangeless-only concern. **Measured false:** Chromium's _first_ request
for `<video preload="metadata">` is `Range: bytes=0-`, an open-ended range that is satisfiable and
equals the whole file:

```
Range: bytes=0-   ->  206  content-range: bytes 0-3013999/3014000
                          content-length: 3014000        <- the entire file
```

So the ranged path is the one every media element takes, and the rangeless branch a cap would guard
is the branch a browser never uses.

The bound is therefore on the **response**: clamp `end` to
`min(parsed.end, start + VIEWER_MAX_VIDEO_RESPONSE_BYTES - 1)` and report the clamped
`Content-Range`. A client that wants more comes back for the next range, which is the protocol
working. (Clamping against `size - 1` as well is redundant — both parser branches already clamp to
`fileSize - 1` at `HttpStaticServer.ts:314,331,344` — so it is not done.)

**But deleting the file-size cap is not the same as bounding the response, and an earlier draft of
this section made exactly that error.** The parser returns `undefined` for anything it will not
parse, and `undefined` falls through to a full 200. Measured on a 561,302,403-byte file with the
clamp in place:

```
(no Range header)          -> 200  content-length: 561302403
bytes=0-1,5-6              -> 200  content-length: 561302403   (multi-range, RFC-legal to ignore)
bytes=abc-def              -> 200  content-length: 561302403
bytes=9007199254740993-    -> 200  content-length: 561302403   (> MAX_SAFE_INTEGER; should be 416)
```

Four unbounded full-file branches, two of them reachable _with_ a Range header — on the exact route
whose image sibling caps at 64 MiB with a 413. So the rangeless branch **keeps a stat-based size
cap with a 413**, mirroring images. Both bounds exist: a size cap on the unranged branch, a response
clamp on the ranged one.

**`VIEWER_MAX_VIDEO_RESPONSE_BYTES = 8 MiB`,** and the value is load-bearing rather than arbitrary.
Three arms, one variable, 561 MB / 600 s video, 60 ms per-request latency, 30 s of playback then a
seek to 480 s:

```
CAP=64KB   played 18.48s in 30.0s wall   realtimeRatio 0.616   rebuffers=37   requests=344   seek 10,729ms
CAP=8MB    played 30.00s in 30.0s wall   realtimeRatio 1.000   rebuffers=0    requests=7     seek    135ms
no clamp   played 30.00s in 30.0s wall   realtimeRatio 1.000   rebuffers=0    requests=2     seek    127ms
```

At a small cap the clamp _produces_ the stall it exists to prevent. At 8 MiB it is indistinguishable
from no clamp.

**It is a per-response bound, not a transfer bound.** It does not reduce bytes served; it converts
one stream into `ceil(size / CAP)` sequential round trips and defeats the browser's own read-ahead
throttling. Measured over a 10 s watch with no added latency: 64 KB → 210 requests / 13.8 MB;
8 MiB → 10 requests / 32.2 MB; unclamped → 7 requests / 29.9 MB.

**Suffix ranges clamp `start`, not `end`.** For `bytes=-N` the client is asking for the _tail_, so
clamping `end` downward returns the wrong region entirely — measured, `bytes=-1000000` with a 64 KB
cap returned `bytes 560302403-560367938`, the first 64 KB of the window rather than the last bytes
of the file. The suffix branch therefore computes `start = max(start, end - CAP + 1)`. Chromium
never exercises this (its moov probe is open-ended, `bytes=29196288-`), but `ffmpeg`, VLC and
`curl -r -N` do, and a suffix range is the only way to ask for the tail without knowing the size.

Verified end to end in real headless Chromium, including the moov-at-EOF layout most screen
recorders emit — repeated short reads are handled correctly, with no loop, thrash, or truncation
error:

```
moov-at-END tail.mp4 (29,224,630 B, moov at 29,208,997), CAP=64KB
  metadata in 21ms / 3 requests;  seek to 96s -> landed, 18 requests;  353 total, err=null
demo.mp4, CAP=64KB
  50 requests == ceil(size/CAP);  seek to 80% landed exactly;  error=0 stalled=0
```

### Authorization: scope required, and range parsing must run after it

Video follows the image rule and never receives the local-navigation waiver
(`http.ts:796-800`). The stakes are higher than for images. The existing comment justifies the image
exclusion as "an unauthenticated response a browser can decode is an oracle"; with Range that
premise stops bounding anything, because `Range: bytes=0-1` returns literal file bytes. Waiving
video would be a byte-ranged arbitrary-file read, not an oracle.

Ordering is an invariant, not an implementation detail, and gets a test. Parsing a range needs the
file size, and a size needs a `stat`, so a range parsed before the auth check leaks existence and
size to an unauthenticated caller. Measured:

```
UNAUTHENTICATED, range parsed BEFORE auth
  exists,  Range: bytes=999999-   416  content-range: bytes */20      <- size oracle
  MISSING, Range: bytes=999999-   404                                 <- existence oracle
  exists,  Range: bytes=0-1       206  body="S3"                      <- actual bytes
UNAUTHENTICATED, auth first (what this design requires)
  exists,  Range: bytes=999999-   401
  MISSING, Range: bytes=999999-   401
```

Verified with auth ordered first: `bytes=999999999999-`, `bytes=0-1` and `bytes=-500` against both
an existing and a missing path all return **401 with zero `stat()` calls executed**. What an
unauthenticated caller can still learn is then exactly one bit — "this build's classifier admits
`.mp4`", visible as 400 becoming 401 — which is a property of the binary, not of the user's disk,
and is already exposed for every markdown/html/image/text extension.

Note `ETag` is `size-hex + mtime-hex` and effect computes it unconditionally in `fileResponse`
(`Etag.ts:81-87`), **as well as `Last-Modified`** (`HttpPlatform.ts:86-98`), so every authorized
byte response discloses size and mtime. Both are post-auth. Already true for images and accepted,
not introduced here.

One pre-existing asymmetry the video branch inherits and does not fix: `viewerRouteLayer`'s error
funnel (`http.ts:985-988`) handles `EnvironmentAuthInvalidError` and `EnvironmentInternalError` but
not `EnvironmentScopeRequiredError`, while the two other raw routes handle all three
(`http.ts:273-275`, `330-332`). A valid session lacking `orchestration:read` therefore does not get
the intended `insufficient_scope` response. Recorded as a follow-up.

### Where it renders

`TrustedFileView` only, covering both its mounts: the right panel's `trustedFile` surface and the
standalone `/viewer/$` route.

The element is `<video controls playsInline preload="metadata">`, matching
`ExpandedImageDialog.tsx:125-133` minus its `autoPlay` — that dialog is an explicit "play this
attachment" gesture, whereas the viewer is a file browser and a report path that starts blaring
audio is a defect.

It gets an `onError` → error notice, because otherwise every failure renders as a silent dead
element. Note this is **new**, not reuse: `TrustedFileView`'s `<img>` has no `onError` today, and
the only one in the repo (`FilePreviewPanel.tsx:181`) sets a failed-URL flag. Verified reachable in
real Chromium — `onError` fires (code 4) for a directory named `demo.mp4` (404), a missing file,
413, 401, 416, wrong bytes, and a 0-byte file. It does **not** fire for a stream truncated after
headers, which stays a hang; accepted, and the Reload button is the escape.

Reload must clear the error flag alongside `setRawReloadToken`, or a transiently-failed video stays
stuck on the notice for the life of the mount (the `key` is the path).

### Scope split

**What a workspace-relative video click does after this ships: the same red error it does today.**
This is the fact the feature's name most invites getting wrong, so it is stated plainly. The surface
a chip opens is chosen by the workspace boundary alone (`ChatMarkdown.tsx:1561-1584`), never by
viewer kind: a path under `cwd` goes to `openFile` → `FilePreviewPanel`, which sets `isImage = false`
(`FilePreviewPanel.tsx:840`), issues a **text** read, and renders `WorkspaceBinaryFileError` at
`FilePreviewPanel.tsx:1094-1097`. **A workspace-relative video never reaches `TrustedFileView` at
all**, so the `<video>` branch this design adds is not merely unhelpful there — it is unreachable.
Nothing regresses (those chips already exist via inline code and markdown links, and already land on
that error), but nothing improves either until follow-up 1 lands.

**Branch ordering is therefore a constraint, not a preference:** video → workspace video → prose
folder chips. Widening `classifyFileViewerKind` turns on prose chips for video, and in-workspace
those are a new entry point to the dead end above. Landing the workspace branch second closes it
before the prose-folder-chip branch reintroduces in-workspace chips through its own root-prefix
clause. Hard Rule 6 drains all three before release, so the dead end exists only between merges and
never in a released build. This is why no temporary "reject video in the chip gate" guard is added:
it would be deleted by the very next branch.

Three things this design deliberately does not do, each its own branch:

1. **Workspace-relative video** (`/api/assets` → `FilePreviewPanel`, mobile). An earlier draft
   listed these as covered by "`PREVIEW_ASSET_EXTENSIONS` admits video". **Measured inert:** that
   set is consulted only in the `workspace-file` redemption branch (`AssetAccess.ts:544`), while
   minting fails earlier at `AssetAccess.ts:242` on `isWorkspacePreviewEntryPath`, which is
   browser ∪ image:

   ```
   /w/demo.mp4   previewEntry=false  image=false     <- issueAssetUrl rejects before any token
   /w/a.png      previewEntry=true   image=true
   ```

   Doing it properly means video takes the `workspace-file-exact` branch (`AssetAccess.ts:274-288`)
   as images do, so the token is basename-scoped rather than a 60-minute directory-scoped bearer
   grant sitting in a `<video src>` attribute — at which point `PREVIEW_ASSET_EXTENSIONS` must
   **not** change at all. That is a different authorization argument from this one and belongs in
   its own review.

2. **Range on `/api/assets`.** Follows (1).
3. **The directory-listing fallback for raw-byte kinds.** A pre-existing follow-up from the
   2026-08-26 directory-chip design (`shots.png`), not needed to play a video, and it would change
   `<img>` behavior and force a restructure of `TrustedFileView`'s render body: for raw-byte kinds
   `useTrustedFileQuery(env, null)` returns `AsyncResult.initial`, so `file.error` is `null`
   forever and the existing listing query is structurally disabled on exactly that path.

## Alternatives rejected

- **Serve video through `/viewer-asset`.** It already carries `.mp4`/`.webm` content types
  (`http.ts:534-538`), so it looks like a shortcut. Rejected: it is token-granted per-directory with
  a 10-minute TTL for a rendered document's own relative assets — strictly more access than
  `/viewer` needs, for no gain.
- **Skip Range, ship progressive playback.** Rejected on the measured seek A/B above.
- **Hand-roll the range parser.** Rejected on the two measured failure modes above.
- **Raise the byte cap and keep a rangeless-only bound.** Rejected: measured, browsers never take
  that branch.
- **Fall back to a download link instead of a player.** The reported case is a recording the
  developer wants to watch in place.
- **A `video` kind on the client only.** Not possible: the route 400s before it serves anything.

## Bounds and tradeoffs

- **A directory named `demo.mp4`** renders a failed `<video>` with the error notice rather than a
  listing — same as `shots.png` does today. Unchanged by this design, recorded as a follow-up.
- **`.mov` is `video/quicktime`** and not every browser decodes every `.mov`. It stays in the list;
  an undecodable file now shows the notice rather than a dead element, and excluding the most common
  macOS screen-recording extension would be worse.
- **A truncated stream does not fire `onError`** and shows a stalled player. Reload is the escape.
- **Observability is unchanged and poor.** `apps/server/src/http.ts` has 3 `Effect.log*` calls in
  1198 lines, none on the viewer request path, and Effect's access log is disabled by default
  (`server.ts:750`, keyed off `logWebSocketEvents`, default false). The new 416/413 branches are as
  invisible as the existing 400/404. Improving this is out of scope and recorded as a follow-up.
- **New in prose, and almost free.** Adding `video` to `classifyFileViewerKind` also lets a bare
  `.mp4` path linkify in chat prose, since that classifier is the prose chip gate. Measured over
  82,872 real messages: **exactly 1 new prose chip** — the reported
  `…-download-center-demo.mp4`. Nobody writes bare video paths in prose.
- **A prose chip for an in-workspace video is a new entry point to an existing dead end.** See
  "Scope split" for the mechanism and the branch ordering that closes it.
- **Measurements against the reported file are not reproducible.** `…-download-center-demo.mp4` is
  being actively rewritten — 3,014,000 bytes when first measured, 3,256,920 at 11:13, 2,911,592 at
  11:24. The Range and clamp numbers above were taken against fixed-size copies and a generated
  561 MB fixture for that reason.
- **Same gate as the prose-folder-chip design.** Both widen
  `resolveChatFilePathMention`'s `classifyFileViewerKind(path) === null` check, in different files
  and functions, so they do not textually conflict; measured, they add no chips to each other. They
  do collide on one test line — see Files touched.

## Files touched

- `packages/shared/src/filePreview.ts` — `WORKSPACE_VIDEO_PREVIEW_EXTENSIONS`, its MIME map, and
  `isWorkspaceVideoPreviewPath`
- `apps/server/src/http.ts` — `ViewerPathKind` gains `"video"`; `classifyViewerPath`;
  `VIDEO_CONTENT_TYPES`; the ported `parseRange` (not `serveFile`); the video branch on `/viewer`
  with `Accept-Ranges: bytes`, a clamped `Content-Range`, 416 on unsatisfiable, a
  `VIEWER_MAX_VIDEO_RESPONSE_BYTES = 8 MiB` per-response clamp (with `start` clamped upward for
  suffix ranges), and a `VIEWER_MAX_VIDEO_BYTES` stat-based 413 on the rangeless / unparseable
  branch
- `apps/web/src/lib/codeFileTypes.ts` — `FileViewerKind` gains `"video"`
- `apps/web/src/lib/codeFileTypes.test.ts` — two assertions invert: `:26`
  (`classifyFileViewerKind("video.mp4") → null`) and `:83` (`"a.mp4" → null`, under "leaves
  non-image binaries unclassified"). The second is an intentional negative and is re-expressed
  against a still-unclassified binary, not deleted.
- `apps/web/src/chatFilePathLinks.test.ts` — `:88` asserts `clip.mp4` resolves to `null`, with the
  comment "Non-image media stays excluded; the viewer has nothing to show for it." That is exactly
  the contract this design reverses, so the line is rewritten. **It is also the one collision with
  the prose-folder-chip design**, which reverses the same test's `/etc/hosts` and `.env` cases;
  whichever lands second should expect the file already edited.
- `apps/web/src/components/files/TrustedFileView.tsx` — `trustedViewKind`, `usesRawBytes`, the
  `<video>` branch, its `onError` notice, and the Reload reset

## Review exit note

6a pillar sweep: **CONDITIONAL GO**, all five must-fixes applied or dissolved by the rewrite. 6b
round 1: Correctness+Simplicity and Security+Performance, both **CONDITIONAL GO**. Round 2 re-ran
Correctness+Security over the three dimensions the rewrite created — the response-clamp model, the
auth-ordering invariant, and the scope split — and returned **CONDITIONAL GO** with five more
conditions, all now applied. Simplicity did not re-run: round 1's simplicity findings were both
scope cuts (drop the listing fallback, drop `/api/assets`), and round 2's edits only tightened
bounds inside the surviving scope.

Round 1 falsified three claims, two of which the design had asserted confidently: that Safari
refuses a 200 (withdrawn — it contradicted attachment videos that demonstrably play today), and that
`PREVIEW_ASSET_EXTENSIONS` was the gate for workspace video (inert — minting fails earlier). Round 2
falsified a fourth, introduced by round 1's own fix: "no rangeless special case" left four unbounded
full-file branches, two reachable with a Range header. Each correction is recorded inline next to
the claim it replaced rather than silently edited out.

Exiting the loop: the remaining unreviewed surface is the `<video>` element itself and the
`onError` notice, which carry no protocol or persistence risk and are covered by the implementation
review and the sanitize pass.

## Follow-ups deferred

- Workspace-relative video: `/api/assets` mint gate + `workspace-file-exact` scoping, then
  `FilePreviewPanel` and mobile (`filePath.ts`, `defaultViewMode`, a `FileContent` branch, and
  `preload-workspace-file.ts:28` so a video is not text-preloaded).
- Range on `/api/assets`.
- Audio files (`.mp3`, `.wav`, `.m4a`, `.ogg`) — identical shape.
- Directory-listing fallback for raw-byte kinds (`shots.png`, `demo.mp4`).
- Collapse `apps/web/src/types.ts:62-70` `VIDEO_MIME_TYPE_BY_EXTENSION` (a superset, with `avi` and
  `mkv`) into the shared list, so there is one video extension table rather than three.
- Structured logging on the `/viewer` failure branches.
- `viewerRouteLayer` does not handle `EnvironmentScopeRequiredError`, so a session lacking
  `orchestration:read` gets the wrong response shape (pre-existing, shared with the image path).
