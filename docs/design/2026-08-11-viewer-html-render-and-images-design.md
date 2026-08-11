# Viewer: HTML render toggle, collapsed sidebar in a new tab, image support

**Date:** 2026-08-11
**Branch:** `feat/viewer-html-render-and-images`

## Goal

Three asks against the fork's trusted-file viewer:

1. An `.html` file opens as **source code** in the side panel. Add a toggle so it can be
   **rendered** instead.
2. "Open in new tab" should show the document with the app's left sidebar **hidden by
   default**.
3. Images cannot be viewed at all. Opening one fails with
   `Failed to read '/Users/…/2026-08-10-dashboard-before.png'.`

## Premises, and how each was verified (Hard Rule 8)

Every load-bearing fact below was measured against the **running** server, not read from a doc.
Two of them falsified my first reading, so they are recorded with the correction.

| Premise | Probe | Result |
|---|---|---|
| The image read fails in the text reader | read `WorkspaceFileSystem.ts` | **Confirmed, source-pinned.** `readTrustedFile` delegates to `readFile`, whose NUL-byte guard (`fileBytes.includes(0)`) raises `WorkspaceBinaryFileError`. `ws.ts:256` maps every non-`errno` failure to `Failed to read '<path>'.` — byte-for-byte the reported message. |
| `.png` is also rejected by the HTTP viewer route | `curl /viewer/<png>` | **Confirmed.** `400 Invalid or unsupported file path` — `classifyViewerPath` has no image branch. Both surfaces are broken, so the fix needs both. |
| ~~"Open in new tab" serves a bare document, no sidebar~~ | `curl /viewer/<html>` → 200 raw HTML | **FALSIFIED.** curl does not run the **service worker**. `vite.config.ts:198` says it outright: "`/pair` and `/viewer` are CLIENT routes … they need the shell", and `navigateFallbackDenylist` deliberately omits `/viewer`. In a real browser the SW serves `index.html`, so the tab renders the SPA route `viewer.$.tsx` inside `AppSidebarLayout` — **with the sidebar open**. That is the reported behaviour. |
| ~~The new tab 401s over Tailscale~~ | `curl -H 'X-Forwarded-For: …'` → 401 | **FALSIFIED — curl artifact.** `EnvironmentAuthPolicy.ts:39` lists `browser-session-cookie` in `sessionMethods` for every policy. A real browser carries the session cookie. curl carried none. |
| The SPA shell is reachable for unmatched paths | `curl /some-random-path` | 200 `index.html` (17826 B). Confirms the SPA fallback, though the design no longer needs a new path. |
| The sidebar's open state is not restored from its cookie | read `sidebar.tsx:112`, grep `SIDEBAR_COOKIE_NAME` | Confirmed. `SidebarProvider` writes `sidebar_state` but **never reads it back**; `defaultOpen` alone decides initial state. So `defaultOpen` is the whole lever for ask 2. |

The two falsified premises are why ask 2 needed no new route: the surface the user sees already
exists and is already the right one. Designing on the curl result would have produced a route
rename that changed nothing the user could see.

## Approach

### 1. HTML render toggle — generalize the existing one

`TrustedFileView` already owns a markdown↔HTML toggle, gated on `isMarkdownPreviewFile`, which is
why `.html` never gets one. Replace that boolean gate with the repo's existing classifier,
`classifyFileViewerKind` (`lib/codeFileTypes.ts`), which already returns `"html" | "markdown" |
"code"` and is the shared source of truth for the chat chips.

Per kind, with one `showAlternate` state meaning "show the non-default view":

| Kind | Default view | Toggle shows |
|---|---|---|
| `markdown` | `ChatMarkdown` | server-rendered HTML (existing `renderTrustedMarkdown` RPC) |
| `html` | **rendered** in a `sandbox=""` iframe | syntax-highlighted source |
| `image` | `<img>` | (no toggle) |
| `code` | highlighted source | (no toggle) |

**`.html` renders from the contents already in hand** — HTML is text, so it passes the NUL guard
and the existing trusted-read RPC returns it. `srcDoc` + `sandbox=""` matches how rendered
markdown is already displayed: opaque origin, scripts inert, no access to the app.

