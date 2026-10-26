// @effect-diagnostics-next-line nodeBuiltinImport:off -- Vite config runs before any Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeZlib from "node:zlib";

import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import compression from "compression";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import "vite-plus/test/config";
import { visualizer } from "rollup-plugin-visualizer";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig, type Connect, type Plugin } from "vite-plus";
import * as Hash from "effect/Hash";
import pkg from "./package.json" with { type: "json" };
import pdfjsPkg from "pdfjs-dist/package.json" with { type: "json" };

import {
  DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES,
  DEV_PROXIED_PATH_PREFIXES,
} from "@t3tools/shared/devProxy";

import { loadRepoEnv } from "../../scripts/lib/public-config";
import { thirdPartyLicensesPlugin } from "../../scripts/lib/third-party-licenses";
import { tailwindPlugins } from "./vite/tailwind";
import { warmBundledDevPlugin } from "./vite/warmBundledDev";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

// Signal single-origin dev explicitly; loadRepoEnv can restore deleted URL keys from .env.
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
const configuredReleaseChannel =
  process.env.T3CODE_BUILT_DEV === "1" ? "dev" : process.env.VITE_RELEASE_CHANNEL?.trim() || "";
const configuredAppVersion = process.env.APP_VERSION?.trim() || pkg.version;
const configuredDesktopUpdateRepository =
  process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY?.trim() ||
  process.env.GITHUB_REPOSITORY?.trim() ||
  "";
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

// `vp run dev --share --built` rebuilds on every change. The license manifest
// is about 2 s of each build, and nothing in that mode reads it.
const builtDev = process.env.T3CODE_BUILT_DEV === "1";

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
    setupFiles: [
      "../../packages/shared/src/testing/longTempDir.ts",
      "../../packages/shared/src/testing/providerEnv.ts",
    ],
  },
} satisfies TestProjectInlineConfiguration;

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    // `*.dom.test.tsx` belongs to the `dom` project above and `*.browser.test.{ts,tsx}` to the
    // `browser` project below; without these exclusions both projects claim the file and it also
    // runs under `node`, where it cannot pass.
    exclude: ["src/**/*.dom.test.tsx", "src/**/*.browser.test.{ts,tsx}"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Sized for `pnpm verify` running every package at once, where the few tests doing real work
    // (WASM highlighting, VSIX builds) slow down 13x or more: measured 2026-09-05, the slowest took
    // 7.3s alone and blew a 15s budget under load. The cost is only detection latency on a hang.
    hookTimeout: 120_000,
    testTimeout: 120_000,
    setupFiles: [
      "../../packages/shared/src/testing/longTempDir.ts",
      "../../packages/shared/src/testing/providerEnv.ts",
    ],
  },
} satisfies TestProjectInlineConfiguration;

// Hash checkout paths to ports 61000-64999; Vitest's fixed port collides under inherited strictPort.
const browserTestApiPort = 61_000 + ((Hash.string(import.meta.dirname) >>> 0) % 4_000);

const browserTestProject = {
  extends: true,
  // Pre-bundle lazy browser and worker dependencies to avoid mid-run reloads.
  optimizeDeps: {
    include: [
      "vite-plus/test/browser",
      "@base-ui/react/autocomplete",
      "saxes",
      "@betteroffice/docx/editor",
      "@betteroffice/docx/layout",
      "@betteroffice/docx/layout/render",
      "@betteroffice/docx/yrs",
      "@betteroffice/fonts",
      "@betteroffice/pptx",
      "@betteroffice/xlsx",
      "@betteroffice/xlsx/headless",
      "fast-xml-parser",
      "entities",
      "dompurify",
      "heic-to/next",
      "jszip",
      "pdfjs-dist",
      "sql.js",
      "tiff",
    ],
  },
  test: {
    name: "browser",
    include: ["src/**/*.browser.test.{ts,tsx}"],
    hookTimeout: 15_000,
    testTimeout: 15_000,
    setupFiles: ["./test/browserSetup.ts"],
    api: { port: browserTestApiPort, strictPort: false },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      screenshotFailures: false,
      commands: {
        // Playwright's mouse outlives each test, so whatever mounts under its last
        // position starts hovered. test/browserSetup.ts parks it off the page before each test.
        resetPointer: async ({ page }) => {
          await page.mouse.move(-1, -1);
        },
      },
    },
  },
} satisfies TestProjectInlineConfiguration;

