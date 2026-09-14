import * as NodeZlib from "node:zlib";

import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import compression from "compression";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import "vite-plus/test/config";
import { visualizer } from "rollup-plugin-visualizer";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig, type Connect, type Plugin } from "vite-plus";
import pkg from "./package.json" with { type: "json" };

import { DEV_PROXIED_PATH_PREFIXES } from "@t3tools/shared/devProxy";

import { loadRepoEnv } from "../../scripts/lib/public-config";
import { thirdPartyLicensesPlugin } from "../../scripts/lib/third-party-licenses";
import { tailwindPlugins } from "./vite/tailwind";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

// Single-origin dev is signalled positively, because it cannot be inferred
// from the absence of VITE_HTTP_URL/VITE_WS_URL: the runner deletes those keys
// but `loadRepoEnv` merges `.env`/`.env.local` *underneath* the process env, so
// a developer with either URL in their `.env` gets it back here. Baking it then
// pins the client to localhost and breaks every non-localhost origin — the
// exact failure single-origin mode exists to prevent, and an invisible one
// since the page still loads.
const isSingleOriginDev = process.env.T3CODE_SINGLE_ORIGIN_DEV === "1";

const port = Number(process.env.PORT ?? 5733);
const explicitHost = process.env.HOST?.trim();
const host = explicitHost || "localhost";
const configuredWsUrl = isSingleOriginDev ? undefined : process.env.VITE_WS_URL?.trim();
const configuredHttpUrl = isSingleOriginDev ? undefined : process.env.VITE_HTTP_URL?.trim();
const configuredRelayUrl = repoEnv.VITE_T3CODE_RELAY_URL?.trim() || "";
const configuredClerkPublishableKey = repoEnv.VITE_CLERK_PUBLISHABLE_KEY?.trim() || "";
const configuredClerkJwtTemplate = repoEnv.VITE_CLERK_JWT_TEMPLATE?.trim() || "";
const configuredClerkCliOAuthClientId = repoEnv.VITE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() || "";
const configuredRelayTracingUrl = repoEnv.VITE_RELAY_OTLP_TRACES_URL?.trim() || "";
const configuredRelayTracingDataset = repoEnv.VITE_RELAY_OTLP_TRACES_DATASET?.trim() || "";
const configuredRelayTracingToken = repoEnv.VITE_RELAY_OTLP_TRACES_TOKEN?.trim() || "";
const configuredHostedAppChannel = process.env.VITE_HOSTED_APP_CHANNEL?.trim() || "";
const configuredAppVersion = process.env.APP_VERSION?.trim() || pkg.version;
const configuredHostedAppUrl = (() => {
  const explicitHostedAppUrl = process.env.VITE_HOSTED_APP_URL?.trim();
  if (explicitHostedAppUrl) {
    return explicitHostedAppUrl;
  }
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return undefined;
})();
const sourcemapEnv = process.env.T3CODE_WEB_SOURCEMAP?.trim().toLowerCase();

// Vite 8.1's experimental bundled dev mode: serves rolldown-bundled chunks in
// dev for much faster startup/reload on large module graphs, with HMR served
// as hot patches. Opt-in while experimental: T3CODE_BUNDLED_DEV=1 pnpm dev:web
// The dev runner defaults this on for --share runs (remote browsers pay a
// round trip per import level in unbundled dev); T3CODE_BUNDLED_DEV=0 opts out.
const bundledDevEnv = process.env.T3CODE_BUNDLED_DEV?.trim().toLowerCase();
const bundledDev = bundledDevEnv === "1" || bundledDevEnv === "true";

const buildSourcemap: boolean | "hidden" =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

