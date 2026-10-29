import * as NodeOS from "node:os";

import * as Mime from "effect/http/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import {
  AUDIO_CONTENT_TYPE_BY_EXTENSION,
  isWorkspaceImagePreviewPath,
  isWorkspaceMediaPreviewPath,
  VIDEO_CONTENT_TYPE_BY_EXTENSION,
  WORKSPACE_AUDIO_PREVIEW_EXTENSIONS,
  WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
  WORKSPACE_TEXT_VIEWER_EXTENSIONS,
  WORKSPACE_VIDEO_PREVIEW_EXTENSIONS,
} from "@t3tools/shared/filePreview";
import { injectMcpAppCookieBootstrap, injectMcpAppThemeBootstrap } from "@t3tools/shared/mcpApp";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import { summarizeOtlpTraceData } from "./observability/otlpTraceSummary.ts";
import * as Clock from "effect/Clock";
import * as ByteSize from "effect/ByteSize";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { cast, pipe } from "effect/Function";
import {
  HttpClient,
  HttpClientResponse,
  HttpMiddleware,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { OtlpTracer, OtlpSerialization } from "effect/observability";

import * as ServerConfig from "./config.ts";
import {
  ASSET_ROUTE_PREFIX,
  readMcpAppHtml,
  resolveAsset,
  type ResolvedAsset,
} from "./assets/AssetAccess.ts";
import { sourceControlMediaResponse } from "./assets/sourceControlMediaResponse.ts";
import { statMediaFile, streamMediaFile, type OpenMediaFile } from "./assets/MediaFile.ts";
import {
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  storeAttachmentUpload,
  validateAttachmentUploadToken,
} from "./assets/AttachmentUpload.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { WorkspaceFileSystem } from "./workspace/WorkspaceFileSystem.ts";
import {
  isWithinGrantedDirectory,
  mintViewerAssetToken,
  parseViewerAssetSuffix,
  resolveViewerAssetGrant,
} from "./workspace/viewerAssetTokens.ts";
import {
  MarkdownHtmlRenderer,
  MarkdownHtmlRendererLive,
} from "./workspace/markdownHtmlRenderer.ts";
import { traceRelayRequest } from "./cloud/traceRelayRequest.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { WEBHOOK_ROUTE_PREFIX } from "./scheduledTasks/ScheduledTaskService.ts";
import {
  browserApiCorsAllowedHeaders,
  browserApiCorsAllowedMethods,
  DESKTOP_RENDERER_ORIGINS,
} from "./httpCors.ts";
import { resolveViewerRange } from "./viewerRange.ts";
import { WebPushRelay } from "./push/WebPushRelay.ts";
import { registerPushSubscription } from "./push/register.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const PUSH_SUBSCRIPTIONS_PATH = "/api/push/subscriptions";
const PUSH_VAPID_PUBLIC_KEY_PATH = "/api/push/vapid-public-key";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
// Opaque origin blocks cookies, storage and API access while allowing scripts.
// Agent HTML can open without a click, so disallow blocking modals.
const HTML_CONTENT_SECURITY_POLICY =
  "sandbox allow-scripts allow-forms allow-popups allow-downloads";

// Proxies may strip disposition; force document-capable downloads to octet-stream.
const DOWNLOAD_MIME_TYPE_PATTERN = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;
const isSafeDownloadMimeType = (mimeType: string): boolean =>
  DOWNLOAD_MIME_TYPE_PATTERN.test(mimeType) &&
  !/(?:^text\/html$|\/xml(?:$|-)|\+xml$)/i.test(mimeType.trim().toLowerCase());
const isSafeInlineMediaMimeType = (mimeType: string): boolean =>
  DOWNLOAD_MIME_TYPE_PATTERN.test(mimeType) && /^(?:audio|video)\//i.test(mimeType);
const isSafeInlineDocumentMimeType = (mimeType: string): boolean =>
  mimeType.toLowerCase() === "application/pdf" || mimeType.toLowerCase() === "text/html";

export function downloadContentDisposition(fileName?: string): string {
  if (fileName === undefined) {
    return "attachment";
  }
  // toWellFormed: encodeURIComponent throws URIError on unpaired surrogates.
  const sanitized = fileName.toWellFormed().replace(/[\p{Cc}"\\]/gu, "_");
  const asciiFallback = sanitized.replace(/[^\u0020-\u007e]/g, "_");
  const needsExtended = asciiFallback !== sanitized;
  const extendedName = encodeURIComponent(sanitized).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"${
    needsExtended ? `; filename*=UTF-8''${extendedName}` : ""
  }`;
}

export function assetResponseHeaders(
  filePath: string,
  options?: {
    readonly download?: boolean;
    readonly fileName?: string;
    readonly mimeType?: string;
  },
): Record<string, string> {
  const lowerPath = filePath.toLowerCase();
  const inlineMimeType = options?.mimeType?.split(";", 1)[0]?.trim();
  return {
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    ...(options?.download
      ? {
          "Content-Disposition": downloadContentDisposition(options.fileName),
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Type":
            options.mimeType !== undefined && isSafeDownloadMimeType(options.mimeType)
              ? options.mimeType
              : "application/octet-stream",
        }
      : inlineMimeType !== undefined && isSafeInlineMediaMimeType(inlineMimeType)
        ? { "Content-Type": inlineMimeType }
        : inlineMimeType !== undefined && isSafeInlineDocumentMimeType(inlineMimeType)
          ? {
              "Content-Type":
                inlineMimeType.toLowerCase() === "text/html"
                  ? "text/html; charset=utf-8"
                  : "application/pdf",
              ...(inlineMimeType.toLowerCase() === "text/html"
                ? { "Content-Security-Policy": HTML_CONTENT_SECURITY_POLICY }
                : {}),
            }
          : lowerPath.endsWith(".html") || lowerPath.endsWith(".htm")
            ? {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Security-Policy": HTML_CONTENT_SECURITY_POLICY,
              }
            : {}),
    ...(!options?.download && lowerPath.endsWith(".svg")
      ? { "Content-Security-Policy": SVG_CONTENT_SECURITY_POLICY }
      : {}),
  };
}

function assetByteRange(header: string, size: bigint) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? BigInt(match[1]) : null;
  const last = match[2] ? BigInt(match[2]) : null;
  if (first !== null && last !== null && last < first) return null;
  if (size === 0n || (first !== null && first >= size) || (first === null && last === 0n)) {
    return { _tag: "Unsatisfiable" as const };
  }
  const start = first ?? (last! >= size ? 0n : size - last!);
  const end = first === null || last === null || last >= size ? size - 1n : last;
  if (!Number.isSafeInteger(Number(start)) || !Number.isSafeInteger(Number(end))) {
    return { _tag: "Unsatisfiable" as const };
  }
  return {
    _tag: "Range" as const,
    offset: start,
    bytesToRead: end - start + 1n,
    contentRange: `bytes ${start}-${end}/${size}`,
  };
}

export const assetFileResponse = Effect.fn("assetFileResponse")(function* (
  asset: {
    readonly path: string;
    readonly download?: boolean;
    readonly fileName?: string;
    readonly mimeType?: string;
    readonly file?: OpenMediaFile;
    readonly renderIntent?: "mcp-app";
  },
  rangeHeader?: string,
  ifRangeHeader?: string,
  method: "GET" | "HEAD" = "GET",
) {
  const headers = assetResponseHeaders(asset.path, asset);
  if (
    asset.renderIntent === "mcp-app" &&
    !asset.download &&
    headers["Content-Type"] === "text/html; charset=utf-8"
  ) {
    const bytes = yield* readMcpAppHtml(asset.path);
    if (bytes === null) {
      return HttpServerResponse.text("MCP app is too large to preview.", { status: 413 });
    }
    const body = pipe(
      new TextDecoder().decode(bytes),
      injectMcpAppThemeBootstrap,
      injectMcpAppCookieBootstrap,
      (html) => new TextEncoder().encode(html),
    );
    headers["Content-Length"] = String(body.byteLength);
    return method === "HEAD"
      ? HttpServerResponse.empty({ status: 200, headers })
      : HttpServerResponse.uint8Array(body, { headers });
  }
  const mediaFile = asset.file;
  const mediaInfo = mediaFile ? yield* statMediaFile(asset.path, mediaFile) : undefined;
  const isMedia = /^(?:audio|video)\//i.test(headers["Content-Type"] ?? "");
  if (isMedia) {
    // Without file identity, validators cannot guarantee byte equality; attachments must also expire with their URL.
    headers["Cache-Control"] = "private, no-store";
  }
  let status = 200;
  let offset = 0n;
  let bytesToRead: bigint | undefined;
  {
    headers["Accept-Ranges"] = "bytes";
    // If-Range requires a matching validator. A full response is safe when we cannot validate it.
    if (method === "GET" && rangeHeader && ifRangeHeader === undefined) {
      const fs = yield* FileSystem.FileSystem;
      const info = mediaInfo ?? (yield* fs.stat(asset.path));
      const range = assetByteRange(rangeHeader, info.size);
      if (range?._tag === "Unsatisfiable") {
        return HttpServerResponse.empty({
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${info.size}` },
        });
      }
      if (range?._tag === "Range") {
        status = 206;
        offset = range.offset;
        bytesToRead = range.bytesToRead;
        headers["Content-Range"] = range.contentRange;
      }
    }
  }
  if (mediaFile && mediaInfo) {
    const size = bytesToRead ?? mediaInfo.size;
    headers["Content-Type"] ??= Option.getOrElse(
      Mime.getType(asset.path),
      () => "application/octet-stream",
    );
    headers["Content-Length"] = String(size);
    if (!isMedia) {
      headers["Last-Modified"] = mediaInfo.mtime.toUTCString();
      headers.ETag = `W/"${mediaInfo.size.toString(16)}-${mediaInfo.mtimeMs.toString(16)}"`;
    }
    if (method === "HEAD" || size === 0n) {
      return HttpServerResponse.empty({ status, headers });
    }
    const body = streamMediaFile(mediaFile, offset, size);
    if (!body) {
      return HttpServerResponse.text("File is too large to preview.", { status: 413 });
    }
    return HttpServerResponse.stream(body, {
      status,
      headers,
    });
  }
  return yield* HttpServerResponse.file(asset.path, { status, offset, bytesToRead, headers });
});

