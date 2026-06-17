# Code & text file viewer — design

**Date:** 2026-06-17
**Branch:** `feat/code-file-viewer`
**Status:** Design

## Goal

When a thread message contains an inline-code file path like
`` `~/src/uni/.../validate_sql_qa.py` ``, give it the **same treatment** the app
already gives `.md`/`.html` paths:

- the path renders as a **clickable chip** with a **dropdown** offering *view in
  the side panel* + *copy path*;
- clicking opens the file in the **side panel**, where its content is rendered
  with **syntax highlighting**.

Extend coverage to `.txt` and a broad set of text/code file extensions.

## Current state (verified against live code, 2026-06-17)

- **Detection** — `classifyInlineCodePath()` in `apps/web/src/components/ChatMarkdown.tsx:237`
  returns `"html" | "markdown" | null` from the extension. Only inline-code spans
  that are a single whitespace-free token with no markup chars and no `://` qualify.
- **Chip** — `InlineFilePathChip()` (`ChatMarkdown.tsx:265`): `html` → plain button;
  `markdown` → chip body + caret dropdown (*Open as Markdown* / *Open as HTML* / *Copy path*).
- **Viewer** — `FileViewerContent()` (`apps/web/src/components/FileViewerSidebar.tsx:252`).
  `inferFileViewerKind()` (line 39) maps a path to a kind. Markdown view → `<ChatMarkdown>`;
  HTML view → sandboxed iframe. Reads via `api.projects.readFile()` /
  `renderMarkdownHtml()`. `FileViewerKind = "html" | "markdown"` in `fileViewerStore.ts:5`.
- **Highlighting infra already present** — `ChatMarkdown.tsx` highlights fenced code
  via `@pierre/diffs`: `getHighlighterPromise(language)` (line 439, loads a Shiki
  language on demand, falls back to `"text"`), `highlightedCodeCache` (LRU),
  `SuspenseShikiCodeBlock`/`UncachedShikiCodeBlock` (`codeToHtml`, line 849).
- **`api.projects.readFile`** reads *any* UTF-8 file inside the server sandbox
  (`allowedReadRoots`: home + temp + known project roots — `readAccess.ts`). **No
  extension gate.** So in-panel viewing of code files needs **no server change**.
- **Server `/viewer` HTTP route** (`apps/server/src/http.ts:341`) backs only the
  viewer's *Open in new tab* pop-out. `classifyViewerPath()` (line 315) gates
  extensions via `MARKDOWN_EXTENSIONS`/`HTML_EXTENSIONS`; unit-tested in
  `http.test.ts` (asserts `.env` and `Makefile` are rejected).

## Approach

Reuse, don't rebuild. Three load-bearing facts make this small:

1. The Shiki highlighter and its cache already exist client-side and fall back to
   `"text"` for unknown languages.
2. `@pierre/diffs` exports **`getFiletypeFromFileName(name)`** → a Shiki language id
   (with a guaranteed `"text"` fallback, handling compound + simple extensions). This
   is exactly what diffs uses to highlight files, so **no curated extension→language
   map is needed**.
3. `readFile` already serves arbitrary text files in-sandbox.

### 1. Shared module — `apps/web/src/lib/codeFileTypes.ts` (owns the whole ext→kind decision)

Per the design review, this module is the **single source of truth** for the
extension→kind decision across *all three* kinds, removing the pre-existing
duplication between `classifyInlineCodePath` and `inferFileViewerKind`.