**Default = rendered, not source.** Opening a report to read it is the common case; the ask
describes source-only as the problem. Source stays one click away.

*Known limitation:* `sandbox=""` + `srcDoc` gives an opaque origin, so a report referencing
**external or relative** images will not load them. The user's `uni-md2html` reports are generated
`--self-contained` (data-URI assets), so this does not affect them. Recorded as a follow-up rather
than solved by loosening the sandbox, which would be a real escalation for untrusted files.

### 2. New tab — collapse the sidebar

`AppSidebarLayout` already subscribes to `pathname`. Since `defaultOpen` is the only thing that
sets initial open state, this is a one-line change plus a tested pure helper:

```ts
<SidebarProvider defaultOpen={!isViewerRoutePath(pathname)} …>
```

`defaultOpen` is *initial state only*, so this collapses the sidebar on a fresh load — which is
exactly what "Open in new tab" is — while leaving an in-app navigation's sidebar alone rather than
yanking it away mid-session. The rail/`SidebarControl` still re-opens it, per the chosen option.

### 3. Images

Two independent surfaces are broken; both need fixing, and they compose.

**Server** (`http.ts`): give `classifyViewerPath` an `"image"` kind and serve those bytes with
`HttpServerResponse.file`, which streams and never routes through the text reader — so the NUL
guard is bypassed by construction rather than weakened. Existing `no-store` / `nosniff` / CSP
headers are kept.

- **SVG is served under the no-scripts CSP** (`sandbox allow-popups`, the one markdown already
  uses), not the `allow-scripts` one `.html` gets. A top-level SVG navigation executes embedded
  script; an image viewer has no reason to allow that.
- The auth posture is unchanged. The loopback waiver is navigation-only
  (`isWaivableLocalRequest`), and an `<img>` subresource sends `Sec-Fetch-Mode: no-cors`, so it
  falls through to the `orchestration:read` scope check and authenticates by session cookie —
  same-origin, so this works locally and over Tailscale.

**Client**: `classifyFileViewerKind` gains `"image"`, which both makes image paths openable chips
and lets `TrustedFileView` render `<img src="/viewer/<abs>">`. For an image the text RPC is
**not issued at all** (the query is passed `null`), so the binary error can no longer surface.

## Design review round 1 — findings applied

Two reviewers (security lens, correctness/simplicity lens) read the doc against live code. Both
found defects that changed the approach; the sections above are the **revised** design. What moved:

**Structural changes**

- **Image and `.html` URLs are environment-scoped, not origin-relative.** `TrustedFileView`
  receives an `environmentId` and today reads through *that environment's* connection. An
  origin-relative `/viewer/<abs>` would silently target the local server — 404 for a remote
  environment, or worse, **the wrong machine's file at the same path**. It also breaks packaged
  desktop (renderer origin is `t3code://app`) and dev (`/viewer` is absent from
  `DEV_PROXIED_PATH_PREFIXES`, so Vite serves the SPA shell). Fixed by building on
  `useEnvironmentHttpBaseUrl(environmentId)` — the same primitive `FilePreviewPanel` already uses
  for workspace images.
- **`.html` renders through `<iframe src>`, not `srcDoc`.** This single change fixes four findings
  at once: (a) `sandbox=""` would have rendered the user's own interactive reports as a dead husk
  — 38 of 92 `.html` files under `~/reports` contain `<script>`, and the server route already
  ships `allow-scripts` for `.html` **with the reason written down** at `http.ts:335-341`, so
  `srcDoc` would have made two surfaces disagree about one file; (b) `srcDoc` inherits the
  *parent's* base URL, so relative assets resolve against the app origin — my "known limitation"
  had the mechanism backwards, and external absolute URLs load fine, making a rendered report a
  read-receipt beacon; (c) the trusted-read RPC truncates at 1 MiB
  (`PROJECT_READ_FILE_MAX_BYTES`), so a 1.4 MB self-contained report would have rendered cut
  mid-tag with no error; (d) with `src`, the server's `Content-Security-Policy` actually governs
  the document. Relative assets now resolve against the file's own directory, which turns the
  deferred follow-up into a solved case.