export const layerHttpCompression = HttpRouter.middleware(HttpMiddleware.compression(), {
  global: true,
});

export const layerBrowserApiCors = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Credentialed dev requests need explicit Vite/Electron origins; packaged desktop uses the default wildcard.
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

function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (
    scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

export const layerServerEnvironmentHttpApi = HttpApiBuilder.group(
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
}> {}

// Tracing once-per-second renderer exports would create more spans than it forwards.
export const layerOtlpTracesProxyRoute = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const otlpHeaders = config.otlpTracesExport.headers;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const serialization = yield* OtlpSerialization.OtlpSerialization;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          ...summarizeOtlpTraceData(bodyJson),
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: serialization.traces(bodyJson),
        headers: otlpHeaders,
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
    Effect.withTracerEnabled(false),
  ),
);

/**
 * Same per-response bound as the `/viewer` video branch, for the same measured
 * reason: a small clamp converts playback into sequential round trips (0.616x
 * realtime at 64 KB), while 8 MiB is indistinguishable from no clamp at all.
 */
const ASSET_MAX_VIDEO_RESPONSE_BYTES = 8 * 1024 * 1024;
/**
 * Bounds what a range cannot: a rangeless GET of a video asset ("open in new tab", `curl`, a
 * malformed or multi-range header) would stream any size in one response. Same value as the
 * `/viewer` cap, so one file cannot stall on one route and 413 on the other.
 */
