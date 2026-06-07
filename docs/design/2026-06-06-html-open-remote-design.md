# Open HTML paths on remote sessions — 2026-06-06

## Goal

The inline "open in new tab" affordance for `.html`/`.htm` paths in LLM output
did nothing on remote sessions. Make it work regardless of where the server runs,
without letting untrusted report HTML steal the session token.

## Root cause

`ChatMarkdown.tsx` `InlineHtmlPathCode` called `readLocalApi().shell.openExternal("file://<abs>")`.
That targets the **viewer's** machine. On a remote session the file lives on the
server, so `file://` resolves to a non-existent local path (and there's no local
shell API in a plain web client at all). The markdown viewer shipped right before
this got it right by reading over the `projects.readFile` WS RPC; the HTML button
never got the same treatment.

## Approach (chosen)

Read the file over the existing `api.projects.readFile` RPC (remote-capable,
auth'd, 2 MiB cap — same path the markdown viewer uses), then render it in a new
tab inside a **sandboxed iframe**:

- `window.open("", "_blank")` is called **synchronously** in the click handler so
  the browser keeps the user-gesture (a deferred `window.open` after the `await`
  would be pop-up-blocked). `noopener` is omitted (it makes `window.open` return
  `null`); `win.opener = null` severs the back-reference instead.
- The fetched HTML is injected as `iframe.srcdoc` with
  `sandbox="allow-scripts allow-popups"` — **`allow-same-origin` deliberately
  withheld**, so the document gets an opaque origin and cannot read this app's
  `localStorage`/session token even though the wrapper tab is same-origin.
- Closed-tab-before-resolve (`if (win.closed) return`) and empty-file
  ("This file is empty.") paths are handled.

The affordance now requires `config.environmentId` (matching the markdown path),
since opening always reads over the backend.

## Alternatives considered

- **`blob:` top-level navigation** (the originally-approved "blob via readFile").
  Rejected after review: a `blob:` URL inherits the **creator's origin**, so the
  report HTML would execute in t3code's origin and could exfiltrate the bearer
  token — worse on remote sessions, where the token is most valuable. The
  sandboxed-iframe variant keeps the same client-only simplicity (no server
  changes) but neutralizes that with an opaque origin. Chosen instead.
- **Hash → server path dictionary** (user's first proposal). Rejected: it adds
  mutable server state to gate one endpoint while `projects.readFile` already
  serves arbitrary authed reads next to it — path obfuscation isn't the boundary,
  authentication is. It wouldn't actually reduce the arbitrary-read capability.
- **Authenticated HTTP endpoint + stateless signed token + `Content-Security-Policy: sandbox`.**
  The robust answer for **multi-file** HTML (coverage/Playwright reports with
  relative assets) and files >2 MiB, which the iframe/blob approach can't render.
  Deferred — see follow-ups. The signed token (HMAC path+expiry) is the stateless
  realization of the user's hashing instinct, for when `window.open` to a remote
  origin can't carry an auth header.

## Files touched

- `apps/web/src/components/ChatMarkdown.tsx` — rewrote `InlineHtmlPathCode`
  (remote read + sandboxed iframe), removed `buildFileUrl`, gated HTML on
  `environmentId`.
- `apps/web/src/components/ChatMarkdown.browser.tsx` — updated/added tests.

## Tradeoffs & known limitations

- **Self-contained HTML only.** `srcdoc` (like a blob) can't resolve relative
  external assets, so multi-file reports render without their sibling CSS/JS.
  Needs the HTTP-endpoint follow-up.
- **2 MiB cap** inherited from `readFile`.
- **Test depth:** the security test asserts the `sandbox` attribute string (real
  DOM state) but can't exercise browser-level opaque-origin enforcement in the
  harness.
- **Pre-existing surface:** `projects.readFile` reads arbitrary absolute/`~`
  paths outside the workspace (2 MiB). This feature reaches it from chat output,
  but so does the markdown viewer already; auth gates both. Noted as follow-up.

## Follow-ups deferred

1. Authenticated HTTP file endpoint (signed token + `CSP: sandbox`) for
   multi-file / large HTML reports.
2. Consider scoping `projects.readFile` to assistant-emitted/session paths
   (applies to markdown viewer too), if the arbitrary-read surface is a concern.
