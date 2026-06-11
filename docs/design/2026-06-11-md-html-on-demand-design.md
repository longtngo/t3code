# On-demand MD→HTML rendering in the file viewer — 2026-06-11

## Goal

Stop maintaining a hand-written `.html` copy of every `.md` report. Instead, when a
user views a markdown file in the file-viewer sidebar, let them switch to an
**HTML mode** that renders a styled, standalone HTML document generated on demand
by the backend, cached by file mtime/content-hash so repeat views are instant.

Two entry points:
1. **Chip dropdown** — the existing inline `.md` file chip in chat messages gains a
   small dropdown: default click opens **Markdown mode**; the dropdown offers
   **Open as HTML**.
2. **Sidebar toolbar toggle** — when viewing a `.md` file, the sidebar toolbar
   shows an **MD / HTML** toggle to switch the current view in place.

Plus a layout change: the file viewer becomes a **side-by-side, resizable** right
panel (like the diff panel) on desktop, instead of the current overlay sheet.

## Background (current state, verified)

- `apps/web/src/fileViewerStore.ts` — zustand store: `{open, request}` where
  `request = {path, cwd, environmentId, kind: "html"|"markdown", requestId}`.
  Opened **only** by `InlineFilePathChip` in `ChatMarkdown.tsx`.
- `apps/web/src/components/FileViewerSidebar.tsx` — rendered globally in
  `routes/__root.tsx:155` inside a `RightPanelSheet` (overlay). Markdown →
  `ChatMarkdown`; HTML → sandboxed `<iframe srcdoc>` (sandbox `allow-scripts
  allow-popups`, **no** `allow-same-origin`). Has a `handlePopOut` "open in new
  tab" for HTML. Reads content via `readEnvironmentApi(env).projects.readFile`.
- Diff panel (`routes/_chat.$environmentId.$threadId.tsx`) is the layout template
  to copy: desktop renders `<SidebarInset><ChatView/></SidebarInset>` +
  `DiffPanelInlineSidebar` (a `SidebarProvider`/`Sidebar side="right"`/`SidebarRail`
  with `resizable={{minWidth,maxWidth,shouldAcceptWidth,storageKey}}`); below the
  `RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY` (980px) it falls back to `RightPanelSheet`.
  Open state lives in the URL search param `?diff=1`. Width persists to localStorage.
- Server: `projects.readFile` RPC — contract in `packages/contracts/src/project.ts`,
  registered in `packages/contracts/src/rpc.ts` (`WS_METHODS.projectsReadFile`),
  handled in `apps/server/src/ws.ts` calling `WorkspaceFileSystem.readFile`
  (`apps/server/src/workspace/Layers/WorkspaceFileSystem.ts`), which stats (mtime +
  size available), enforces a 2 MB cap, and reads UTF-8. **No markdown library
  exists server-side** (`marked`/`remark`/`rehype` are only in `apps/web`).
- "md2html" is not a literal tool in the repo; the user means a generic markdown→HTML
  converter on the backend.

## Approach (chosen)

### Backend — `projects.renderMarkdownHtml` (unary RPC, in-memory cache)

New RPC `projects.renderMarkdownHtml`:
- **Input** `{cwd, path}` (same shape/validation as `ProjectReadFileInput`).
- **Output** `{html, resolvedPath, fromCache}` — `html` is a complete, self-contained
  `<!doctype html>` document.
- **Error** `ProjectRenderMarkdownHtmlError` (mirrors `ProjectReadFileError`).
- Required scope: `AuthOrchestrationReadScope` (same as `readFile`).

Add a `readFileAsHtml` method to the **existing** `WorkspaceFileSystem` service (it
already owns path resolution + stat + the 2 MB cap), rather than a new service — lower
blast radius, reuses the security-relevant path logic verbatim. `marked`, the HTML
template, and the cache live as module-level helpers / a layer-closure `Map` in
`apps/server/src/workspace/Layers/WorkspaceFileSystem.ts`:
1. Resolve the absolute path with the **same** code path as `readFile` (expand `~`,
   absolute allowed, else resolve against cwd) — factored into a shared local function
   so the security behavior stays identical.
2. `stat` the file. Enforce the same 2 MB cap. Reject non-files.
3. **Cache** (in-memory, bounded LRU keyed by `resolvedPath`). Note: this is a
   per-server-process cache — it avoids re-converting an unchanged file within a running
   process; it is *not* a cross-restart or cross-machine shared store (a cold cache after
   restart simply re-converts, which is cheap). Entry: `{mtimeMs, size, hash, html}`.
   Effect's `FileSystem.stat` returns `mtime: Option<Date>` and `size: bigint`, so
   `mtimeMs` is derived via `Option.map((d) => d.getTime())` (and `size` via `Number(...)`):
   - Fast path: if `stat` mtimeMs **and** size match the cached entry → return cached
     html with `fromCache: true`, **without reading or hashing** the file.
   - Else read the file, compute a SHA-256 content hash. If the hash matches the cached
     entry → refresh the cached `mtimeMs`/`size` and return cached html (`fromCache:
     true`). (Covers touch-without-change.)
   - Else convert markdown → HTML, store the new entry, return `fromCache: false`.
   - LRU cap (e.g. 64 entries) bounds memory; eviction is least-recently-used.
