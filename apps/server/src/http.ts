import Mime from "@effect/platform-node/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
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
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { OtlpTracer } from "effect/unstable/observability";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { resolveAttachmentPathById } from "./attachmentStore.ts";
import { resolveStaticDir, ServerConfig } from "./config.ts";
import { BrowserTraceCollector } from "./observability/Services/BrowserTraceCollector.ts";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";
const FALLBACK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;
const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export const browserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const devOrigin = config.devUrl?.origin;
    return HttpRouter.cors({
      ...(devOrigin ? { allowedOrigins: [devOrigin], credentials: true } : {}),
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
      Effect.catchTags({
        ServerAuthInvalidCredentialError: (error) => failEnvironmentAuthInvalid(error.reason),
        ServerAuthInternalError: (error) => failEnvironmentInternal("internal_error", error),
      }),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }),
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
    const config = yield* ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector;
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

export const attachmentsRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rawRelativePath = url.value.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return HttpServerResponse.text("Invalid attachment path", { status: 400 });
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    const filePath = isIdLookup
      ? resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: normalizedRelativePath,
        })
      : resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: normalizedRelativePath,
        });
    if (!filePath) {
      return HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
        status: isIdLookup ? 404 : 400,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const projectFaviconRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-favicon",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const projectCwd = url.value.searchParams.get("cwd");
    if (!projectCwd) {
      return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    }

    const faviconResolver = yield* ProjectFaviconResolver;
    const faviconFilePath = yield* faviconResolver.resolvePath(projectCwd);
    if (!faviconFilePath) {
      return HttpServerResponse.text(FALLBACK_PROJECT_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
        },
      });
    }

    return yield* HttpServerResponse.file(faviconFilePath, {
      status: 200,
      headers: {
        "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
      },
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
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
// no access to this app's cookies/storage, matching the no-same-origin iframe
// the in-app viewer uses. Mirrors the prior pop-out iframe sandbox flags.
const VIEWER_CSP = "sandbox allow-scripts allow-popups";

/**
 * Whether a request genuinely originates from a local process — the basis for
 * waiving auth on the `/viewer` route. Trust is keyed on the real TCP peer
 * address (which a remote client cannot spoof), NEVER the client-controlled
 * `Host` header. A forwarded request (reverse proxy, Tailscale Serve, …) is
 * never trusted: its loopback peer is the proxy, not the real client.
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
 * Serve a workspace file as a full HTML page so the in-app viewer's
 * "Open in new tab" gets a real, refreshable URL. Markdown is rendered to HTML;
 * `.html` is served as-is. Reads go through the same sandbox as the file-preview
 * RPCs (home + temp + trusted project roots). Loopback requests (the desktop
 * app's external browser, local web) are trusted — the read sandbox is the real
 * boundary; non-loopback requests must carry a session like every raw route.
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
    const path = yield* Path.Path;

    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const allowedRoots = yield* projectionSnapshotQuery.getCommandReadModel().pipe(
      Effect.map((readModel) => readModel.projects.map((project) => project.workspaceRoot)),
      Effect.orElseSucceed(() => [] as string[]),
    );

    const workspaceFileSystem = yield* WorkspaceFileSystem;
    const readInput = { cwd: path.dirname(absolutePath), path: absolutePath };
    // `nosniff` makes the text/plain guarantee robust: a code file whose bytes
    // happen to look like HTML must never be content-sniffed and rendered as a
    // document (the sandbox CSP already neuters it, but don't rely on that alone).
    const headers = {
      "Cache-Control": "no-store",
      "Content-Security-Policy": VIEWER_CSP,
      "X-Content-Type-Options": "nosniff",
    };

    if (kind === "markdown") {
      const rendered = yield* workspaceFileSystem
        .readFileAsHtml(readInput, allowedRoots)
        .pipe(Effect.option);
      if (Option.isNone(rendered)) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.text(rendered.value.html, {
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers,
      });
    }

    const file = yield* workspaceFileSystem.readFile(readInput, allowedRoots).pipe(Effect.option);
    if (Option.isNone(file)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    // `.html` reports are served as-is as a sandboxed page (CSP above); every other
    // text/code file is served raw as text/plain so untrusted bytes are never parsed
    // as HTML.
    return HttpServerResponse.text(file.value.contents, {
      status: 200,
      contentType: kind === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
      headers,
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
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

    const config = yield* ServerConfig;
    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir = config.staticDir ?? (config.devUrl ? yield* resolveStaticDir() : undefined);
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

    // Service-worker scripts (the workbox worker + our imported push handler) must
    // not be HTTP-cached, or a rebuilt worker/handler can lag up to ~24h behind the
    // deployed build. Everything else keeps the default (content-hashed /assets are
    // themselves immutable-by-URL).
    const baseName = path.basename(filePath);
    const isServiceWorkerScript =
      baseName === "sw.js" || baseName === "push-sw.js" || baseName.startsWith("workbox-");

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
      ...(isServiceWorkerScript ? { headers: { "Cache-Control": "no-cache" } } : {}),
    });
  }),
);