// Component behaviour that needs a real DOM: `*.dom.test.tsx`. Kept as a separate project so the
// ~4,800 logic tests keep running under the much cheaper `node` environment - a DOM per test file
// is not free, and almost none of them need one.
const domTestProject = {
  extends: true,
  test: {
    name: "dom",
    environment: "happy-dom",
    include: ["src/**/*.dom.test.tsx"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
    setupFiles: ["../../packages/shared/src/testing/longTempDir.ts"],
  },
} satisfies TestProjectInlineConfiguration;

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    // `*.dom.test.tsx` belongs to the `dom` project above; without this exclusion both projects
    // claim it and the DOM tests also run under `node`, where they cannot pass.
    exclude: ["src/**/*.dom.test.tsx"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Sized for the full monorepo run, not for this project alone. A handful of these tests do
    // real work - WASM highlighting through a worker thread, building and parsing a VSIX - and
    // when `pnpm verify` runs every package's suite at once they slow down by at least 13x.
    // Measured 2026-09-05: 10 tests exceed 1.2s in isolation and the slowest takes 7.3s, so at
    // that factor every one of them blows a 15s budget. Two of them did, on separate gate runs,
    // producing a red gate with nothing broken.
    //
    // The generous budget costs only detection latency on a genuinely hung test; the ~4,790
    // tests that finish in milliseconds are unaffected either way. Raising it is what the
    // previous 5s -> 15s bump did for the same reason, one load factor too early.
    hookTimeout: 120_000,
    testTimeout: 120_000,
    setupFiles: ["../../packages/shared/src/testing/longTempDir.ts"],
  },
} satisfies TestProjectInlineConfiguration;