**Security hardening applied**

- **Images are never covered by the loopback auth waiver.** Serving decodable images would
  otherwise turn the waiver's fail-open on absent `Sec-Fetch-*` (older Safari, embedded WebViews)
  and the `SameSite=Lax` cookie's *site*-not-origin scope (any other `127.0.0.1:<port>` dev
  server) into a cross-origin **file-existence and image-dimension oracle** for arbitrary absolute
  paths. Classification happens before the waiver check; the image kind always requires
  `orchestration:read`.
- `isWaivableLocalRequest` additionally denies a present `Sec-Fetch-Site` that is not
  `same-origin`/`none`, closing the same fail-open for the existing text kinds.
- SVG reuses the existing, stricter `SVG_CONTENT_SECURITY_POLICY` (`default-src 'none'; …;
  sandbox`) via `assetResponseHeaders`, not the weaker `sandbox allow-popups` I proposed — which
  would have permitted subresource beacons out of a crafted SVG.
- `HttpServerResponse.file` **silently ignores its `contentType` option** (the platform derives
  the type from the path), so `Content-Type` is set explicitly in `headers` from a map mirroring
  the allow-list, and asserted on the wire in the route test.
- The byte path re-adds guards the text reader had and `HttpServerResponse.file` lacks: a
  `stat`-based **regular-file check** (a directory named `foo.png` otherwise emits a 200 with a
  bogus content-length, then errors *after* headers are flushed), a **size cap**, a NUL-byte check
  in `classifyViewerPath`, and an `orElseSucceed` 404 funnel matching `assetRouteLayer`.

**Correctness fixes applied**

- Image extensions reuse the shared `WORKSPACE_IMAGE_PREVIEW_EXTENSIONS` (`@t3tools/shared`),
  already consumed by both the web panel and the server. A divergent fourth list would have
  reintroduced this very bug for in-workspace images.
- The view-mode toggle resets when `absolutePath` changes (`key`). Today's `showHtml` survives a
  file switch; a single shared boolean would have made a `.html` open as *source* right after
  viewing a `.md` as HTML — verbatim the complaint this work exists to fix.
- `.mdx` keeps rendering as markdown (`classifyFileViewerKind` covers only `md|markdown`), and
  unclassified paths (`Makefile`, `Dockerfile`, `.env`, any unlisted extension) explicitly fall
  through to the code view, which is what the viewer does today.
- The viewer header takes `COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS`; otherwise the floating
  sidebar toggle lands on top of the address bar exactly when the sidebar is collapsed — i.e. in
  the new tab this change exists to improve. `viewer.$.tsx` joins the touched-files list.
- The source view surfaces `truncated`, which the payload already carries and the UI ignored.
- Image reload cache-busts the URL (the text query is disabled for images, so `refresh()` would
  otherwise be an inert button).
- URL path segments are encoded per segment, matching `handleOpenInNewTab`.

**Deferred (recorded, not built)**

- A **remote relay** environment is cross-origin, so a `SameSite=Lax` cookie will not authenticate
  the `<img>`/`<iframe>`. Correct fix is a token-authorized URL like `AssetAccess.issueAssetUrl`,
  which today requires a workspace root and so does not cover out-of-workspace paths. Still a
  strict improvement: local and same-origin remote work, and no surface silently serves the wrong
  machine's file.
- The sidebar stays collapsed after navigating *away* from `/viewer` in the same tab
  (`defaultOpen` seeds `useState` once and the provider never remounts). Harmless for the new-tab
  case this targets.
- On mobile the provider tracks `openMobile`, which already starts closed, so ask 2 is a
  desktop-surface change.

## Alternatives rejected

- **Point "open in new tab" at a new SPA path (`/view/$`), or move the raw route to `/raw/*`.**
  Designed against the falsified curl premise. Once the service worker's behaviour was measured,
  the SPA route was already the surface in play, so this was pure churn against a
  security-hardened route and its tests.
- **Base64 the image through a new RPC.** Inflates bytes ~33%, needs a new contract + wire schema,
  and duplicates a byte-serving route that already exists. The HTTP route is same-origin and gets
  streaming and caching semantics for free.
