# LLM output path affordances — design (2026-06-06)

## Goal

When an assistant message displays a file path inside inline code (backticks),
attach an inline affordance next to it:

1. **HTML path** (e.g. `` `/var/folders/.../architecture-review-….html` ``) →
   an "open in new tab" icon button that opens the file via the `file://`
   protocol (external browser tab).
2. **Markdown path** (e.g. `` `~/reports/pickup-v2/2026-06/2026-06-06-decisions-needed.md` ``) →
   an "open" icon button that opens a right-side panel rendering the file's
   markdown content in view mode (read-only, formatted).

"Done" = paths in assistant inline code grow these affordances; HTML opens in a
new browser tab via `file://`; markdown opens in an in-app right panel rendered
with the existing `ChatMarkdown` renderer; existing rendering (file links, code
blocks, skill chips, syntax highlighting) is unchanged.

## Where paths show up

Assistant text is rendered by `apps/web/src/components/ChatMarkdown.tsx` via
`react-markdown` + `remark-gfm`. Today:

- Markdown links `[text](path)` → `MarkdownFileLink` (opens in editor).
- Inline code `` `path` `` → a plain `<code>` (no custom component, no affordance).
- Bare paths in prose → not linkified at all.

LLMs (and the user's own examples) overwhelmingly wrap paths in **backticks**, so
the chosen detection point is **inline code**. This is a single, contained
injection point and avoids disturbing the existing link/codeblock UX. Bare-prose
path linkification is explicitly out of scope (bigger lift, not in the examples).

## Approach

### Detection (client, ChatMarkdown.tsx)

Add a custom `code` component, `MarkdownCode`, to the react-markdown components map.

- **Block vs inline:** fenced/indented code is rendered by the existing `pre`
  handler (which calls `extractCodeBlock` and Shiki). `MarkdownCode` treats a
  node as *block* when it has a `language-…` className **or** its text contains a
  newline, and renders a transparent native `<code className>…</code>` in that
  case. Inline = neither.
- `extractCodeBlock` currently gates on `onlyChild.type === "code"`. Because
  registering a custom `code` component changes the child element's `type`, we
  extend the gate to also accept `MarkdownCode` (a stable module-level reference).
  For fenced blocks `pre` still extracts the code itself and renders Shiki;
  `MarkdownCode` is never actually rendered for blocks. Defense in depth: if the
  gate ever misses, `pre` falls back to `<pre>{children}</pre>` → `MarkdownCode`
  block branch → plain `<code>` (no crash, only loses highlighting).
- For **inline** code, extract the plain text and classify with a small,
  conservative detector `classifyInlineCodePath(text)`:
  - trimmed, single token (no whitespace),
  - looks like a path (starts with `/`, `~/`, `./`, `../`, a Windows drive, or
    contains a `/`, or is a bare `name.ext`),
  - ends in `.html`/`.htm` → `{ kind: "html" }`, or `.md`/`.markdown` →
    `{ kind: "markdown" }`.
  Anything else → render the normal inline `<code>`.

Config (`cwd`, `environmentId`, `theme`) reaches the module-level `MarkdownCode`
via a new `ChatMarkdownConfigContext` provided in `ChatMarkdown`. This keeps
`MarkdownCode` a stable reference (needed by `extractCodeBlock`) while giving it
the data it needs. `ChatMarkdown` gains an optional `environmentId` prop, threaded
from `MessagesTimeline` (`ctx.activeThreadEnvironmentId`). Callers that don't pass
it (PlanSidebar/ProposedPlanCard) simply won't show the markdown-open button
(graceful — it needs an environment to read the file).

### Feature 1 — HTML open-in-new-tab (client only)

Render the inline `<code>` followed by a small icon button (`ExternalLinkIcon`,
lucide). On click, resolve the path to an absolute path and call
`readLocalApi()?.shell.openExternal("file://" + absolutePath)`:

- absolute path → used directly,
- `./` / `../` / bare relative → resolved against `cwd` (reuse
  `resolveMarkdownFileLinkMeta(path, cwd).filePath`),
- desktop → Electron `shell.openExternal` opens the default browser tab; web →
  `window.open` (best effort; browsers may block `file://` from an https origin —
  acceptable, desktop is primary).

No backend change. `~/…` HTML paths are an accepted edge-case limitation
(home can't be expanded client-side); the examples are absolute.

### Feature 2 — Markdown viewer side panel

Markdown needs the **file contents** to render formatted. No read-file RPC exists
(only `projects.writeFile`/`searchEntries`/`filesystem.browse`). Add a symmetric
`projects.readFile` RPC.

**Backend (`projects.readFile`):** mirrors `writeFile` wiring across:
- `packages/contracts/src/project.ts` — `ProjectReadFileInput { cwd, path }`,
  `ProjectReadFileResult { contents, resolvedPath }`, `ProjectReadFileError`.
- `packages/contracts/src/rpc.ts` — `WS_METHODS.projectsReadFile`,
  `WsProjectsReadFileRpc`, register in `WsRpcGroup`.
- `apps/server/src/workspace/Services/WorkspaceFileSystem.ts` — `readFile` on the
  shape.
- `apps/server/src/workspace/Layers/WorkspaceFileSystem.ts` — implement: expand
  `~`, resolve relative paths against `cwd`, **allow absolute paths outside the
  workspace root** (reports live in `~/reports`, tmp HTML in `/var/folders` — the
  whole point), read UTF-8, and reject files larger than a 2 MiB cap (clear
  error rather than an unbounded read).
- `apps/server/src/ws.ts` — handler + auth scope `AuthOrchestrationReadScope`
  (read-only, same as `searchEntries`/`filesystem.browse`).
- `packages/client-runtime/src/wsRpcClient.ts` — `projects.readFile` type + impl.
- `packages/contracts/src/ipc.ts` — `EnvironmentApi.projects.readFile`.
- `apps/web/src/environmentApi.ts` — wire `readFile`.

**Security note:** `readFile` lets an authenticated client read arbitrary host
files. This matches the existing trust model — the same authenticated client can
already `shell.openInEditor` any path, open a terminal, and `writeFile`. Gated by
the read auth scope, capped at 2 MiB, returned as text only.

**Frontend:**
- `apps/web/src/markdownViewerStore.ts` — zustand store
  `{ open, request: { path, cwd, environmentId } | null, openMarkdownViewer(req),
  closeMarkdownViewer() }` (mirrors `commandPaletteStore`).
- `apps/web/src/components/MarkdownFileViewerSidebar.tsx` — subscribes to the
  store; when open, calls `readEnvironmentApi(environmentId).projects.readFile`,
  shows loading/error/empty states, renders contents via `ChatMarkdown` inside a
  `RightPanelSheet` (overlay drawer = sidebar). Header with file basename + close.
- Mounted **once** in `apps/web/src/routes/__root.tsx` `RootRouteView` (single
  global instance, avoids multi-`ChatView` duplication).
- The inline markdown button calls
  `openMarkdownViewer({ path, cwd, environmentId })`.

## Alternatives considered

- **Detect bare paths in prose, not just inline code.** Rejected for scope:
  requires text tokenization across `p`/`li` children; examples are backticked;
  high false-positive risk. Revisit later if requested.
- **Add the affordance to `MarkdownFileLink` (markdown-link case) too.** Deferred:
  the examples are backtick paths; links already open in editor. Could be a
  follow-up but not needed for the ask.
- **Open markdown via `openExternal` (like HTML) instead of an in-app panel.**
  Rejected: that shows raw/unrendered text in the browser; the ask is "render the
  markdown file in view mode" → must read contents + render with `ChatMarkdown`.
- **Render markdown by serving the file over HTTP and `openExternal`.** Rejected:
  heavier (static route + auth), and still not in-app/formatted-in-panel.
- **Reuse `writeFile`'s `resolveRelativePathWithinRoot` for read.** Rejected: it
  rejects absolute + outside-root paths, which is exactly what report/tmp paths
  are.
- **Per-`ChatView` local state for the viewer (like `PlanSidebar`).** Rejected:
  the open trigger is deep inside `ChatMarkdown`; a global store + single root
  mount decouples cleanly and avoids prop threading through the message tree.

## Files touched

New: `markdownViewerStore.ts`, `MarkdownFileViewerSidebar.tsx`, this doc, tests.
Edited: `ChatMarkdown.tsx`, `MessagesTimeline.tsx`, `__root.tsx`, contracts
(`project.ts`, `rpc.ts`, `ipc.ts`), `wsRpcClient.ts`, `environmentApi.ts`,
server (`ws.ts`, `WorkspaceFileSystem` service + layer), CHANGELOG.

## Tradeoffs / limitations

- Only **inline-code** paths get affordances (not bare prose). Intentional.
- `~/…` paths resolve fine: the client `terminal-links.resolvePathLinkTarget`
  expands `~/` via `inferHomeFromCwd(cwd)` (used for HTML `file://`), and the
  server expands `~` for the markdown read. No limitation here.
- `readFile` broadens the read surface (mitigated: existing trust model, read
  scope, 2 MiB cap, text-only).
- `file://` open from a hosted/web (https) origin may be blocked by the browser;
  desktop is the primary target and works.

## Follow-ups deferred

- Bare-prose path detection.
- "Open in new tab" / "view markdown" actions on `MarkdownFileLink` (markdown-link
  paths) for parity.
- Syntax-aware preview for other openable types (json/png) in the viewer panel.
