import Mime from "@effect/platform-node/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import {
  WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
  WORKSPACE_TEXT_VIEWER_EXTENSIONS,
} from "@t3tools/shared/filePreview";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpMiddleware,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { OtlpTracer } from "effect/unstable/observability";

import * as ServerConfig from "./config.ts";
import { ASSET_ROUTE_PREFIX, resolveAsset } from "./assets/AssetAccess.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { WorkspaceFileSystem } from "./workspace/WorkspaceFileSystem.ts";
import {
  isWithinGrantedDirectory,
  mintViewerAssetToken,
  parseViewerAssetSuffix,
  resolveViewerAssetGrant,
} from "./workspace/viewerAssetTokens.ts";
import { MarkdownHtmlRenderer, MarkdownHtmlRendererLive } from "./workspace/markdownHtmlRenderer.ts";
import { traceRelayRequest } from "./cloud/traceRelayRequest.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";
import { WebPushRelay } from "./push/WebPushRelay.ts";
import { registerPushSubscription } from "./push/register.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const PUSH_SUBSCRIPTIONS_PATH = "/api/push/subscriptions";
const PUSH_VAPID_PUBLIC_KEY_PATH = "/api/push/vapid-public-key";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"];
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export function assetResponseHeaders(filePath: string): Record<string, string> {
  return {
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    ...(filePath.toLowerCase().endsWith(".svg")
      ? { "Content-Security-Policy": SVG_CONTENT_SECURITY_POLICY }
      : {}),
  };
}

export const httpCompressionLayer = HttpRouter.middleware(HttpMiddleware.compression(), {
  global: true,
});

export const browserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Dev uses credentialed requests from Vite or the Electron custom origin, so both must be
    // explicit. Packaged desktop omits credentials and uses Effect's default wildcard origin.
    //
    // T3CODE_DEV_ALLOWED_ORIGINS covers dev servers reached from a second
    // origin — a tailnet name, a LAN IP, a phone. Browser dev normally proxies
    // through Vite and is same-origin (no preflight at all), so this is a
    // safety net for the desktop renderer and any direct-to-backend caller.
    return HttpRouter.cors({
      ...(devOrigin
        ? {
            allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS, ...config.devAllowedOrigins],
            credentials: true,
          }
        : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }, traceRelayRequest),
    );
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Trace export failed.", { status: 502 }),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

