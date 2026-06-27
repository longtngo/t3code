import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import "vite-plus/test/config";
import { visualizer } from "rollup-plugin-visualizer";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite-plus";
import pkg from "./package.json" with { type: "json" };

import { loadRepoEnv } from "../../scripts/lib/public-config";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

const port = Number(process.env.PORT ?? 5733);
const host = process.env.HOST?.trim() || "localhost";
const configuredWsUrl = process.env.VITE_WS_URL?.trim();
const configuredRelayUrl = repoEnv.VITE_T3CODE_RELAY_URL?.trim() || "";
const configuredClerkPublishableKey = repoEnv.VITE_CLERK_PUBLISHABLE_KEY?.trim() || "";
const configuredClerkJwtTemplate = repoEnv.VITE_CLERK_JWT_TEMPLATE?.trim() || "";
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

const buildSourcemap: boolean | "hidden" =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    include: ["src/**/*.test.{ts,tsx}"],
    // The web runtime suite exercises auth bootstrap, saved environments,
    // and websocket subscription lifecycles. Under the full monorepo test
    // run, those async tests can exceed Vitest's default 5s budget.
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
} satisfies TestProjectInlineConfiguration;

const browserTestProject = {
  extends: true,
  server: {
    // Browser tests need concurrent runs to claim the next available port.
    strictPort: false,
  },
  test: {
    name: "browser",
    include: ["src/components/**/*.browser.tsx"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    browser: {
      enabled: true,
      provider: playwright() as never,
      instances: [{ browser: "chromium" }],
      headless: true,
      api: {
        strictPort: false,
      },
    },
    fileParallelism: false,
  },
} satisfies TestProjectInlineConfiguration;

function resolveDevProxyTarget(wsUrl: string | undefined): string | undefined {
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

const devProxyTarget = resolveDevProxyTarget(configuredWsUrl);

export default defineConfig(() => {
  return {
    plugins: [
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
          // Precache only the small, always-needed shell. The large hashed JS/CSS
          // chunks (incl. lazy Shiki language + wasm bundles, ~16 MB total) are
          // runtime-cached on first use instead of blocking SW install on 16 MB.
          globPatterns: ["index.html", "manifest.webmanifest", "**/*.{css,woff2,ico,png,svg}"],
          cleanupOutdatedCaches: true,
          navigateFallback: "index.html",
          // Deny server-owned top-level routes so the SPA shell never replaces a
          // server-rendered response. `/viewer` is opened as a real navigation
          // (window.open) and must reach the server. `/pair` is a CLIENT route, so it
          // is intentionally absent (it needs the shell). `/ws` is a WebSocket upgrade
          // the service worker never sees.
          navigateFallbackDenylist: [/^\/api/, /^\/attachments/, /^\/\.well-known/, /^\/viewer/],
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
                expiration: { maxEntries: 300, maxAgeSeconds: 30 * 24 * 60 * 60, purgeOnQuotaError: true },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        devOptions: { enabled: false },
      }),
      tanstackRouter(),
      react(),
      babel({
        // We need to be explicit about the parser options after moving to @vitejs/plugin-react v6.0.0
        // This is because the babel plugin only automatically parses typescript and jsx based on relative paths (e.g. "**/*.ts")
        // whereas the previous version of the plugin parsed all files with a .ts extension.
        // This is causing our packages/ directory to fail to parse, as they are not relative to the CWD.
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [reactCompilerPreset()],
      }),
      tailwindcss(),
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
        "@pierre/diffs",
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
      "import.meta.env.VITE_T3CODE_RELAY_URL": JSON.stringify(configuredRelayUrl),
      "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(configuredClerkPublishableKey),
      "import.meta.env.VITE_CLERK_JWT_TEMPLATE": JSON.stringify(configuredClerkJwtTemplate),
      "import.meta.env.VITE_HOSTED_APP_URL": JSON.stringify(configuredHostedAppUrl ?? ""),
      "import.meta.env.VITE_HOSTED_APP_CHANNEL": JSON.stringify(configuredHostedAppChannel),
      "import.meta.env.APP_VERSION": JSON.stringify(configuredAppVersion),
    },
    resolve: {
      tsconfigPaths: true,
    },
    server: {
      host,
      port,
      strictPort: true,
      ...(devProxyTarget
        ? {
            proxy: {
              "/.well-known": {
                target: devProxyTarget,
                changeOrigin: true,
              },
              "/api": {
                target: devProxyTarget,
                changeOrigin: true,
              },
              "/attachments": {
                target: devProxyTarget,
                changeOrigin: true,
              },
            },
          }
        : {}),
      hmr: {
        // Explicit config so Vite's HMR WebSocket connects reliably
        // inside Electron's BrowserWindow. Vite 8 uses console.debug for
        // connection logs — enable "Verbose" in DevTools to see them.
        protocol: "ws",
        host,
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: buildSourcemap,
    },
    test: {
      projects: [defineProject(unitTestProject), defineProject(browserTestProject)],
    },
  };
});