- `TEXT_FILE_EXTENSIONS: ReadonlySet<string>` — curated text/code allow-list:
  `txt log csv tsv json json5 jsonc yaml yml toml ini conf cfg properties xml sql py
  rb go rs java kt kts c h cpp cc cxx hpp hh cs php swift scala sh bash zsh fish ps1
  lua pl pm r dart ex exs erl hs clj cljs cljc edn js cjs mjs jsx ts cts mts tsx vue
  svelte astro css scss sass less graphql gql proto gradle groovy tf hcl vim diff
  patch`. Deliberately **excludes** `.md`/`.html` (handled specially), binary/media,
  `.env`/extensionless (secrets / keeps the existing server test valid), and the
  ambiguous single-letter `.m`/`.mm` (high prose-false-positive risk — review #9).
- `classifyFileViewerKind(path): FileViewerKind | null` — the shared lookup:
  `.html/.htm` → `"html"`; `.md/.markdown` → `"markdown"`; extension in
  `TEXT_FILE_EXTENSIONS` → `"code"`; else `null`. (Lowercased, query/hash stripped.)
- `languageForPath(path): string` — `getFiletypeFromFileName(basename(path))`.

### 2. Detection + kind

- `FileViewerKind` (`fileViewerStore.ts`) → `"html" | "markdown" | "code"`.
- `classifyInlineCodePath()` keeps its conservative **guards** (single token, no markup
  chars, no `://`) as a pre-filter, then delegates to `classifyFileViewerKind(text)`.
  The local `InlineCodePathKind` type is dropped in favour of `FileViewerKind`
  (review #1) — the chip prop is already typed `FileViewerKind`.
- `inferFileViewerKind()` (FileViewerSidebar) becomes a thin re-export/delegate to
  `classifyFileViewerKind`.

### 3. Chip

`InlineFilePathChip` gains a `"code"` branch (the existing `=== "html"`/else label
logic is restructured into a three-way, not just appended — review #2): chip body
opens the viewer; a caret dropdown offers **View** (open in side panel) + **Copy path**
(no MD/HTML toggle). Icon: **`VscodeEntryIcon`** (real per-filetype icon, already
imported in `ChatMarkdown.tsx`; needs `theme` from `useTheme` — review NIT #4), so a
`.py` chip shows the Python icon. Ext-label shows the file's actual extension. New CSS
variant `.chat-markdown-file-chip-ext-code`.

### 4. Side-panel rendering

- Export a self-contained `HighlightedCodeView({ code, path })` from `ChatMarkdown.tsx`
  that resolves the theme (`useTheme` + `resolveDiffThemeName`), derives the language
  via `languageForPath`, reuses `highlightedCodeCache` + the existing
  `UncachedShikiCodeBlock` path, and renders the highlighted HTML in the
  `chat-markdown-shiki` container. **Critically it wraps its own
  `<CodeHighlightErrorBoundary>` + `<Suspense fallback=…>`** (review #4) — the viewer
  panel has no boundary of its own, and `UncachedShikiCodeBlock` calls `use()`/suspends.
- `FileViewerContent` gets a `current.kind === "code"` branch:
  `<ScrollArea><HighlightedCodeView code={state.contents} path={current.path} /></ScrollArea>`.
  Reads via the existing `readFile` call (the `else` branch already covers non-markdown-
  -html kinds, so no read-path change). `view` is ignored for code (document this in
  `fileViewerStore.ts`, alongside the existing html note — review #5). `KIND_BADGE`
  gets a **static `{ label: "Code", … }`** entry (review CONSIDER: a dynamic language
  label would leak diffs' surprising mappings like `.conf`→`nginx`; the filename is
  already shown in the address bar).

### 5. `/viewer` pop-out parity (server)

So *Open in new tab* doesn't 400 for code files:

- `classifyViewerPath()` returns `{ absolutePath, kind: "markdown" | "html" | "text" }`
  (replacing the `isMarkdown` boolean). A new `TEXT_VIEWER_EXTENSIONS` set mirrors the
  client allow-list (separate by design — different boundary; add a cross-ref comment
  in each so they don't drift — review NIT).
- The three-way route branch serves `kind === "text"` as a **new**
  `text/plain; charset=utf-8` response (raw, un-highlighted — **not** `text/html`, so
  no injection; code must not fall into the existing `.html` `text/html` branch —
  review #7), via the existing `readFile`, **still sending the `Cache-Control` +
  `Content-Security-Policy` sandbox headers** for defense-in-depth.
- `http.test.ts`: the 5 existing `classifyViewerPath` assertions are rewritten for the
  new `{ kind }` shape (review #8), positive `.txt`/`.py` cases added, `.env`/`Makefile`
  rejections kept.

## Design review outcome

One round, two adversarial reviewers (correctness/security + simplicity/compatibility).
All findings triaged and folded in above: shared-lib consolidation of the ext→kind
decision (top simplification), `FileViewerKind` reuse, self-contained Suspense/error
boundary in `HighlightedCodeView`, real per-filetype chip icon, static "Code" badge,
`/viewer` text branch hardening + test rewrite, and dropping ambiguous `.m`/`.mm`. Both
security questions (XSS via `codeToHtml`; `text/plain` serving + sandbox) confirmed
safe. No open MUST-FIX items remain. Exit: quiescent (no new issues, only triaged ones).

## Alternatives considered

- **Server-side highlighting (new RPC / render path like `readFileAsHtml`).** Rejected:
  no server Shiki, and the client already has a proven, cached highlighter. More
  surface, no benefit for the in-panel view.
- **Curated extension→language map.** Rejected: `getFiletypeFromFileName` already does
  this and is what diffs uses; a hand-rolled map would drift and silently lose
  highlighting.
- **Auto-chip *any* file with an extension.** Rejected: too many false positives
  (`image.png`, `v1.2`, `example.com`). A curated text/code allow-list keeps the chip
  conservative — matching the existing strictness for md/html.
- **Skip the `/viewer` server change, hide pop-out for code.** Rejected for parity:
  md/html both pop out; raw `text/plain` is a fine full-window escape hatch and the
  change is small + unit-tested.

## Files touched

- `apps/web/src/lib/codeFileTypes.ts` (new) + `codeFileTypes.test.ts` (new)
- `apps/web/src/fileViewerStore.ts` (kind union)
- `apps/web/src/components/ChatMarkdown.tsx` (detect, chip, export `HighlightedCodeView`)
- `apps/web/src/components/FileViewerSidebar.tsx` (infer, code branch, badge)
- `apps/web/src/index.css` (chip ext-code variant)
- `apps/server/src/http.ts` (`classifyViewerPath` shape, text serving) + `http.test.ts`

## Tradeoffs & limitations

- Pop-out new-tab view of code is raw text (no highlighting); in-panel is highlighted.
- Very large files: `readFile` caps at `MAX_READ_FILE_BYTES` (2 MB) — unchanged; large
  code files surface the existing read error. Acceptable.
- Allow-list is curated; an unusual extension won't chip. Easy to extend later.

## Follow-ups deferred

- Optional: retrofit *Copy path* onto the existing `.html` chip for consistency.
- Optional: line numbers / wrap toggle in the code viewer (the markdown code-block
  chrome has these; the viewer omits them for now).