// Render scenarios count React commits; they run only through scripts/render-metrics.ts,
// which reads the per-scenario reports this command writes.
const renderScenariosProject = {
  ...browserTestProject,
  test: {
    ...browserTestProject.test,
    name: "renders",
    include: ["test/*.renders.tsx"],
    // App scenarios mount the whole app per test, which outlasts 15s on a loaded machine.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    setupFiles: ["./test/renderCounter.ts", ...browserTestProject.test.setupFiles],
    browser: {
      ...browserTestProject.test.browser,
      // Vitest names each instance in place, so a shared array would clash with the browser project.
      instances: [{ browser: "chromium" }],
      commands: {
        ...browserTestProject.test.browser.commands,
        writeRenderReport: async (_context, scenario: string, json: string) => {
          const directory = process.env.T3CODE_RENDER_REPORT_DIR;
          if (!directory) throw new Error("T3CODE_RENDER_REPORT_DIR is not set");
          await NodeFSP.writeFile(`${directory}/${scenario}.json`, json);
        },
      },
    },
  },
} satisfies TestProjectInlineConfiguration;

function resolveDevProxyTarget(
  backendPort: string | undefined,
  wsUrl: string | undefined,
): string | undefined {
  const port = Number(backendPort?.trim());
  if (Number.isInteger(port) && port > 0) {
    return `http://localhost:${port}/`;
  }

  // dev:desktop connects directly to the backend; derive its target from the explicit WebSocket URL.
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

// Brotli quality 5 encodes in hundreds of ms; default quality 11 would replace transfer stalls with encode stalls.
function devCompressionPlugin(): Plugin {
  return {
    name: "t3code:dev-compression",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(
        compression({
          brotli: { params: { [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
        }) as unknown as Connect.NextHandleFunction,
      );
    },
  };
}

// A static import cycle between chunks can run a chunk before the values it imports exist,
// which blanks the app at boot. Fail the build instead of shipping it.
function chunkCycleGuardPlugin(): Plugin {
  return {
    name: "t3code:chunk-cycle-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      const done = new Set<string>();
      const visit = (fileName: string, path: string[]) => {
        if (done.has(fileName)) return;
        const start = path.indexOf(fileName);
        if (start !== -1) {
          this.error(`Chunk import cycle: ${[...path.slice(start), fileName].join(" -> ")}`);
        }
        const chunk = bundle[fileName];
        if (chunk?.type !== "chunk") return;
        for (const imported of chunk.imports) visit(imported, [...path, fileName]);
        done.add(fileName);
      };
      for (const fileName of Object.keys(bundle)) visit(fileName, []);
    },
  };
}

// Allow Tailnet hosts for sharing; Tailscale-controlled DNS prevents attacker rebinding.
const configuredAllowedHosts = (process.env.T3CODE_DEV_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const allowedHosts = [".ts.net", ...configuredAllowedHosts];

export default defineConfig(() => {
  return {
    run: {
      tasks: {
        // tsc (tsc-rs) rewrites the tsbuildinfo it reads, which keeps a task out of the cache.
        typecheck: {
          command: "tsc --noEmit",
          cache: { input: [{ auto: true }, "!*.tsbuildinfo"] },
        },
      },
    },
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
          // Web Push `push`/`notificationclick` listeners, from the static public/push-sw.js, added
          // to the generated worker without touching the generateSW config below.
          importScripts: ["/push-sw.js"],
          // Precache only the small, always-needed shell. The large hashed JS/CSS
          // chunks (incl. lazy Shiki language + wasm bundles, ~16 MB total) are
          // runtime-cached on first use instead of blocking SW install on 16 MB.
          globPatterns: ["index.html", "manifest.webmanifest", "**/*.{css,woff2,ico,png,svg}"],
          cleanupOutdatedCaches: true,
          navigateFallback: "index.html",
          // Server-owned routes never get the SPA shell (`/pair` and `/viewer` are client routes,
          // so they are absent). `raw=1` marks a viewer iframe read, itself a navigation, that
          // must reach the network instead of rendering the app inside the viewer.
          navigateFallbackDenylist: [
            /^\/api/,
            /^\/attachments/,
            /^\/\.well-known/,
            /[?&]raw=1(?:&|$)/,
          ],
          runtimeCaching: [
            {
              // Content-hashed JS/CSS, runtime-cached rather than precached (~16 MB of lazy chunks).
              // CacheFirst is safe because the URL changes with content; bounded so old builds
              // evict. Load-bearing: the shell precache holds no JS.
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
      chunkCycleGuardPlugin(),
      builtDev
        ? undefined
        : thirdPartyLicensesPlugin({
            bundleName: "web",
            configFile: new URL("../../third-party-licenses.config.json", import.meta.url),
            packageManifests: [
              { bundle: "web", path: new URL("./package.json", import.meta.url) },
              { bundle: "server", path: new URL("../server/package.json", import.meta.url) },
              { bundle: "desktop", path: new URL("../desktop/package.json", import.meta.url) },
            ],
          }),
      tanstackRouter({ autoCodeSplitting: true }),
      react({ compiler: true }),
      tailwindPlugins(bundledDev),
      warmBundledDevPlugin(),
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
        "@pierre/diffs/edit",
        "@pierre/diffs/react",
        "@pierre/diffs/worker/worker.js",
        "effect/Array",
        "effect/Order",
        "react-dom/client",
      ],
    },
    define: {
      "import.meta.env.VITE_WS_URL": JSON.stringify(configuredWsUrl ?? ""),
      // Override .env URLs with empty values in single-origin dev so clients use window.location.origin.
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
      "import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY": JSON.stringify(
        configuredDesktopUpdateRepository,
      ),
      "import.meta.env.VITE_RELEASE_CHANNEL": JSON.stringify(configuredReleaseChannel),
      "import.meta.env.APP_VERSION": JSON.stringify(configuredAppVersion),
    },
    resolve: {
      tsconfigPaths: true,
      alias: {
        "@betteroffice/fonts-cjk": new URL(
          "./src/components/files/office/fonts-cjk.ts",
          import.meta.url,
        ).pathname,
      },
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
      // Warm the module graph before first request to avoid serial import transforms over tailnet.
      // Bundled dev ignores this; warmBundledDevPlugin handles it there.
      warmup: {
        clientFiles: ["./src/main.tsx"],
      },
      ...(devProxyTarget
        ? {
            // Share prefixes with the backend catch-all so the proxy and 404 lists cannot drift.
            proxy: Object.fromEntries(
              DEV_PROXIED_PATH_PREFIXES.map((prefix) => [
                prefix,
                {
                  target: devProxyTarget,
                  changeOrigin: !DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES.has(prefix),
                  ...(prefix === "/ws" || prefix === "/api" ? { ws: true } : {}),
                },
              ]),
            ),
          }
        : {}),
      // Electron needs an explicit HMR host; elsewhere derive it from page origin for Tailscale/LAN.
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
    // Tailwind needs devSourcemap to avoid Rolldown SOURCEMAP_BROKEN on sourcemapped builds.
    css: {
      devSourcemap: buildSourcemap !== false,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      manifest: true,
      sourcemap: buildSourcemap,
      rolldownOptions: {
        output: {
          // PDF.js resolves decoder modules and ICC data relative to wasmUrl.
          assetFileNames: (asset) =>
            asset.originalFileNames.some((path) => /[/\\]pdfjs-dist[/\\]wasm[/\\]/.test(path))
              ? `assets/pdfjs-${pdfjsPkg.version}/[name][extname]`
              : "assets/[name]-[hash][extname]",
        },
      },
    },
    worker: { format: "es" },
    test: {
      projects: [
        defineProject(unitTestProject),
        defineProject(domTestProject),
        defineProject(browserTestProject),
        defineProject(renderScenariosProject),
      ],
    },
  };
});