function resolveDevProxyTarget(
  backendPort: string | undefined,
  wsUrl: string | undefined,
): string | undefined {
  // Browser dev is single-origin: the backend port is proxied through this
  // server so the app works from any origin (localhost, tailnet, LAN, phone).
  // T3CODE_PORT is set by scripts/dev-runner.ts for every non-desktop mode.
  const port = Number(backendPort?.trim());
  if (Number.isInteger(port) && port > 0) {
    return `http://localhost:${port}/`;
  }

  // dev:desktop still points the renderer straight at the backend, so fall
  // back to deriving the target from the explicit websocket URL.
  if (!wsUrl) {
    return undefined;
  }

  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

const devProxyTarget = resolveDevProxyTarget(process.env.T3CODE_PORT, configuredWsUrl);

// Vite's dev server sends JS uncompressed. On localhost that is free; over a
// shared origin (tailnet, LAN) it is the whole cold-start: bundled dev serves
// one ~25 MB chunk, and a typical uplink moves that in about a minute while
// both machines sit idle. Compressing turns it into a few seconds of CPU.
// Brotli quality 5 keeps encode time in the hundreds of ms; the default
// (quality 11) would trade the transfer stall for an equally long encode stall.
function devCompressionPlugin(): Plugin {
  return {
    name: "t3code:dev-compression",
    apply: "serve",
    configureServer(server) {
      // compression() is typed against Express's req/res, which extend the
      // node http objects Connect actually passes — safe to narrow.
      server.middlewares.use(
        compression({
          brotli: { params: { [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
        }) as unknown as Connect.NextHandleFunction,
      );
    },
  };
}

// Vite rejects requests whose Host header isn't localhost, which blocks sharing
// a dev server over Tailscale/LAN. Tailnet names are safe to allow wholesale:
// the DNS is controlled by tailscale, so they can't be rebound by an attacker.
// Anything else (ngrok, a LAN IP alias) goes through the env var.
const configuredAllowedHosts = (process.env.T3CODE_DEV_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const allowedHosts = [".ts.net", ...configuredAllowedHosts];

export default defineConfig(() => {
  return {
    assetsInclude: ["**/*.wasm"],
    plugins: [
      devCompressionPlugin(),
      VitePWA({
        registerType: "prompt",
        injectRegister: false,
        manifest: {
          name: "T3 Code",
          short_name: "T3 Code",
          description: "T3 Code — an agentic coding workspace.",
          start_url: "/",
          scope: "/",
          display: "standalone",
          background_color: "#161616",
          theme_color: "#161616",
          icons: [
            { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            {
              src: "/pwa-maskable-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          // Inject our Web Push handlers into the generated worker. This keeps the
          // whole generateSW config below (precache + the load-bearing CacheFirst
          // /assets rule) untouched, while adding `push` / `notificationclick`
          // listeners the auto-generated worker otherwise can't carry. The file is
          // a plain static asset under public/ (served at /push-sw.js).
          importScripts: ["/push-sw.js"],
          // Precache only the small, always-needed shell. The large hashed JS/CSS
          // chunks (incl. lazy Shiki language + wasm bundles, ~16 MB total) are
          // runtime-cached on first use instead of blocking SW install on 16 MB.
          globPatterns: ["index.html", "manifest.webmanifest", "**/*.{css,woff2,ico,png,svg}"],
          cleanupOutdatedCaches: true,
          navigateFallback: "index.html",
          // Deny server-owned top-level routes so the SPA shell never replaces a
          // server-rendered response. `/pair` and `/viewer` are CLIENT routes, so
          // they are intentionally absent (they need the shell). `/ws` is a
          // WebSocket upgrade the service worker never sees.
          // `raw=1` marks a viewer read that must reach the network: the rendered
          // -HTML `<iframe src>` is a navigation request too, so without it the
          // worker would answer the frame with the shell and render the app inside
          // the viewer. Matched against pathname + search by workbox.
          navigateFallbackDenylist: [
            /^\/api/,
            /^\/attachments/,
            /^\/\.well-known/,
            /[?&]raw=1(?:&|$)/,
          ],
          runtimeCaching: [
            {
              // Content-hashed build assets (JS/CSS) — deliberately NOT precached (the
              // full precache would be ~16 MB of lazy Shiki/wasm chunks). CacheFirst is
              // safe because the URL changes whenever content changes; bounded so old
              // builds' chunks are evicted. This is load-bearing, not redundant with the
              // shell precache, which contains no JS.
              urlPattern: ({ url }) => url.pathname.startsWith("/assets/"),
              handler: "CacheFirst",
              options: {
                cacheName: "t3code-assets",
                expiration: {
                  maxEntries: 300,
                  maxAgeSeconds: 30 * 24 * 60 * 60,
                  purgeOnQuotaError: true,
                },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        devOptions: { enabled: false },
      }),
      thirdPartyLicensesPlugin({
        bundleName: "web",
        configFile: new URL("../../third-party-licenses.config.json", import.meta.url),
        packageManifests: [
          { bundle: "web", path: new URL("./package.json", import.meta.url) },
          { bundle: "server", path: new URL("../server/package.json", import.meta.url) },
          { bundle: "desktop", path: new URL("../desktop/package.json", import.meta.url) },
        ],
      }),
      // Route components load as split chunks so settings, pull-request, and
      // usage code stay out of the cold-start payload; the router prefetches
      // them on navigation intent (see getRouter's defaultPreload).
      tanstackRouter({ autoCodeSplitting: true }),
      react(),
      babel({
        // We need to be explicit about the parser options after moving to @vitejs/plugin-react v6.0.0
        // This is because the babel plugin only automatically parses typescript and jsx based on relative paths (e.g. "**/*.ts")
        // whereas the previous version of the plugin parsed all files with a .ts extension.
        // This is causing our packages/ directory to fail to parse, as they are not relative to the CWD.
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [reactCompilerPreset()],
      }),
      tailwindPlugins(bundledDev),
      // Bundle analyzer — gated behind ANALYZE so it is zero-cost by default.
      // Run `ANALYZE=1 pnpm --filter @t3tools/web build` to emit dist/stats.html.
      ...(process.env.ANALYZE
        ? [
            visualizer({
              filename: "dist/stats.html",
              template: "treemap",
              gzipSize: true,
              brotliSize: false,
            }),
          ]
        : []),
    ],
    optimizeDeps: {
      include: [
        "@clerk/clerk-js",
        "@clerk/react/internal",
        "@pierre/diffs",
        "@pierre/diffs/editor",
        "@pierre/diffs/react",
        "@pierre/diffs/worker/worker.js",
        "effect/Array",
        "effect/Order",
        "react-dom/client",
      ],
    },
    define: {
      // In dev mode, tell the web app where the WebSocket server lives
      "import.meta.env.VITE_WS_URL": JSON.stringify(configuredWsUrl ?? ""),
      // Pinned explicitly rather than left to Vite's automatic VITE_ exposure:
      // under single-origin dev this must stay empty even when a `.env`
      // supplies it, so the client falls back to window.location.origin.
      "import.meta.env.VITE_HTTP_URL": JSON.stringify(configuredHttpUrl ?? ""),
      "import.meta.env.VITE_T3CODE_RELAY_URL": JSON.stringify(configuredRelayUrl),
      "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(configuredClerkPublishableKey),
      "import.meta.env.VITE_CLERK_JWT_TEMPLATE": JSON.stringify(configuredClerkJwtTemplate),
      "import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID": JSON.stringify(
        configuredClerkCliOAuthClientId,
      ),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_URL": JSON.stringify(configuredRelayTracingUrl),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET": JSON.stringify(
        configuredRelayTracingDataset,
      ),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN": JSON.stringify(configuredRelayTracingToken),
      "import.meta.env.VITE_HOSTED_APP_URL": JSON.stringify(configuredHostedAppUrl ?? ""),
      "import.meta.env.VITE_HOSTED_APP_CHANNEL": JSON.stringify(configuredHostedAppChannel),
      "import.meta.env.APP_VERSION": JSON.stringify(configuredAppVersion),
    },
    resolve: {
      tsconfigPaths: true,
      dedupe: ["react", "react-dom"],
    },
    experimental: {
      bundledDev,
    },
    server: {
      host,
      port,
      strictPort: true,
      allowedHosts,
      // Transform the whole module graph at server start instead of on the
      // first request. Without this, a cold worktree discovers and transforms
      // modules one import-level at a time while the browser waits — which
      // over a tailnet origin turns into minutes of waterfall.
      warmup: {
        clientFiles: ["./src/main.tsx"],
      },
      ...(devProxyTarget
        ? {
            // One entry per shared prefix; the server's dev catch-all 404s the
            // same list, so the two sides cannot drift. `/ws` is the app's own
            // socket and `/api` carries the device hub's stream sockets —
            // Vite's HMR socket is matched separately and exactly (path "/"
            // plus a vite-hmr subprotocol), so the upgrade handlers don't
            // collide.
            proxy: Object.fromEntries(
              DEV_PROXIED_PATH_PREFIXES.map((prefix) => [
                prefix,
                {
                  target: devProxyTarget,
                  changeOrigin: true,
                  ...(prefix === "/ws" || prefix === "/api" ? { ws: true } : {}),
                },
              ]),
            ),
          }
        : {}),
      // Electron's BrowserWindow needs the HMR socket pinned to an explicit
      // host to connect reliably; dev:desktop is the only mode that sets HOST.
      // Everywhere else, leaving this unset lets the client derive it from the
      // page origin, which is what makes HMR work over Tailscale/LAN instead of
      // failing an attempt against the wrong machine's localhost first.
      // (Vite 8 logs connection state via console.debug — enable "Verbose".)
      ...(explicitHost
        ? {
            hmr: {
              protocol: "ws",
              host: explicitHost,
              clientPort: port,
            },
          }
        : {}),
    },
    // @tailwindcss/vite only emits a CSS sourcemap when devSourcemap is on; without it
    // rolldown flags the transform as SOURCEMAP_BROKEN on every sourcemapped build.
    css: {
      devSourcemap: buildSourcemap !== false,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      manifest: true,
      sourcemap: buildSourcemap,
    },
    test: {
      projects: [defineProject(unitTestProject), defineProject(domTestProject)],
    },
  };
});