// POST route the service worker calls on `pushsubscriptionchange` to re-register a
// rotated subscription in the background (no tab needed). Same operate scope + SSRF
// guard + upsert as the `pushSubscriptions.register` WS RPC (both go through the
// shared `registerPushSubscription`).
export const pushSubscriptionsRouteLayer = HttpRouter.add(
  "POST",
  PUSH_SUBSCRIPTIONS_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Defense-in-depth CSRF: require a JSON content-type so any cross-origin caller
    // is forced through a CORS preflight (which browserApiCorsLayer denies). The
    // service worker's same-origin fetch sets this header itself.
    const contentType = request.headers["content-type"];
    if (
      typeof contentType !== "string" ||
      !contentType.toLowerCase().includes("application/json")
    ) {
      return HttpServerResponse.text("Unsupported Media Type", { status: 415 });
    }
    const body = cast<
      unknown,
      {
        readonly endpoint?: unknown;
        readonly keys?: { readonly p256dh?: unknown; readonly auth?: unknown };
      } | null
    >(yield* request.json.pipe(Effect.orElseSucceed(() => null)));
    if (
      !body ||
      typeof body.endpoint !== "string" ||
      !body.keys ||
      typeof body.keys.p256dh !== "string" ||
      typeof body.keys.auth !== "string"
    ) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const outcome = yield* registerPushSubscription({
      endpoint: body.endpoint,
      keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    });
    switch (outcome) {
      case "registered":
        return HttpServerResponse.empty({ status: 204 });
      case "rejected":
        return HttpServerResponse.text("Forbidden push endpoint", { status: 403 });
      case "error":
        return HttpServerResponse.text("Registration failed", { status: 500 });
    }
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

// Unauthenticated: the VAPID *public* key is not a secret (it already ships to every
// client in ServerConfig). Exposed as a GET so the service worker can fetch it to
// re-subscribe on `pushsubscriptionchange` when neither the old nor the new browser
// subscription supplies an applicationServerKey.
export const pushVapidPublicKeyRouteLayer = HttpRouter.add(
  "GET",
  PUSH_VAPID_PUBLIC_KEY_PATH,
  Effect.gen(function* () {
    const relay = yield* WebPushRelay;
    return HttpServerResponse.text(relay.vapidPublicKey, { status: 200 });
  }),
);

export const assetRouteLayer = HttpRouter.add(
  "GET",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const asset = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* HttpServerResponse.file(asset.path, {
      status: 200,
      headers: assetResponseHeaders(asset.path),
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

const VIEWER_ROUTE_PREFIX = "/viewer";
/**
 * Where a sandboxed viewer document and its relative assets are served from. A
 * separate prefix from `/viewer` because the authorization model is different:
 * this one is token-only, with no auth waiver and no cookie.
 */
const VIEWER_ASSET_ROUTE_PREFIX = "/viewer-asset";
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
// Text/code files served raw (as text/plain) so the viewer's "Open in new tab"
// works for them too. Shared with the client's chip allow-list rather than
// mirrored, so the two surfaces cannot disagree about what is openable.
const TEXT_VIEWER_EXTENSIONS = new Set<string>(WORKSPACE_TEXT_VIEWER_EXTENSIONS);
// Treat a rendered document as a sandboxed top-level page: an opaque origin with
// no access to this app's cookies/storage, matching the no-same-origin iframe the
// in-app viewer uses.
const VIEWER_CSP = "sandbox allow-scripts allow-popups";
/**
 * Markdown is rendered from a file the user did not write by hand — a cloned repo's README,
 * an agent-written report — and the renderer passes raw HTML through on purpose. Serving
 * that with `allow-scripts` executes markup from those sources as a top-level document.
 * The in-app viewer already renders the same output under `sandbox=""` (scripts inert), so
 * withholding scripts here costs nothing that path has; `.html` keeps them, because opening
 * an interactive report is the reason that case exists.
 */
const VIEWER_MARKDOWN_CSP = "sandbox allow-popups";

/**
 * Whether a request genuinely originates from a local process — the basis for
 * waiving auth on the `/viewer` route. Trust is keyed on the real TCP peer
 * address (which a remote client cannot spoof), NEVER the client-controlled
 * `Host` header: an earlier version read `url.hostname` and was an auth bypass.
 * A forwarded request (reverse proxy, Tailscale Serve, …) is never trusted —
 * its loopback peer is the proxy, not the real client.
 */
export function isLocalLoopbackRequest(request: HttpServerRequest.HttpServerRequest): boolean {
  if (request.headers["x-forwarded-for"] || request.headers["forwarded"]) {
    return false;
  }
  const source = request.source as
    | {
        readonly remoteAddress?: string | null;
        readonly socket?: { readonly remoteAddress?: string | null };
      }
    | null
    | undefined;
  const rawPeer = source?.socket?.remoteAddress ?? source?.remoteAddress ?? null;
  if (!rawPeer) return false;
  const peer = rawPeer.startsWith("::ffff:") ? rawPeer.slice("::ffff:".length) : rawPeer;
  return isLoopbackHostname(peer);
}

/**
 * Whether an unauthenticated request may be waived on the strength of its loopback peer.
 *
 * The peer check alone is not enough once a *browser* is the local process. A page the user
 * visits runs attacker-controlled code with a loopback TCP peer, so "local process" stops
 * meaning "the user". Two browser-only escapes have to be closed:
 *
 * - **DNS rebinding.** `evil.example` re-resolved to 127.0.0.1 gives the attacker a
 *   same-origin loopback connection. The peer is genuinely loopback, so only the `Host`
 *   header distinguishes it — a rebound request still carries the attacker's hostname.
 *   (Reading `Host` is safe *here*, as a narrowing check on top of the peer test; it was an
 *   auth bypass only when it was the sole basis for trust.)
 * - **Cross-origin reads.** A top-level navigation is the case this waiver exists for
 *   ("Open in new tab" has no way to send a bearer token). A `fetch()` from another page is
 *   not, and is the shape that turns this route into arbitrary file disclosure. Browsers
 *   mark the difference: only a navigation carries `Sec-Fetch-Mode: navigate`. Non-browser
 *   callers (curl, an editor) send no `Sec-Fetch-*` at all and keep the waiver — they can
 *   already read the file directly with the user's own permissions, which is the whole
 *   premise of the waiver.
 */
export function isWaivableLocalRequest(request: HttpServerRequest.HttpServerRequest): boolean {
  if (!isLocalLoopbackRequest(request)) return false;
  const host = request.headers["host"];
  if (host !== undefined) {
    const hostname = host.startsWith("[")
      ? host.slice(1, host.indexOf("]"))
      : (host.split(":")[0] ?? "");
    if (!isLoopbackHostname(hostname)) return false;
  }
  const fetchMode = request.headers["sec-fetch-mode"];
  if (fetchMode !== undefined && fetchMode !== "navigate") return false;
  const fetchDest = request.headers["sec-fetch-dest"];
  if (fetchDest !== undefined && fetchDest !== "document") return false;
  // A cross-site top-level navigation (`evil.example` calling window.open on this
  // origin) is still a navigation, so the two checks above admit it. Harmless while
  // the opener cannot read the response, but it is free to deny here and it keeps
  // the waiver to what it claims to cover: the user's own local navigation.
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  return true;
}

/** How a `/viewer` request should be served. */
export type ViewerPathKind = "markdown" | "html" | "text" | "image";

/**
 * Images are served as bytes, so they never reach the text reader — its NUL-byte
 * guard is what made `.png` fail with "Failed to read '<path>'". Reuses the shared
 * list the workspace image preview and the asset route already agree on, rather
 * than starting a third copy that can drift.
 */
const IMAGE_VIEWER_EXTENSIONS = new Set<string>(WORKSPACE_IMAGE_PREVIEW_EXTENSIONS);
/**
 * Bound the byte path the way the text path is bounded by
 * `PROJECT_READ_FILE_MAX_BYTES`. `HttpServerResponse.file` streams (so this is not
 * a heap risk), but an unbounded stream over Tailscale is an unexplained stall.
 */
const VIEWER_MAX_IMAGE_BYTES = 64 * 1024 * 1024;
/**
 * `HttpServerResponse.file` silently DROPS its `contentType` option — the platform
 * derives the type from the path via `Mime` — so the type is pinned through
 * `headers` instead. Keyed off this map so the served type can only be one of the
 * extensions the allow-list admits.
 */
/**
 * Content types for a document's own relative assets.
 *
 * `.js` and `.css` MUST get their real types here: the main `/viewer` route serves
 * every text kind as `text/plain` with `nosniff` on purpose, and a browser refuses
 * to execute a script or apply a stylesheet served that way — which is the second
 * reason a multi-file prototype rendered blank. Giving these two their real types
 * is safe in a way `text/html` would not be: neither can be rendered as a document,
 * so the "untrusted bytes must never be parsed as HTML" rule still holds. Anything
 * not listed falls back to `text/plain`.
 */
const VIEWER_ASSET_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

/**
 * Decode a `/viewer` URL suffix and classify it as a markdown, html, raw-text, or
 * image document at an absolute path, or null when the suffix is malformed,
 * relative, or an unsupported type. Pure posix string logic so it is unit-testable
 * without the filesystem (and keeps the decode try/catch out of the Effect handler).
 */
export function classifyViewerPath(
  encodedSuffix: string,
): { readonly absolutePath: string; readonly kind: ViewerPathKind } | null {
  let absolutePath: string;
  try {
    absolutePath = decodeURIComponent(encodedSuffix);
  } catch {
    return null;
  }
  if (!absolutePath.startsWith("/")) return null;
  // Same guard the static route applies: a NUL byte makes Node's path APIs throw
  // rather than fail, and the text path only absorbed it by accident (its realpath
  // rejection became a 404). The byte path below has no such accident to rely on.
  if (absolutePath.includes("\0")) return null;
  const lastSlash = absolutePath.lastIndexOf("/");
  const lastDot = absolutePath.lastIndexOf(".");
  const extension = lastDot > lastSlash ? absolutePath.slice(lastDot).toLowerCase() : "";
  if (MARKDOWN_EXTENSIONS.has(extension)) return { absolutePath, kind: "markdown" };
  if (HTML_EXTENSIONS.has(extension)) return { absolutePath, kind: "html" };
  if (IMAGE_VIEWER_EXTENSIONS.has(extension)) return { absolutePath, kind: "image" };
  if (TEXT_VIEWER_EXTENSIONS.has(extension)) return { absolutePath, kind: "text" };
  return null;
}

/**
 * Serve a file as a real, refreshable URL so the viewer's "Open in new tab"
 * reloads from disk instead of showing a frozen snapshot. Markdown is rendered to
 * HTML; `.html` is served as-is; everything else is served as text/plain.
 *
 * `readTrustedFile` applies no path sandbox, so the `orchestration:read` scope below is
 * the boundary for anything that is not a genuine local navigation.
 *
 * The waiver is deliberately narrower than "the peer is loopback" — see
 * `isWaivableLocalRequest`. The premise that makes it safe ("a local process already reads
 * the user's files with the user's own permissions") holds for curl or an editor, but NOT
 * for a browser: a page the user visits is attacker-controlled code running behind a
 * loopback peer. Waiving on the peer alone let any website read any file on disk via a
 * cross-origin `fetch`, because this server answers with `access-control-allow-origin: *`.
 */
export const viewerRouteLayer = HttpRouter.add(
  "GET",
  `${VIEWER_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    // The matched suffix is an absolute filesystem path (leading "/" preserved).
    // Classified BEFORE the waiver, because the waiver does not extend to images.
    const target = classifyViewerPath(url.value.pathname.slice(VIEWER_ROUTE_PREFIX.length));
    if (!target) {
      return HttpServerResponse.text("Invalid or unsupported file path", { status: 400 });
    }
    const { absolutePath, kind } = target;

    // Images are never waived, unlike the text kinds. An unauthenticated response a
    // browser can DECODE is an oracle the text kinds do not offer: `onload` vs
    // `onerror` reveals whether an arbitrary absolute path exists, and
    // naturalWidth/naturalHeight leak its dimensions. Two ways an <img> reaches here
    // without the waiver's intended user: a browser that sends no `Sec-Fetch-*`
    // (the checks above are `!== undefined` guarded, so absence keeps the waiver),
    // and any other 127.0.0.1 port, which is the SAME SITE for a `SameSite=Lax`
    // cookie. Requiring the scope closes both without touching the text paths.
    if (kind === "image" || !isWaivableLocalRequest(request)) {
      yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    }

    // `nosniff` makes the text/plain guarantee robust: a code file whose bytes
    // happen to look like HTML must never be content-sniffed and rendered as a
    // document (the sandbox CSP already neuters it, but don't rely on that alone).
    const headers = {
      "Cache-Control": "no-store",
      "Content-Security-Policy": VIEWER_CSP,
      "X-Content-Type-Options": "nosniff",
    };

    // Images bypass the text reader entirely and stream from disk, so the NUL-byte
    // guard that rejects them as "binary" is never consulted. `HttpServerResponse.file`
    // does NOT re-apply the reader's guards, so the two that matter are re-added here:
    // a regular-file check (a DIRECTORY named `foo.png` otherwise stats fine, emits a
    // 200 with a bogus content-length, then errors EISDIR after the headers are
    // already flushed) and a size bound.
    if (kind === "image") {
      const fileSystem = yield* FileSystem.FileSystem;
      const info = yield* fileSystem.stat(absolutePath).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      if (Number(info.value.size) > VIEWER_MAX_IMAGE_BYTES) {
        return HttpServerResponse.text("Image too large to preview", { status: 413 });
      }
      const extension = absolutePath.slice(absolutePath.lastIndexOf(".")).toLowerCase();
      return yield* HttpServerResponse.file(absolutePath, {
        status: 200,
        headers: {
          ...headers,
          // `assetResponseHeaders` supplies the strict `default-src 'none'; …; sandbox`
          // policy for SVG, which the asset route already serves images under. It
          // matters only for a top-level navigation to an .svg (same-origin with the
          // app, so unsandboxed it would be XSS against the app); an <img> embed never
          // runs script regardless.
          ...assetResponseHeaders(absolutePath),
          "Cache-Control": "no-store",
          ...(IMAGE_CONTENT_TYPES[extension]
            ? { "Content-Type": IMAGE_CONTENT_TYPES[extension] }
            : {}),
        },
      }).pipe(
        // The route's only other error funnel is `catchTags` for the two auth errors,
        // so a PlatformError from a file that vanished between stat and open would
        // otherwise escape as an unhandled failure.
        Effect.orElseSucceed(() => HttpServerResponse.text("Not Found", { status: 404 })),
      );
    }

    const workspaceFileSystem = yield* WorkspaceFileSystem;
    const file = yield* workspaceFileSystem
      .readTrustedFile({ path: absolutePath })
      .pipe(Effect.option);
    if (Option.isNone(file)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    if (kind === "markdown") {
      // The renderer layer is provided right here rather than required from the
      // ambient context, so this route adds no service requirement to the app
      // layer (the same containment D3 applied on the ws side).
      const html = yield* MarkdownHtmlRenderer.pipe(
        Effect.flatMap((renderer) => renderer.render(file.value.contents)),
        Effect.provide(MarkdownHtmlRendererLive),
      );
      return HttpServerResponse.text(html, {
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: { ...headers, "Content-Security-Policy": VIEWER_MARKDOWN_CSP },
      });
    }

    if (kind === "html") {
      // Redirect the document to a token-scoped URL so its RELATIVE assets work.
      // The sandbox CSP below gives it an opaque origin, whose subresource requests
      // carry no session cookie — see viewerAssetTokens for the full mechanism.
      // Minting here rather than in the client keeps the whole fix server-side: the
      // document's own navigation is still cookie-authenticated (it inherits the
      // top-level site), so by the time we get here the caller is already allowed
      // to read this file.
      // Realpath-resolved, because the asset route's containment check compares
      // against a realpath too — comparing unresolved paths would let a symlink
      // inside the directory point anywhere on disk.
      const documentFileSystem = yield* FileSystem.FileSystem;
      const documentPath = yield* Path.Path;
      const parentDirectory = documentPath.dirname(absolutePath);
      const directory = yield* documentFileSystem
        .realPath(parentDirectory)
        .pipe(Effect.orElseSucceed(() => parentDirectory));
      const token = mintViewerAssetToken(directory, yield* Clock.currentTimeMillis);
      const encoded = absolutePath.split("/").map(encodeURIComponent).join("/");
      return HttpServerResponse.empty({
        status: 302,
        headers: {
          // `raw=1` is preserved so the PWA's navigateFallbackDenylist still keeps
          // the service worker from answering this frame with the app shell.
          Location: `${VIEWER_ASSET_ROUTE_PREFIX}/${token}${encoded}?raw=1`,
          "Cache-Control": "no-store",
        },
      });
    }

    // Every other text/code file is served raw as text/plain so untrusted bytes are
    // never parsed as HTML.
    return HttpServerResponse.text(file.value.contents, {
      status: 200,
      contentType: "text/plain; charset=utf-8",
      headers,
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  ),
);

/**
 * Serve a sandboxed viewer document and the assets it references, authorized by a
 * path-embedded capability token rather than the session cookie the document's
 * opaque origin cannot send.
 *
 * The token is the ONLY credential here — there is deliberately no auth waiver and
 * no cookie check, because neither can work from an opaque origin. What bounds it:
 * a token authorizes one realpath-resolved directory subtree, expires in minutes,
 * and is minted only for a caller who was already allowed to read the document.
 * Files are served with `nosniff` and, apart from the document itself, never as
 * `text/html`, so nothing under the token can be turned into a second document.
 */
export const viewerAssetRouteLayer = HttpRouter.add(
  "GET",
  `${VIEWER_ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const parsed = parseViewerAssetSuffix(
      url.value.pathname.slice(VIEWER_ASSET_ROUTE_PREFIX.length),
    );
    if (!parsed) {
      return HttpServerResponse.text("Invalid asset path", { status: 400 });
    }
    const directory = resolveViewerAssetGrant(parsed.token, yield* Clock.currentTimeMillis);
    if (directory === null) {
      // Expired or unknown. 404 rather than 401: there is no credential the caller
      // could add, and the document simply needs reloading to mint a fresh token.
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    // Realpath BEFORE the containment check, so a symlink planted inside the
    // granted directory cannot be used to read outside it.
    const resolvedPath = yield* fileSystem.realPath(parsed.absolutePath).pipe(Effect.option);
    if (Option.isNone(resolvedPath) || !isWithinGrantedDirectory(directory, resolvedPath.value)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const info = yield* fileSystem.stat(resolvedPath.value).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    if (Number(info.value.size) > VIEWER_MAX_IMAGE_BYTES) {
      return HttpServerResponse.text("Asset too large", { status: 413 });
    }

    const extension = resolvedPath.value.slice(resolvedPath.value.lastIndexOf(".")).toLowerCase();
    const isDocument = HTML_EXTENSIONS.has(extension);
    const contentType =
      IMAGE_CONTENT_TYPES[extension] ??
      VIEWER_ASSET_CONTENT_TYPES[extension] ??
      (isDocument ? "text/html; charset=utf-8" : "text/plain; charset=utf-8");

    return yield* HttpServerResponse.file(resolvedPath.value, {
      status: 200,
      headers: {
        // The document keeps the sandbox that made this route necessary. Assets get
        // the strict asset policy for SVG and nothing else needs one. Spread first
        // so the explicit headers below win — `assetResponseHeaders` carries its own
        // Cache-Control, and a token-scoped read must not be cached past the grant.
        ...(isDocument
          ? { "Content-Security-Policy": VIEWER_CSP }
          : assetResponseHeaders(resolvedPath.value)),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Type": contentType,
      },
    }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("Not Found", { status: 404 })));
  }),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isDevProxiedPath(url.value.pathname)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