const ASSET_MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * The image equivalent, mirroring `/viewer`'s `VIEWER_MAX_IMAGE_BYTES`. Images
 * have no Range branch at all, so every image response is the unbounded kind.
 */
const ASSET_MAX_IMAGE_BYTES = 64 * 1024 * 1024;

/**
 * Byte cap for an asset served in one unbounded response, or `null` when deliberately uncapped.
 * Only kinds `/viewer` also serves are capped, at its values; browser-preview kinds (a large PDF
 * is ordinary) stay uncapped. Video's cap depends on Range: see `assetVideoRangeResponse`.
 */
export function assetResponseByteCap(path: string): number | null {
  return isWorkspaceImagePreviewPath(path) ? ASSET_MAX_IMAGE_BYTES : null;
}

export type AssetVideoRangeResponse =
  | { readonly status: 200; readonly headers: Record<string, string> }
  | {
      readonly status: 206;
      readonly offset: number;
      readonly bytesToRead: number;
      readonly headers: Record<string, string>;
    }
  | { readonly status: 416; readonly headers: Record<string, string> }
  | { readonly status: 413 };

/**
 * How a video asset answers one request. Video is the only asset kind that needs Range: without
 * it a media element cannot seek (playback snaps back to zero). Pure, so the 206/416 arithmetic
 * is testable without a live server.
 */
export function assetVideoRangeResponse(
  rangeHeader: string | undefined,
  fileSize: number,
): AssetVideoRangeResponse {
  const range = resolveViewerRange(rangeHeader, fileSize, ASSET_MAX_VIDEO_RESPONSE_BYTES);
  if (range === "unsatisfiable") {
    return {
      status: 416,
      headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes */${fileSize}` },
    };
  }
  if (range === undefined) {
    // Only the rangeless branch needs the size cap; a range is already bounded by
    // ASSET_MAX_VIDEO_RESPONSE_BYTES however large the file is.
    return fileSize > ASSET_MAX_VIDEO_BYTES
      ? { status: 413 }
      : { status: 200, headers: { "Accept-Ranges": "bytes" } };
  }
  return {
    status: 206,
    offset: range.start,
    bytesToRead: range.end - range.start + 1,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${range.start}-${range.end}/${fileSize}`,
    },
  };
}

/**
 * Log the refusals a byte-serving route answers with, otherwise invisible (the access log is off
 * by default). A wrapper around the whole handler so a new refusal branch cannot forget it;
 * refusals only, since a line per range request would flood the log while streaming media.
 */
export function logRouteRefusals<E, R>(
  route: string,
): (
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest
> {
  return (effect) =>
    Effect.tap(effect, (response) =>
      response.status < 400
        ? Effect.void
        : Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            yield* Effect.logWarning("Byte route refused a request", {
              route,
              status: response.status,
              path: request.url,
            });
          }),
    );
}
const UNTRACED_REQUEST_PATHS: ReadonlySet<string> = new Set([OTLP_TRACES_PROXY_PATH]);

// HttpRouter.serve builds routes privately; provide the server-wide TracerDisabledWhen to the served layer.
const layerUntracedRequests = Layer.succeed(HttpMiddleware.TracerDisabledWhen)((request) => {
  const queryIndex = request.url.indexOf("?");
  const path = queryIndex === -1 ? request.url : request.url.slice(0, queryIndex);
  // Webhook URLs carry their secret token in the path, so they never reach a trace.
  return UNTRACED_REQUEST_PATHS.has(path) || path.startsWith(`${WEBHOOK_ROUTE_PREFIX}/`);
});

export const withUntracedRequests = Layer.provide(layerUntracedRequests);

