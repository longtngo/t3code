# Report file affordance: clickable chip + HTML sidebar viewer

**Date:** 2026-06-08
**Branch:** `t3code/report-link-clickable-sidebar-html`
**Prototype:** `~/reports/t3code/2026-06/2026-06-08-report-link-affordance-prototype.html`

## Goal

Two UX fixes for how the assistant's `.html`/`.md` file paths render in chat output:

1. **Mobile tap target.** Today an inline-code path gets a 16px trailing icon button
   inside a `white-space: nowrap` span. A long path scrolls the icon off-screen and the
   path text itself isn't clickable. → Make the whole affordance one clickable chip that
   stays inside the viewport, and make the file read as a prominent artifact.
2. **Multi-page HTML reports.** Today `.html` opens in a new browser tab as a `srcdoc`
   sandboxed iframe (opaque origin). Relative links to sibling pages (`architecture.html`)
   can't resolve → blank page. → Open `.html` in the existing right-side viewer sidebar
   (the one `.md` already uses) so we control rendering and can intercept intra-report
   navigation.

## Approach

### 1. Unified clickable chip (`InlineFilePathChip`)

Replace `InlineHtmlPathCode` + `InlineMarkdownPathCode` with one `<button>` chip:

- Layout: `[file icon] [html|md badge] [dir…/ basename] [chevron]`, the whole button is
  the click target.
- **Path display:** directory left-truncated with an ellipsis (`direction: rtl` trick),
  **basename always fully visible**. `max-width: 100%` → never overflows the viewport.
- Both `.html` and `.md` chips open the **sidebar** (no more new-tab default).
- `aria-label`/`title` = `Open <basename>`.

### 2. Generalized file viewer sidebar

- Rename `markdownViewerStore` → `fileViewerStore`; `MarkdownFileViewerSidebar` →
  `FileViewerSidebar`. Request gains a `kind: "html" | "markdown"`.
- **Markdown:** unchanged (`readFile` → `ChatMarkdown`).
- **HTML:** `readFile` → render in a sandboxed iframe (`allow-scripts allow-popups`,
  **no `allow-same-origin`** — preserves the opaque origin so report HTML can't reach the
  app's session token/storage). We prepend a tiny **click-interceptor script** to the
  file contents: it captures clicks on relative `<a href>` links ending in
  `.html/.htm/.md/.markdown` and `postMessage`s the href to the parent.
- **Intra-report nav:** the parent listens for that message (verifying
  `event.source === iframe.contentWindow`, since the opaque origin is `"null"`), resolves
  the href against the current file's directory (`cwd = dirname(resolvedPath)`, let the
  server `readFile` resolve `../`), infers kind from the extension, and pushes a new entry
  onto an in-sidebar **history stack**. A **back button** + **breadcrumb** walk the stack.
- **Pop-out to tab (HTML only):** a header button reuses the old new-tab flow
  (`window.open` + sandboxed iframe) on the already-loaded contents — preserves the
  "full browser tab" option the new-tab default used to give.

## Alternatives considered

- **Keep `.html` in a new tab, just fix relative links with a `<base>` tag.** Rejected: a
  `srcdoc` iframe has an opaque origin; a `<base href="file://…">` can't be fetched
  cross-origin and the file lives on the *server* in remote sessions anyway. Routing nav
  through `readFile` is the only thing that works remotely.
- **Drive nav through the store (stack in zustand).** Rejected: the back/forward history is
  viewer-local UI state; keeping it in component state keeps the store minimal and avoids
  leaking nav state across opens.
- **Truncate the path tail (hide extension).** Rejected: the basename is the useful part;
  left-truncating the directory keeps filename + extension visible.

## Files touched

- `apps/web/src/fileViewerStore.ts` (renamed from `markdownViewerStore.ts`)
- `apps/web/src/components/FileViewerSidebar.tsx` (renamed from `MarkdownFileViewerSidebar.tsx`)
- `apps/web/src/components/ChatMarkdown.tsx` (chip component + import)
- `apps/web/src/routes/__root.tsx` (mount import/tag)
- `apps/web/src/index.css` (chip styles)
- Tests: `fileViewerStore.test.ts`, `FileViewerSidebar.browser.tsx`, `ChatMarkdown.browser.tsx`

## Tradeoffs / limitations

- Relative **non-link** assets in report HTML (images, stylesheets referenced by relative
  path) still won't load in the iframe — there's no base URL and no asset-proxy. Out of
  scope; inline/data-URI assets and absolute URLs work. Charts via inline `<script>` work.
- The injected interceptor only handles `<a>` clicks, not `window.location`/JS navigation.
- Pop-out reuses already-loaded contents, so it won't reflect a file changed on disk after
  open (same staleness as the sidebar itself; re-open re-reads).

## Follow-ups deferred

- Optional: an asset-resolving proxy so relative images in reports render.
- Optional: forward button (history currently supports back only).