4. **Conversion**: `marked` (GFM enabled) → body HTML, wrapped in a self-contained
   document template with embedded CSS (compact GitHub-like readable stylesheet) so the
   result is a real standalone report (shareable, pop-out-able). Raw HTML inside the
   markdown is passed through (the same trust model as the existing `.html` viewer:
   the **sandboxed iframe** without `allow-same-origin` is the security boundary, so no
   separate server-side HTML sanitizer is added — consistent with how raw `.html`
   files are already rendered).

`marked` is added as a dependency of `apps/server`.

### Frontend — view mode, two entry points, inline resizable layout

**Store** (`fileViewerStore.ts`): add `view: FileViewerView` to `FileViewerRequest`
where `type FileViewerView = "markdown" | "html"`. `openFileViewer` accepts an
optional `view` (default `"markdown"`). For an `.html` source file, `view` is
irrelevant (always rendered as HTML).

**Render target** in `FileViewerContent` is derived from `(kind, view)`:
- `kind === "html"` → `readFile` → sandboxed iframe (unchanged).
- `kind === "markdown"` & `view === "markdown"` → `readFile` → `ChatMarkdown` (unchanged).
- `kind === "markdown"` & `view === "html"` → `renderMarkdownHtml` RPC → sandboxed
  iframe, with a **loading spinner** while the RPC is in flight.

The view is tracked per history entry (local state seeded from `request.view`), so the
toolbar toggle and intra-report navigation both work. Switching MD↔HTML re-runs the
appropriate fetch; the backend cache makes repeat HTML instant.

**Iframe / link interception (review fix)**: today the sandboxed iframe and the
`LINK_INTERCEPTOR_SCRIPT` are gated on `current.kind === "html"`. With md→HTML, the
displayed content is HTML even though `kind === "markdown"`. The render condition and
the script prepend must therefore key on *"is the displayed content HTML"* —
`current.kind === "html" || current.view === "html"` — so md-generated HTML also gets
the interceptor and intra-report relative links keep posting up to the panel for in-app
navigation. `state.contents` holds the *generated* HTML in that mode, so the existing
pop-out (which reuses `state.contents`) works unchanged.

**Entry point 1 — chip dropdown** (`InlineFilePathChip` in `ChatMarkdown.tsx`): for
`kind === "markdown"`, render the chip as a split control — the main body opens
Markdown mode (default, unchanged behavior); a trailing caret opens a `DropdownMenu`
(`ui/menu`) with **Open as Markdown** / **Open as HTML**, each calling
`openFileViewer({..., view})`. To avoid mobile/tap ambiguity, the chip is **two distinct
adjacent buttons** inside one container — a main button (opens Markdown, default,
single-click behavior preserved) and a separate small caret button (own `aria-label`,
opens the `DropdownMenu`) — not one split region. For `kind === "html"`, the chip is
unchanged (no dropdown — an `.html` file has a single view).

**Entry point 2 — toolbar toggle** (`FileViewerContent` toolbar): when
`current.kind === "markdown"`, show a small **MD / HTML** toggle group. Selecting HTML
sets the current entry's `view` to `"html"` (triggers the RPC + spinner); selecting MD
restores the `ChatMarkdown` view. The existing "open in new tab" pop-out is extended to
also appear for markdown rendered as HTML (it already reuses the loaded HTML contents).