- **Relax the NUL-byte guard in `readFile`.** It is what keeps the *text* reader honest for every
  caller, including the editor. Images want bytes, not decoded text; a separate path is correct.
- **Render `.html` via the `uni-md2html` renderer.** That tool renders *markdown*. HTML is already
  a document.
- **Drop the app sidebar entirely on `/viewer` (render it standalone like `/pair`).** Goes beyond
  "hidden by default" and removes the ability to re-open it, which the chosen option asked to keep.

## Files touched

| File | Change |
|---|---|
| `apps/web/src/lib/codeFileTypes.ts` | `"image"` kind + `IMAGE_FILE_EXTENSIONS` |
| `apps/web/src/components/files/TrustedFileView.tsx` | kind-driven rendering; HTML toggle; `<img>` |
| `apps/web/src/components/files/viewerPath.ts` | `viewerRawUrl` helper |
| `apps/web/src/components/AppSidebarLayout.tsx` | `defaultOpen={!isViewerRoutePath(pathname)}` |
| `apps/server/src/http.ts` | `"image"` in `classifyViewerPath`; byte-serving branch; SVG CSP |

Tests alongside each: classifier tables, `classifyViewerPath` image cases, the route's
content-type/CSP behaviour, and the pathname helper.

## Follow-up shipped: relative assets in a rendered document (`a4fd5e120`)

The `<iframe src>` decision above made *relative* assets resolve correctly for the first time —
and immediately exposed that they could not be **fetched**. A multi-file prototype
(`index.html` + sibling `.js`/`.css`/images) rendered blank.

**Root cause: credentials, not MIME.** Serving `.html` under a CSP `sandbox` gives the document
an opaque origin, whose "site for cookies" is null — so the `SameSite=Lax` session cookie is not
sent on any subresource, and every relative script, stylesheet and image 401s. The document's own
navigation still authenticates because it inherits the top-level site, which is exactly why an
inline script ran and a `--self-contained` report rendered while an external script did not.

The discriminating probe: adding an `<img>` alongside the failing `<script>`. **The image failed
too** — and images are served with a correct content type, so MIME could not be the cause. `.js`
being served as `text/plain` + `nosniff` *was* a real second bug (a browser refuses to execute it),
but fixing it alone would have changed nothing.

**Fix: a capability URL in the path.** Cookies cannot reach an opaque origin, and un-sandboxing
means untrusted HTML runs at the app's origin where it can read the session and act as the user.
So the credential moves into the URL path: the document's own (already authenticated) navigation
mints a short-lived, directory-scoped token and 302s to `/viewer-asset/<token>/<path>`. A relative
`app.js` then resolves to `/viewer-asset/<token>/<dir>/app.js`, carrying the token with no
cooperation from the document. **A query string would not survive relative resolution; a path
segment does** — which is why the token is a path segment.

Deliberately *not* the session token: the sandboxed document can read this one out of
`document.location`, so it grants read-only access to one directory subtree for ten minutes and
nothing else. The document could already read its own directory by fetching those files itself, so
the token mainly bounds what leaks if the document is hostile and exfiltrates it.

Bounds on the asset route (token-only — no waiver, no cookie, since neither can work from an
opaque origin): realpath is resolved **before** the containment check, so a symlink planted inside
the granted directory cannot read outside it; the prefix test requires a trailing separator, so
`/a/proto-secrets` is not inside `/a/proto`; the token must be hex before any filesystem work; NUL
bytes rejected; size capped; and only the document itself is ever served as `text/html`.

`.js`/`.css`/fonts/json get their real content types on this route. Safe in a way `text/html`
would not be: none can be rendered as a document, so "untrusted bytes are never parsed as HTML"
still holds, and anything unrecognized still falls back to `text/plain`.

## Follow-ups deferred

- Relative/external assets inside a rendered `.html` do not load under `sandbox=""`.
- `TEXT_FILE_EXTENSIONS` (web) and `TEXT_VIEWER_EXTENSIONS` (server) are still two hand-synced
  lists; images now add a third pair.