export const layerAssetRoute = HttpRouter.add(
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

    // Annotated so the inferred literal union keeps the optional fields every file claim may carry.
    const asset: ResolvedAsset | null = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    if (asset.kind === "bytes") {
      return HttpServerResponse.uint8Array(asset.bytes, {
        contentType: asset.mimeType,
        headers: { "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
      });
    }
    if (asset.kind === "source-control-media") {
      return yield* sourceControlMediaResponse(asset, request.headers).pipe(
        Effect.tapError((cause) =>
          // The URL can carry a token in its query string, and the error keeps the request it
          // failed on; the host and the failure kind are enough to diagnose.
          Effect.logWarning("Failed to fetch source control media.", {
            host: URL.canParse(asset.url) ? new URL(asset.url).host : undefined,
            reason: cause.reason._tag,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.empty({
            status: 502,
            headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
          }),
        ),
      );
    }
    if (asset.file) {
      // Host files outside any workspace resolve to an open descriptor rather than a
      // path, and only upstream's helper serves from one. Workspace assets take the
      // branch below, which it has no equivalent for.
      return yield* assetFileResponse(
        asset,
        request.method === "GET" ? request.headers.range : undefined,
        request.headers["if-range"],
        request.method === "HEAD" ? "HEAD" : "GET",
      ).pipe(
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Internal Server Error", { status: 500 }),
        ),
      );
    }

    const headers = assetResponseHeaders(
      asset.path,
      asset.download || asset.mimeType !== undefined
        ? {
            ...(asset.download ? { download: true } : {}),
            ...(asset.fileName !== undefined ? { fileName: asset.fileName } : {}),
            ...(asset.mimeType !== undefined ? { mimeType: asset.mimeType } : {}),
          }
        : undefined,
    );

    // Video answers Range; every other asset keeps the flat 200 it has always
    // had. The size comes from a stat because a range can only be resolved
    // against the real length, and `resolveAsset` reports the path alone.
    if (isWorkspaceMediaPreviewPath(asset.path)) {
      const fileSystem = yield* FileSystem.FileSystem;
      const info = yield* fileSystem.stat(asset.path).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      // Two guards adopted from upstream's competing Range implementation, which this branch
      // replaces: a HEAD has no body to range, and an `If-Range` we cannot validate must degrade
      // to the full representation rather than hand back bytes from a stale version.
      const rangeHeader =
        request.method === "GET" && request.headers["if-range"] === undefined
          ? request.headers["range"]
          : undefined;
      const video = assetVideoRangeResponse(rangeHeader, Number(info.value.size));
      if (video.status === 413) {
        return HttpServerResponse.text("Video too large to preview", { status: 413 });
      }
      if (video.status === 416) {
        // The asset headers are deliberately left off: spreading the file's
        // `video/mp4` onto a text body labels "Requested range not satisfiable"
        // as a video.
        return HttpServerResponse.text("Requested range not satisfiable", {
          status: 416,
          headers: video.headers,
        });
      }
      return yield* HttpServerResponse.file(asset.path, {
        ...(video.status === 200
          ? { status: 200 }
          : { status: 206, offset: video.offset, bytesToRead: video.bytesToRead }),
        headers: { ...headers, ...video.headers },
      }).pipe(
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Internal Server Error", { status: 500 }),
        ),
      );
    }

    // Images have no Range branch, so this stat is their only bound: a size cap, and a
    // regular-file check, because a DIRECTORY named `foo.png` stats fine, emits a 200 with a
    // bogus content-length, then errors EISDIR after the headers are flushed.
    const byteCap = assetResponseByteCap(asset.path);
    if (byteCap !== null) {
      const fileSystem = yield* FileSystem.FileSystem;
      const info = yield* fileSystem.stat(asset.path).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      if (Number(info.value.size) > byteCap) {
        return HttpServerResponse.text("Image too large to preview", { status: 413 });
      }
    }

    return yield* HttpServerResponse.file(asset.path, {
      status: 200,
      headers,
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }).pipe(logRouteRefusals(ASSET_ROUTE_PREFIX)),
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
 * Rendered markdown passes raw HTML through from files the user did not write (a cloned README,
 * an agent report), so it gets no `allow-scripts`; the in-app viewer renders it script-inert too.
 * `.html` keeps scripts, because opening an interactive report is why that case exists.
 */
const VIEWER_MARKDOWN_CSP = "sandbox allow-popups";

/** How a `/viewer` request should be served. */
export type ViewerPathKind = "markdown" | "html" | "text" | "image" | "video" | "audio";

/**
 * The pinned `Content-Type` for an audio or video path, as a spreadable object. Kept apart from
 * the other media headers because the text 416/413 bodies must not get it. Empty for an unmapped
 * extension, leaving the platform's `Mime` lookup rather than asserting a type.
 */
export function viewerMediaContentType(absolutePath: string): Record<string, string> {
  const extension = absolutePath.slice(absolutePath.lastIndexOf(".")).toLowerCase();
  const contentType =
    VIDEO_CONTENT_TYPE_BY_EXTENSION[extension] ?? AUDIO_CONTENT_TYPE_BY_EXTENSION[extension];
  return contentType ? { "Content-Type": contentType } : {};
}

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
 * Video is served as bytes for the same reason images are — the text reader's
 * NUL-byte guard rejects it — but unlike images it also needs Range, because
 * without it a media element cannot seek: measured, the scrubber moves, `seeked`
 * fires, and playback restarts at zero.
 */
const VIDEO_VIEWER_EXTENSIONS = new Set<string>(WORKSPACE_VIDEO_PREVIEW_EXTENSIONS);
/**
 * Audio takes the same branch as video: same NUL-byte problem, and the same need
 * for Range, since seeking a podcast-length `.mp3` fails exactly the way seeking
 * a video does without it. Only the element the client renders differs.
 */
const AUDIO_VIEWER_EXTENSIONS = new Set<string>(WORKSPACE_AUDIO_PREVIEW_EXTENSIONS);
/**
 * Per-RESPONSE bound, not a transfer bound: it turns one stream into sequential round trips.
 * Measured on a 561 MB video over a 60 ms link, 64 KB dropped playback to 0.616x realtime, while
 * 8 MiB is indistinguishable from no clamp.
 */
const VIEWER_MAX_VIDEO_RESPONSE_BYTES = 8 * 1024 * 1024;
/**
 * Stat-based cap for the branch that has no range to bound it. A rangeless GET —
 * `curl`, "Open in new tab", a malformed or multi-range header — would otherwise
 * stream an arbitrarily large file, which is exactly what the image cap exists to
 * prevent.
 */
const VIEWER_MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * `HttpServerResponse.file` silently DROPS its `contentType` option — the platform
 * derives the type from the path via `Mime` — so the type is pinned through
 * `headers` instead. Keyed off this map so the served type can only be one of the
 * extensions the allow-list admits.
 */
/**
 * Content types for a document's own relative assets: `.js`/`.css` need real types (a browser
 * will not run them as `text/plain` + `nosniff`) and neither renders as a document. Exhaustive on
 * purpose: anything else 404s, with no `text/plain` fallback that would let a hostile document
 * read files under its grant. Kept apart from the viewer's video list so it can stay narrower.
 */
export const VIEWER_ASSET_CONTENT_TYPES: Record<string, string> = {
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
  ".wasm": "application/wasm",
  // Media a prototype legitimately loads. Deliberately no `.txt`/`.csv`/`.md`:
  // those are shapes a secret actually takes, and the document can already be
  // handed text it is entitled to through the page itself.
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webmanifest": "application/manifest+json",
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

/** A directory's filesystem identity. Two paths naming one directory share it. */
export interface DirectoryIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

/**
 * Whether a directory may be a viewer asset grant, by filesystem IDENTITY: refused at home or any
 * ancestor, or when it contains home (macOS `/System/Volumes/Data` is a firmlink no string compare
 * sees). Measure under node, not bun, whose `realpath` collapses it. Lossy 64-bit inodes can only
 * over-refuse. Not covered: `/System`, `/System/Volumes` (root-owned, sealed).
 */
export function isGrantableViewerAssetDirectory(
  grant: DirectoryIdentity,
  homeChain: ReadonlyArray<DirectoryIdentity>,
  containsHome: boolean,
): boolean {
  if (containsHome) return false;
  return !homeChain.some((entry) => entry.dev === grant.dev && entry.ino === grant.ino);
}

/**
 * The whole grant decision with the filesystem behind one injected lookup, so a test can drive a
 * fake tree where one directory has two paths. A null identity for home or the grant REFUSES; for
 * the containment probe it ALLOWS (that path usually does not exist), so the caller must supply an
 * identity for every path this asks about.
 */
export function resolveViewerAssetGrantDecision(input: {
  readonly directory: string;
  readonly homeDirectory: string;
  readonly identityOf: (path: string) => DirectoryIdentity | null;
  readonly dirname: (path: string) => string;
  readonly join: (...segments: ReadonlyArray<string>) => string;
}): boolean {
  const { directory, homeDirectory, identityOf, dirname, join } = input;

  const homeIdentity = identityOf(homeDirectory);
  if (homeIdentity === null) return false;

  const homeChain: Array<DirectoryIdentity> = [];
  for (let ancestor = homeDirectory; ; ancestor = dirname(ancestor)) {
    const identity = identityOf(ancestor);
    if (identity !== null) homeChain.push(identity);
    if (ancestor === dirname(ancestor)) break;
  }

  const grantIdentity = identityOf(directory);
  if (grantIdentity === null) return false;

  const homeFromRoot = homeDirectory.replace(/^\/+/, "");
  const viaGrant = homeFromRoot.length === 0 ? null : identityOf(join(directory, homeFromRoot));
  const containsHome =
    viaGrant !== null && viaGrant.dev === homeIdentity.dev && viaGrant.ino === homeIdentity.ino;

  return isGrantableViewerAssetDirectory(grantIdentity, homeChain, containsHome);
}

/**
 * Content type for a file the sandboxed viewer document may load, else null (404). Only the part
 * BELOW the grant is checked for dot segments, so `.ssh` siblings stay out. This narrows, not
 * removes, the read capability (a real `connect-src` would close it). Callers MUST pass the
 * realpath and have checked `isWithinGrantedDirectory`, since the relative part is sliced.
 */
export function classifyViewerAssetPath(
  directory: string,
  resolvedPath: string,
): { readonly contentType: string; readonly isDocument: boolean } | null {
  const relative = resolvedPath.slice(directory.length);
  if (relative.split("/").some((segment) => segment.startsWith("."))) return null;

  const lastSlash = resolvedPath.lastIndexOf("/");
  const lastDot = resolvedPath.lastIndexOf(".");
  // A dot in a parent segment is not an extension, and a bare filename has none —
  // slicing on a bare `lastIndexOf` would read the last character as one.
  const extension = lastDot > lastSlash ? resolvedPath.slice(lastDot).toLowerCase() : "";

  if (HTML_EXTENSIONS.has(extension)) {
    return { contentType: "text/html; charset=utf-8", isDocument: true };
  }
  const contentType = IMAGE_CONTENT_TYPES[extension] ?? VIEWER_ASSET_CONTENT_TYPES[extension];
  return contentType === undefined ? null : { contentType, isDocument: false };
}

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
  if (VIDEO_VIEWER_EXTENSIONS.has(extension)) return { absolutePath, kind: "video" };
  if (AUDIO_VIEWER_EXTENSIONS.has(extension)) return { absolutePath, kind: "audio" };
  if (TEXT_VIEWER_EXTENSIONS.has(extension)) return { absolutePath, kind: "text" };
  return null;
}

/**
 * Serve a file as a real, refreshable URL so "Open in new tab" reloads from disk. `readTrustedFile`
 * has no path sandbox, so the `orchestration:read` scope is the only boundary, with no
 * local-process waiver: a co-located proxy is indistinguishable from a local process.
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
    // Classified first so a bad path is a 400 rather than a 401, which would
    // otherwise make "unsupported extension" and "not signed in" indistinguishable.
    const target = classifyViewerPath(url.value.pathname.slice(VIEWER_ROUTE_PREFIX.length));
    if (!target) {
      return HttpServerResponse.text("Invalid or unsupported file path", { status: 400 });
    }
    const { absolutePath, kind } = target;

    // Unconditional: `readTrustedFile` applies no path sandbox. A loopback waiver was removed
    // because a co-located reverse proxy (or an L4 forward) looks local and handed remote visitors
    // any readable file; "Open in new tab" is same-origin and carries the session cookie anyway.
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);

    // `nosniff` makes the text/plain guarantee robust: a code file whose bytes
    // happen to look like HTML must never be content-sniffed and rendered as a
    // document (the sandbox CSP already neuters it, but don't rely on that alone).
    const headers = {
      "Cache-Control": "no-store",
      "Content-Security-Policy": VIEWER_CSP,
      "X-Content-Type-Options": "nosniff",
    };

    // Images bypass the text reader, and `HttpServerResponse.file` re-applies none of its guards,
    // so two are re-added: a regular-file check (a DIRECTORY named `foo.png` errors EISDIR after
    // the headers flush) and a size bound.
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
          // The strict SVG policy matters for a top-level navigation to an .svg, which is
          // same-origin with the app; an <img> embed never runs script.
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

    // Video adds Range to the image branch's guards, so a media element can seek. All of this
    // runs after auth on purpose: a stat ahead of it would be an existence and size oracle.
    if (kind === "video" || kind === "audio") {
      const fileSystem = yield* FileSystem.FileSystem;
      const info = yield* fileSystem.stat(absolutePath).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      const size = Number(info.value.size);
      const rangeHeaders = { ...headers, "Accept-Ranges": "bytes" };
      const videoHeaders = { ...rangeHeaders, ...viewerMediaContentType(absolutePath) };
      const range = resolveViewerRange(
        request.headers["range"],
        size,
        VIEWER_MAX_VIDEO_RESPONSE_BYTES,
      );
      if (range === "unsatisfiable") {
        return HttpServerResponse.text("Requested range not satisfiable", {
          status: 416,
          headers: { ...rangeHeaders, "Content-Range": `bytes */${size}` },
        });
      }
      // Only the rangeless branch needs the stat cap; a range is already bounded by
      // VIEWER_MAX_VIDEO_RESPONSE_BYTES no matter how large the file is.
      if (range === undefined && size > VIEWER_MAX_VIDEO_BYTES) {
        return HttpServerResponse.text("Video too large to preview", { status: 413 });
      }
      // Same funnel as the image branch: a file that vanished between stat and
      // open fails with a PlatformError this route has no other handler for.
      return yield* HttpServerResponse.file(
        absolutePath,
        range === undefined
          ? { status: 200, headers: videoHeaders }
          : {
              status: 206,
              offset: range.start,
              bytesToRead: range.end - range.start + 1,
              headers: {
                ...videoHeaders,
                "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
              },
            },
      ).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("Not Found", { status: 404 })));
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
      // Redirect to a token-scoped URL so RELATIVE assets work from the sandbox's opaque origin,
      // which sends no cookie (see viewerAssetTokens). The directory is realpath-resolved, as the
      // asset route's containment check is, so a symlink inside cannot point anywhere on disk.
      const documentFileSystem = yield* FileSystem.FileSystem;
      const documentPath = yield* Path.Path;
      const parentDirectory = documentPath.dirname(absolutePath);
      const directory = yield* documentFileSystem
        .realPath(parentDirectory)
        .pipe(Effect.orElseSucceed(() => parentDirectory));
      // Every path the decision asks about is stat'ed once up front by identity (a firmlinked
      // home shares no prefix with `/Users/me`), so the decision itself stays a pure function.
      const identityOf = (path: string) =>
        documentFileSystem.stat(path).pipe(
          Effect.map((info) =>
            Option.isSome(info.ino) ? { dev: info.dev, ino: info.ino.value } : null,
          ),
          Effect.orElseSucceed(() => null),
        );
      const homeDirectory = yield* documentFileSystem
        .realPath(NodeOS.homedir())
        .pipe(Effect.orElseSucceed(() => NodeOS.homedir()));
      const homeFromRoot = homeDirectory.replace(/^\/+/, "");
      const probePaths = new Set<string>([directory, homeDirectory]);
      for (let ancestor = homeDirectory; ; ancestor = documentPath.dirname(ancestor)) {
        probePaths.add(ancestor);
        if (ancestor === documentPath.dirname(ancestor)) break;
      }
      if (homeFromRoot.length > 0) probePaths.add(documentPath.join(directory, homeFromRoot));
      const identities = new Map<string, DirectoryIdentity | null>();
      for (const probePath of probePaths) {
        identities.set(probePath, yield* identityOf(probePath));
      }
      // `probePaths` duplicates the decision's lookups, and an unprobed containment path would
      // ALLOW; telling "not probed" from "unreadable" makes that divergence a refusal.
      let missedProbe: string | null = null;
      const grantable = resolveViewerAssetGrantDecision({
        directory,
        homeDirectory,
        identityOf: (path) => {
          if (!identities.has(path)) {
            missedProbe = path;
            return null;
          }
          return identities.get(path) ?? null;
        },
        dirname: (path) => documentPath.dirname(path),
        join: (...segments) => documentPath.join(...segments),
      });
      if (missedProbe !== null) {
        yield* Effect.logWarning("viewer asset grant asked about an unprobed path", {
          path: missedProbe,
        });
      }
      // Too broad to grant: serve inline, with no capability over its tree. Streamed, because
      // `readTrustedFile` caps contents at 1MiB and would cut a self-contained report mid-tag.
      if (!grantable || missedProbe !== null) {
        return yield* HttpServerResponse.file(absolutePath, {
          status: 200,
          headers: {
            ...headers,
            // `HttpServerResponse.file` drops `contentType` (the platform derives
            // it from the path), so it is pinned through headers instead.
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": VIEWER_CSP,
          },
        }).pipe(
          // Same funnel the image branch uses: a PlatformError from a file that
          // vanished between read and open would otherwise escape unhandled.
          Effect.orElseSucceed(() => HttpServerResponse.text("Not Found", { status: 404 })),
        );
      }
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
    // After `catchTags`, so an auth refusal is logged alongside the 404s and 413s
    // rather than being the one refusal that stays silent.
    logRouteRefusals(VIEWER_ROUTE_PREFIX),
  ),
);

/**
 * Serve a sandboxed viewer document and its assets, authorized only by a path-embedded token (an
 * opaque origin sends no cookie). A token covers one realpath subtree, expires in minutes, and is
 * minted only for a caller already allowed to read the document; assets never serve as HTML.
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

    // Not an asset kind: 404 rather than serving it as text. The grant is a whole
    // subtree and the reader is a script-enabled document, so "anything under the
    // token" is far too wide a capability to hand out.
    const asset = classifyViewerAssetPath(directory, resolvedPath.value);
    if (asset === null) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const { contentType, isDocument } = asset;

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
  }).pipe(logRouteRefusals(VIEWER_ASSET_ROUTE_PREFIX)),
);

export const layerAttachmentUploadRoute = HttpRouter.add(
  "POST",
  `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const token = url.value.pathname.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
    if (!token) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const claims = yield* validateAttachmentUploadToken(token);
    if (!claims) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const contentLengthHeader = request.headers["content-length"];
    if (
      contentLengthHeader !== undefined &&
      (!Number.isInteger(Number(contentLengthHeader)) ||
        Number(contentLengthHeader) !== claims.sizeBytes)
    ) {
      return HttpServerResponse.text("Content-Length must match the upload size.", {
        status: 400,
      });
    }

    // Keep the request stream in the route scope until the response is sent.
    const bodyPull = yield* Stream.toPull(request.stream);
    const stored = yield* storeAttachmentUpload(claims, Stream.fromPull(Effect.succeed(bodyPull)));
    return stored.ok
      ? HttpServerResponse.empty({ status: 204 })
      : HttpServerResponse.text(stored.detail, { status: stored.status });
  }),
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

const decodeBuildManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        file: Schema.String,
        css: Schema.optional(Schema.Array(Schema.String)),
        assets: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
);

const loadImmutableBuildAssets = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const staticDir =
    config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
  if (!staticDir) return new Set<string>();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(staticDir, ".vite", "manifest.json")).pipe(
    Effect.flatMap(decodeBuildManifest),
    Effect.map(
      (manifest) =>
        new Set(
          Object.values(manifest).flatMap((entry) => [
            entry.file,
            ...(entry.css ?? []),
            ...(entry.assets ?? []),
          ]),
        ),
    ),
    Effect.orElseSucceed(() => new Set<string>()),
  );
});

const openStaticFile = Effect.fn("openStaticFile")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  if (pathInfo?.type !== "File") return null;
  const file = yield* fileSystem.open(filePath, { flag: "r" }).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
    }),
  );
  // Electron asar can stat and read files even when opening a handle returns NotFound.
  // Refresh path metadata because the file may have been replaced since the first stat.
  const info = yield* file === null ? fileSystem.stat(filePath) : file.stat;
  return info.type === "File" ? { file, info } : null;
});

const streamStaticFile = (file: FileSystem.File, size: bigint) =>
  Stream.unfold(
    0n,
    Effect.fnUntraced(function* (offset: bigint) {
      if (offset >= size) return;
      const remaining = size - offset;
      const bytes = yield* file.readAlloc(Number(remaining < 65_536n ? remaining : 65_536n));
      if (Option.isNone(bytes)) return;
      return [bytes.value, offset + BigInt(bytes.value.byteLength)] as const;
    }),
  );

