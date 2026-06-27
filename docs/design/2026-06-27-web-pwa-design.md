# Web app PWA support — design

**Date:** 2026-06-27
**Branch:** feat/web-pwa
**Status:** Designed + premises validated; implementing

## Goal

Make the t3code web app (`apps/web`) installable as a Progressive Web App: a real
home-screen / dock / app-drawer icon, a standalone app window (no browser chrome), a
splash, and fast app-shell load on repeat visits — with new builds reaching an open tab
through a user-controlled "Reload" prompt rather than a surprise reload.

**Explicitly out of scope: offline data.** The app is entirely backend-dependent over a
WebSocket RPC connection (`/ws`) and does nothing useful without the server. Service workers
do not intercept WebSocket upgrades, so the live connection is unaffected. The PWA value here
is installability + standalone window + instant repeat load, not offline operation.

## Approach

Use **`vite-plugin-pwa@1.3.0`** (`generateSW` / Workbox) with `registerType: "prompt"` and
`injectRegister: false` (we register the SW manually so we can guard it off in Electron).

### Caching strategy (the key decision)

Measured: the default `generateSW` precaches **all 325 build outputs ≈ 16 MB** (every lazy
Shiki language chunk, wasm, the 1.5 MB desktop-Clerk chunk, …). That would block SW install on
16 MB and re-fetch on every rebuild — wrong for an online-first, frequently-rebuilt app.

Chosen instead — **shell precache + runtime cache for hashed chunks**:
- `workbox.globPatterns` precaches only the small, always-needed shell:
  `index.html`, `manifest.webmanifest`, and `**/*.{css,woff2,ico,png,svg}` → **18 entries
  ≈ 731 KiB** (measured). **JS is deliberately excluded** from the precache.
- A `runtimeCaching` `CacheFirst` rule caches `/assets/*` (the content-hashed JS/CSS) on first
  use, bounded (`maxEntries: 300`, 30-day expiry, `purgeOnQuotaError`). Content-hashed URLs make
  `CacheFirst` safe (the URL changes whenever content changes). This is load-bearing, **not**
  redundant with the precache — the precache contains no JS by design.
- `navigateFallback: "index.html"` serves the SPA shell for client routes, with a
  `navigateFallbackDenylist` for every **server-owned** top-level route so they are never
  hijacked: `/api`, `/attachments`, `/.well-known`, and `/viewer`. (`/pair` is a *client*
  route — `apps/web/src/routes/pair.tsx` — so it is intentionally NOT denylisted; it needs the
  shell. `/ws` is a WebSocket upgrade the SW never sees.)

### Service-worker registration + update prompt

Registered manually in `apps/web/src/main.tsx`, guarded `if (!isElectron && import.meta.env.PROD)`
(`isElectron` already imported there; the desktop app loads from `file://` with hash history and
must never register a SW). Dynamic `import("virtual:pwa-register")`:
- `onNeedRefresh` → show a "New version available — Reload" toast via the existing
  `toastManager.add({ type, title, actionProps })` (`apps/web/src/components/ui/toast`); the
  action calls `updateSW(true)` (skip-waiting + reload).
- `onRegisteredSW(_, r)` → **periodic `r.update()` every 60 min.** Without this the prompt would
  essentially never fire: `registerType:"prompt"` only checks on load/navigation, and a coding
  session keeps one SPA tab open for hours with no navigations. This closes that gap.
- `onOfflineReady` intentionally unhandled (no value for a backend-dependent app).

### Manifest + icons

Plugin-generated `manifest.webmanifest` (`name`/`short_name` "T3 Code", `description`,
`start_url:"/"`, `scope:"/"`, `display:"standalone"`, `background_color`/`theme_color` `#161616`).
The manifest `theme_color` is static dark — accepted (app defaults to dark; cosmetic for light
users). Icons generated from `apps/marketing/public/icon.png` (1024px) into `apps/web/public/`:
`pwa-192x192.png`, `pwa-512x512.png` (`purpose: any`), and `pwa-maskable-512x512.png`
(`purpose: maskable`, ~12% safe-zone padding). Maskable is kept: one-time, cheap, and the
recognized bar for a polished Android install.

### index.html

The plugin injects `<link rel="manifest">` at build. Hand-add the iOS standalone hints Safari
needs (it ignores manifest `display`): `apple-mobile-web-app-capable`,
`apple-mobile-web-app-status-bar-style: black-translucent`, `apple-mobile-web-app-title`.

### Types

Append `/// <reference types="vite-plugin-pwa/client" />` to the existing
`apps/web/src/vite-env.d.ts` (no new file) for `virtual:pwa-register`.

## Premises validated (Hard Rule 8 — direct measurement)

| Premise | Probe | Result |
|---|---|---|
| `vite-plugin-pwa` builds under `vite-plus`/rolldown-vite | real `vp build` | ✅ emits `sw.js`+`manifest`+`workbox-*.js` |
| Shell-only precache avoids 16 MB | rebuild w/ scoped `globPatterns` | ✅ 731 KiB / 18 entries |
| Server serves `.webmanifest`/SW MIME, no server change | `@effect/platform-node/Mime.getType` | ✅ `application/manifest+json`, `text/javascript` |
| Manifest link auto-injected | inspect `dist/index.html` | ✅ present |
| Existing toaster + `isElectron` guard exist | read `ui/toast`, `env.ts` | ✅ |
| 1024px icon source | `sips` | ✅ `apps/marketing/public/icon.png` |

## Design review resolutions (Stage 6)

- **[blocker, fixed]** `/viewer` added to `navigateFallbackDenylist` (server-rendered docs opened
  via `window.open` as top-level navigations would otherwise get the cached shell).
- **[real gap, fixed]** periodic `r.update()` so long-lived sessions surface the update prompt.
- **[rejected]** "drop `/assets/` runtime cache as redundant" — rests on the assumption JS is
  precached; it is intentionally excluded. Kept, with a clarifying comment.
- **[adopted]** type reference goes in the existing `vite-env.d.ts`; dropped the "build a banner"
  contingency (the toaster exists).

## Alternatives rejected

- **Hand-written minimal SW (no Workbox).** Simpler in isolation, but on a `t3-rebuild`-heavy app
  the precache revisioning + outdated-cache cleanup Workbox automates is exactly what prevents
  stale-asset bugs; hand-rolling cache versioning is the footgun. Rejected.
- **Default full precache (16 MB).** Blocks SW install on 16 MB, re-fetches lazy language chunks
  nobody may open. Rejected in favor of shell precache + runtime cache.
- **Silent `autoUpdate`.** Would reload an active coding session mid-turn. Rejected for the prompt.

## Files touched

- `apps/web/vite.config.ts` — `VitePWA(...)` plugin block.
- `apps/web/package.json` — `vite-plugin-pwa` devDependency.
- `apps/web/src/main.tsx` — guarded `registerSW` + update-prompt toast + periodic update.
- `apps/web/index.html` — iOS standalone meta tags.
- `apps/web/src/vite-env.d.ts` — PWA client type reference.
- `apps/web/public/pwa-192x192.png`, `pwa-512x512.png`, `pwa-maskable-512x512.png` — new icons.
- No server changes.

## Verification

1. `pnpm --filter @t3tools/web build` → `sw.js`, `manifest.webmanifest`, `workbox-*.js`, icons
   emitted; precache stays shell-sized.
2. Full gate: typecheck + lint + unit + browser tests, 0 failures.
3. Real browser (agent-browser) on a served prod build: Application→Manifest valid + installable,
   Service Worker activated, instant repeat load, WS still connects; rebuild → "Reload" toast
   appears (not silent); Electron registers no SW.