**Layout — inline resizable sidebar**: introduce a `FileViewerInlineSidebar`
mirroring `DiffPanelInlineSidebar`, rendered in the chat thread route:
- Desktop (above 980px): inline `Sidebar side="right"` with `resizable`
  (`storageKey: "chat_file_viewer_sidebar_width"`, own min/max, a `shouldAcceptWidth`
  guarding composer width — reuse the diff panel's guard).
- Mobile (≤980px): `RightPanelSheet` (current behavior preserved).
- Driven by `useFileViewerStore().open` (not the URL).
- The global mount in `__root.tsx` is removed; rendering moves into the chat thread
  route (safe — the only opener is chat messages, which only exist on that route).

**Mutual exclusion with the diff panel (race-free, derive-don't-sync)**: the file viewer
(zustand `open`) and diff panel (URL `?diff=1`) share the right region. To avoid
effect ping-pong / flashes, the layout is **derived**, not synchronized:
- `renderDiff = diffOpen && !fileViewerOpen` — the file viewer wins when both flags are
  set, so there is never a frame with both panels mounted, even if the URL still carries
  `diff=1` for one tick.
- `openDiff` calls `closeFileViewer()` (synchronous store action) before navigating.
- A single **one-directional** cleanup effect strips `?diff=1` from the URL when the file
  viewer is open (`if (fileViewerOpen && diffOpen) closeDiff()`). There is no reverse
  effect, so no loop.

The expand/collapse full-width button is retained for the sheet/mobile path; on desktop
the resize handle provides width control (the expand toggle is kept for parity).

## Alternatives considered

- **Client-side md→HTML** (convert in the browser with the existing
  react-markdown/remark stack). *Rejected*: the user explicitly asked for backend
  conversion with mtime/hash caching so the generated artifact is canonical, shared
  across clients/sessions, and pop-out-able as a standalone document; client-side
  conversion can't share a cache and would re-do work per client. (We still keep
  `ChatMarkdown` for **MD mode** — that's the in-app rendering, not the standalone doc.)
- **Streaming RPC** (`stream: true`, chunked HTML). *Rejected*: `marked` conversion of a
  ≤2 MB report is single-digit-to-low-tens of ms; a sandboxed `srcdoc` iframe cannot
  progressively render without resetting `srcdoc` (which reloads/flickers the frame).
  A unary RPC + a loading spinner satisfies "show a loading indicator while the HTML is
  generated" with far less complexity and no flicker. (Deliberate deviation from the
  literal "stream the data back" phrasing; documented for review.)
- **Disk/file cache for generated HTML**. *Rejected for v1*: in-memory LRU is simpler,
  needs no cleanup, and conversion is cheap enough that a cold cache after restart is a
  non-issue. Revisit only if profiling shows it matters.
- **Three side-by-side panels (chat | diff | file viewer)**. *Rejected*: too cramped;
  the resize guard already fights for composer width with one right panel. Mutual
  exclusion matches "like the diff panel" (a single right panel).
- **Server-side HTML sanitizer (DOMPurify/sanitize-html)**. *Rejected*: the sandboxed
  iframe (no `allow-same-origin`) is already the trust boundary and is the exact model
  used for raw `.html` files today; adding a sanitizer only for md-generated HTML would
  be inconsistent and is unnecessary defense given the boundary. (Re-examine if the
  sandbox model ever changes.)

## Files / modules touched

**Backend**
- `apps/server/package.json` — add `marked`.
- `packages/contracts/src/project.ts` — `ProjectRenderMarkdownHtmlInput/Result/Error`.
- `packages/contracts/src/rpc.ts` — `WS_METHODS.projectsRenderMarkdownHtml`,
  `WsProjectsRenderMarkdownHtmlRpc`, add to the RPC group union/array.
- `apps/server/src/workspace/Services/WorkspaceFileSystem.ts` — add `readFileAsHtml` to
  the shape interface.
- `apps/server/src/workspace/Layers/WorkspaceFileSystem.ts` — implement `readFileAsHtml`
  (shared path-resolve helper + stat + cap + LRU cache + `marked` + HTML template).
- `apps/server/src/ws.ts` — register handler + required scope (`AuthOrchestrationReadScope`).
- `packages/client-runtime/src/wsRpcClient.ts` — add `projects.renderMarkdownHtml`.

Full RPC-registration checklist (to avoid a half-wired RPC): `WS_METHODS` entry →
`Rpc.make` definition → add to the RPC group array → `RPC_REQUIRED_SCOPE` entry →
`ws.ts` handler → `wsRpcClient.ts` client method.

**Frontend**
- `apps/web/src/fileViewerStore.ts` — `view` field + `FileViewerView` type.
- `apps/web/src/components/ChatMarkdown.tsx` — chip dropdown for markdown.
- `apps/web/src/components/FileViewerSidebar.tsx` — toolbar MD/HTML toggle, view-aware
  load (RPC for md→html), loading spinner, inline-vs-sheet rendering.
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` — `FileViewerInlineSidebar`,
  mutual exclusion with diff, sheet fallback.
- `apps/web/src/routes/__root.tsx` — remove global FileViewerSidebar mount.

## Tradeoffs and known limitations

- In-memory cache is per server process; a restart re-converts on first view (cheap).
- Mutual exclusion means a user can't view a diff and a report simultaneously — a
  deliberate space tradeoff matching the diff panel's single-right-panel model.
- The standalone HTML template's CSS is a fixed readable theme (not user-branded). The
  user's branded-report templating is out of scope for this feature; HTML mode produces
  a clean default-styled document. (Follow-up candidate: themeable template.)

## Follow-ups deferred

- Optional: themeable/branded HTML template.
- Optional: disk-backed cache if profiling ever warrants it.
- Optional: allow diff + file viewer to coexist (stacked or tabbed right panel).