const handleStaticAndDevRequest = Effect.fn("handleStaticAndDevRequest")(
  function* (immutableBuildAssets: ReadonlySet<string>) {
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
    if (!staticDir && config.devUrl) {
      // `vp run dev --share --built` prints the pairing URL before its first
      // web build lands in apps/web/dist. Reload until it does.
      return HttpServerResponse.text(
        '<!doctype html><meta http-equiv="refresh" content="2"><p>Waiting for the first web build. This page reloads by itself.</p>',
        { status: 503, contentType: "text/html", headers: { "Retry-After": "2" } },
      );
    }
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

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

    let opened = yield* openStaticFile(filePath);
    if (!opened) {
      filePath = path.resolve(staticRoot, "index.html");
      opened = yield* openStaticFile(filePath);
      if (!opened) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
    }
    const fileInfo = opened.info;
    const mimeType = Option.getOrElse(Mime.getType(filePath), () => "application/octet-stream");
    const isHtml = mimeType === "text/html";

    // A hash-like name is not enough: custom static files can use the same naming pattern.
    const relativePath = path.relative(staticRoot, filePath).replaceAll("\\", "/");
    const immutable =
      !isHtml &&
      /^assets\/.+-[\w-]{8}\.[^/]+$/.test(relativePath) &&
      immutableBuildAssets.has(relativePath);
    const cacheControl = immutable ? "public, max-age=31536000, immutable" : "no-cache";
    const validators = (info: FileSystem.File.Info) => {
      // Deployments can preserve HTML size and mtime while changing its bundle URLs.
      const modifiedAt = isHtml ? undefined : Option.getOrUndefined(info.mtime);
      return modifiedAt
        ? {
            ETag: `W/"${info.size.toString(16)}-${modifiedAt.getTime().toString(16)}"`,
            "Last-Modified": modifiedAt.toUTCString(),
          }
        : {};
    };
    const headers: Record<string, string> = {
      "Cache-Control": cacheControl,
      ...validators(fileInfo),
    };
    const etag = headers.ETag;
    const lastModified = headers["Last-Modified"];

    // If-None-Match precedes dates and uses weak GET/HEAD comparison even across compression.
    const ifNoneMatch = request.headers["if-none-match"];
    const ifModifiedSince = request.headers["if-modified-since"];
    const unchanged =
      ifNoneMatch !== undefined
        ? ifNoneMatch.split(",").some((value) => {
            const candidate = value.trim();
            return (
              candidate === "*" ||
              (etag !== undefined && candidate.replace(/^W\//i, "") === etag.slice(2))
            );
          })
        : ifModifiedSince !== undefined &&
          lastModified !== undefined &&
          Date.parse(lastModified) <= Date.parse(ifModifiedSince);
    if (!isHtml && unchanged) {
      return HttpServerResponse.empty({
        status: 304,
        headers: { ...headers, Vary: "Accept-Encoding" },
      });
    }

    const contentType = isHtml ? "text/html; charset=utf-8" : mimeType;
    if (opened.file === null && request.method !== "HEAD") {
      const fileSystem = yield* FileSystem.FileSystem;
      // Complete fallback reads before success headers; stream errors arrive too late for a 500.
      const bytes = yield* fileSystem.readFile(filePath);
      const info = yield* fileSystem.stat(filePath);
      return HttpServerResponse.uint8Array(bytes, {
        headers: {
          "Cache-Control": cacheControl,
          ...validators({ ...info, size: ByteSize.bytes(bytes.byteLength) }),
        },
        contentType,
      });
    }
    // The request scope closes the handle for GET, HEAD, 304, errors, and cancellation.
    // HEAD still passes through compression, which selects headers without reading the stream.
    return HttpServerResponse.stream(
      opened.file === null ? Stream.empty : streamStaticFile(opened.file, fileInfo.size),
      {
        headers,
        contentType,
        contentLength: Number(fileInfo.size),
      },
    );
  },
  Effect.catchTags({
    PlatformError: () =>
      Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
  }),
);

export const layerStaticAndDevRoute = Layer.unwrap(
  loadImmutableBuildAssets.pipe(
    Effect.map((assets) => HttpRouter.add("GET", "*", handleStaticAndDevRequest(assets))),
  ),
);
