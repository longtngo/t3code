import Mime from "@effect/platform-node/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { cast } from "effect/Function";
import {
  Headers,
  HttpBody,
  HttpClient,
  HttpClientResponse,
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
import * as HttpResponseCompression from "./httpCompression/HttpResponseCompression.ts";
import { WorkspaceFileSystem } from "./workspace/WorkspaceFileSystem.ts";
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
const GZIP_MIN_BYTES = 1024;

function acceptsGzip(value: string | undefined): boolean {
  if (!value) return false;

  const accepted = new Map(
    value.split(",").map((entry) => {
      const [coding = "", ...parameters] = entry.trim().toLowerCase().split(";");
      const quality = parameters
        .map((parameter) => parameter.trim().match(/^q=(.+)$/)?.[1])
        .find((parameter) => parameter !== undefined);
      return [coding, quality === undefined ? 1 : Number(quality)] as const;
    }),
  );
  return (accepted.get("gzip") ?? accepted.get("*") ?? 0) > 0;
}

function varyByAcceptEncoding(value: string | undefined): string {
  if (!value) return "Accept-Encoding";
  const values = new Set(value.split(",").map((entry) => entry.trim().toLowerCase()));
  return values.has("*") || values.has("accept-encoding") ? value : `${value}, Accept-Encoding`;
}

const compressHttpResponse = Effect.fnUntraced(function* (
  response: HttpServerResponse.HttpServerResponse,
  acceptEncoding: string | undefined,
) {
  const body = response.body;
  if (
    body._tag !== "Uint8Array" ||
    body.contentLength < GZIP_MIN_BYTES ||
    !body.contentType.startsWith("application/json") ||
    response.headers["content-encoding"]
  ) {
    return response;
  }

  const variedResponse = HttpServerResponse.setHeader(
    response,
    "vary",
    varyByAcceptEncoding(response.headers.vary),
  );
  if (!acceptsGzip(acceptEncoding)) return variedResponse;

  const compression = yield* HttpResponseCompression.HttpResponseCompression;
  const headers = Headers.set(
    Headers.remove(variedResponse.headers, "content-length"),
    "content-encoding",
    "gzip",
  );
  return compression.gzip(body.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    cookies: response.cookies,
    contentType: body.contentType,
  });
});

export const httpCompressionLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(
      Effect.all([httpEffect, HttpServerRequest.HttpServerRequest]),
      ([response, request]) => compressHttpResponse(response, request.headers["accept-encoding"]),
    ),
  { global: true },
);

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
      headers: {
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

const VIEWER_ROUTE_PREFIX = "/viewer";
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
// Text/code files served raw (as text/plain) so the viewer's "Open in new tab"
// works for them too. Mirrors the client allow-list in
// apps/web/src/lib/codeFileTypes.ts (TEXT_FILE_EXTENSIONS) — keep the two in sync.
// Excludes .md/.html (handled above), binary/media, and .env / extension-less files.
const TEXT_VIEWER_EXTENSIONS = new Set([
  ".txt", ".log", ".csv", ".tsv", ".json", ".json5", ".jsonc", ".yaml", ".yml",
  ".toml", ".ini", ".conf", ".cfg", ".properties", ".xml", ".sql", ".py", ".rb",
  ".go", ".rs", ".java", ".kt", ".kts", ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp",
  ".hh", ".cs", ".php", ".swift", ".scala", ".sh", ".bash", ".zsh", ".fish", ".ps1",
  ".lua", ".pl", ".pm", ".r", ".dart", ".ex", ".exs", ".erl", ".hs", ".clj", ".cljs",
  ".cljc", ".edn", ".js", ".cjs", ".mjs", ".jsx", ".ts", ".cts", ".mts", ".tsx",
  ".vue", ".svelte", ".astro", ".css", ".scss", ".sass", ".less", ".graphql", ".gql",
  ".proto", ".gradle", ".groovy", ".tf", ".hcl", ".vim", ".diff", ".patch",
]);
// Treat a rendered document as a sandboxed top-level page: an opaque origin with
// no access to this app's cookies/storage, matching the no-same-origin iframe the
// in-app viewer uses.
const VIEWER_CSP = "sandbox allow-scripts allow-popups";

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

/** How a `/viewer` request should be served. */
export type ViewerPathKind = "markdown" | "html" | "text";

/**
 * Decode a `/viewer` URL suffix and classify it as a markdown, html, or raw-text
 * document at an absolute path, or null when the suffix is malformed, relative, or
 * an unsupported type. Pure posix string logic so it is unit-testable without the
 * filesystem (and keeps the decode try/catch out of the Effect handler).
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
  const lastSlash = absolutePath.lastIndexOf("/");
  const lastDot = absolutePath.lastIndexOf(".");
  const extension = lastDot > lastSlash ? absolutePath.slice(lastDot).toLowerCase() : "";
  if (MARKDOWN_EXTENSIONS.has(extension)) return { absolutePath, kind: "markdown" };
  if (HTML_EXTENSIONS.has(extension)) return { absolutePath, kind: "html" };
  if (TEXT_VIEWER_EXTENSIONS.has(extension)) return { absolutePath, kind: "text" };
  return null;
}

/**
 * Serve a file as a real, refreshable URL so the viewer's "Open in new tab"
 * reloads from disk instead of showing a frozen snapshot. Markdown is rendered to
 * HTML; `.html` is served as-is; everything else is served as text/plain.
 *
 * Reads go through `readTrustedFile`, which self-sandboxes to home / OS-temp /
 * trusted roots — that sandbox, not the auth waiver, is the real boundary.
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
    if (!isLocalLoopbackRequest(request)) {
      yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    }

    // The matched suffix is an absolute filesystem path (leading "/" preserved).
    const target = classifyViewerPath(url.value.pathname.slice(VIEWER_ROUTE_PREFIX.length));
    if (!target) {
      return HttpServerResponse.text("Invalid or unsupported file path", { status: 400 });
    }
    const { absolutePath, kind } = target;

    // `nosniff` makes the text/plain guarantee robust: a code file whose bytes
    // happen to look like HTML must never be content-sniffed and rendered as a
    // document (the sandbox CSP already neuters it, but don't rely on that alone).
    const headers = {
      "Cache-Control": "no-store",
      "Content-Security-Policy": VIEWER_CSP,
      "X-Content-Type-Options": "nosniff",
    };

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
        headers,
      });
    }

    // `.html` reports are served as-is as a sandboxed page (CSP above); every other
    // text/code file is served raw as text/plain so untrusted bytes are never
    // parsed as HTML.
    return HttpServerResponse.text(file.value.contents, {
      status: 200,
      contentType: kind === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
      headers,
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  ),
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
