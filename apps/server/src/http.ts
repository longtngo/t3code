import * as NodeOS from "node:os";

import Mime from "@effect/platform-node/Mime";
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
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import { summarizeOtlpTraceData } from "./observability/otlpTraceSummary.ts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";
import { WebPushRelay } from "./push/WebPushRelay.ts";
import { registerPushSubscription } from "./push/register.ts";
import { resolveViewerRange } from "./viewerRange.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const PUSH_SUBSCRIPTIONS_PATH = "/api/push/subscriptions";
const PUSH_VAPID_PUBLIC_KEY_PATH = "/api/push/vapid-public-key";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"];
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
// HTML previews are agent output, not the app. The sandbox gives the document an
// opaque origin: scripts run, but same-origin cookies, storage, and API calls are
// out of reach. Relative sibling assets still load through their signed URLs.
const HTML_CONTENT_SECURITY_POLICY = "sandbox allow-scripts allow-forms allow-popups allow-modals";

// Types a browser may render as a document if a proxy strips the disposition
// header. Downloads of these fall back to octet-stream.
const DOWNLOAD_MIME_TYPE_PATTERN = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;
const isSafeDownloadMimeType = (mimeType: string): boolean =>
  DOWNLOAD_MIME_TYPE_PATTERN.test(mimeType) &&
  !/(?:^text\/html$|\/xml(?:$|-)|\+xml$)/i.test(mimeType.trim().toLowerCase());
const isSafeInlineMediaMimeType = (mimeType: string): boolean =>
  DOWNLOAD_MIME_TYPE_PATTERN.test(mimeType) && /^(?:audio|video)\//i.test(mimeType);
const isSafeInlineDocumentMimeType = (mimeType: string): boolean =>
  mimeType.toLowerCase() === "application/pdf" || mimeType.toLowerCase() === "text/html";

/** RFC 6266 disposition with an ASCII fallback name plus a UTF-8 `filename*`. */
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

/** A single byte range for native media readers; unsupported range syntax uses the full file. */
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
  },
  rangeHeader?: string,
  ifRangeHeader?: string,
  method: "GET" | "HEAD" = "GET",
) {
  const headers = assetResponseHeaders(asset.path, asset);
  const mediaFile = asset.file;
  const mediaInfo = mediaFile ? yield* statMediaFile(asset.path, mediaFile) : undefined;
  const isMedia = /^(?:audio|video)\//i.test(headers["Content-Type"] ?? "");
  if (isMedia) {
    // Host media can change in place. Do not invite conditional range requests
    // with validators that cannot establish byte-for-byte identity. Attachment media
    // carries no `file`, and must not outlive the signed URL that granted it either.
    headers["Cache-Control"] = "private, no-store";
  }
  let status = 200;
  let offset = 0n;
  let bytesToRead: bigint | undefined;
  if (isMedia) {
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
    headers["Content-Type"] ??= Mime.getType(asset.path) ?? "application/octet-stream";
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
          ...summarizeOtlpTraceData(bodyJson),
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

/**
 * Same per-response bound as the `/viewer` video branch, for the same measured
 * reason: a small clamp converts playback into sequential round trips (0.616x
 * realtime at 64 KB), while 8 MiB is indistinguishable from no clamp at all.
 */
const ASSET_MAX_VIDEO_RESPONSE_BYTES = 8 * 1024 * 1024;
/**
 * Bounds the branch a range cannot bound. A rangeless GET of a video asset —
 * "open in new tab", `curl`, a malformed or multi-range header — would otherwise
 * stream a file of any size in one response. Same value and same reason as the
 * `/viewer` route's cap: the identical file must not stall on one route and 413
 * on the other.
 */
const ASSET_MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * The image equivalent, mirroring `/viewer`'s `VIEWER_MAX_IMAGE_BYTES`. Images
 * have no Range branch at all, so every image response is the unbounded kind.
 */
const ASSET_MAX_IMAGE_BYTES = 64 * 1024 * 1024;

/**
 * Byte cap for an asset served in one unbounded response, or `null` for a kind
 * that is deliberately left uncapped.
 *
 * Only the kinds `/viewer` also serves are capped, and at the same values, so the
 * same file cannot stall on one route and 413 on the other. The browser-preview
 * kinds (`.pdf`, `.htm`, `.html`) are deliberately absent: `/viewer` never served
 * them, so there is no divergence to close, and a PDF past this bound is ordinary
 * rather than suspicious — capping it would be a new refusal, not a fix. Video is
 * absent too; its cap depends on the request's Range, so it lives in
 * `assetVideoRangeResponse`.
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
 * How a video asset answers one request.
 *
 * Video is the only asset kind that needs Range: without it a media element
 * cannot seek — measured on the `/viewer` route, the scrubber moves, `seeked`
 * fires, and playback snaps back to zero. Pure, so the 206/416 arithmetic is
 * testable without a live server, mirroring `viewerMediaContentType`.
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
 * Log the refusals a byte-serving route answers with, which are otherwise
 * completely invisible.
 *
 * These routes had three log calls between them and none on the request path, so
 * a 400, 404, 413 or 416 reached the client as a notice with nothing server-side
 * to correlate it against — and the access log that would have shown it is off by
 * default, behind a flag named `logWebSocketEvents`.
 *
 * Deliberately a wrapper around the whole handler rather than a call at each of
 * the ~20 refusal sites: a new branch cannot forget it, and it costs one status
 * comparison on the success path. Deliberately refusals only, with no per-request
 * line: these routes stream media, and a line per range request would be its own
 * problem on a 561 MB file.
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
      // Two guards adopted from upstream #8919, whose competing Range implementation
      // this branch replaces: a HEAD has no body to range, and an `If-Range` we
      // cannot validate must degrade to the full representation rather than hand
      // back bytes from a version the client no longer holds.
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

    // Images have no Range branch, so nothing else bounds the response. The stat
    // is the same one the `/viewer` image branch takes, and for the same two
    // reasons: a size bound, and a regular-file check, because a DIRECTORY named
    // `foo.png` stats fine, emits a 200 with a bogus content-length, then errors
    // EISDIR after the headers are already flushed.
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
 * Markdown is rendered from a file the user did not write by hand — a cloned repo's README,
 * an agent-written report — and the renderer passes raw HTML through on purpose. Serving
 * that with `allow-scripts` executes markup from those sources as a top-level document.
 * The in-app viewer already renders the same output under `sandbox=""` (scripts inert), so
 * withholding scripts here costs nothing that path has; `.html` keeps them, because opening
 * an interactive report is the reason that case exists.
 */
const VIEWER_MARKDOWN_CSP = "sandbox allow-popups";

/** How a `/viewer` request should be served. */
export type ViewerPathKind = "markdown" | "html" | "text" | "image" | "video" | "audio";

/**
 * The pinned `Content-Type` for an audio or video path, as a spreadable object.
 *
 * Separate from the rest of the media headers because it must reach the byte
 * responses and NOT the 416/413 ones, whose bodies are text — spreading it onto
 * those labels "Requested range not satisfiable" as `video/mp4`. Empty for an
 * extension neither map carries, which leaves the platform's own `Mime` lookup in
 * place rather than asserting a type this route cannot vouch for.
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
 * Per-RESPONSE bound, not a transfer bound. It does not reduce bytes served; it
 * converts one stream into sequential round trips. The value matters in both
 * directions: measured on a 561 MB video over a 60 ms link, a 64 KB clamp drops
 * playback to 0.616x realtime with 37 rebuffers and an 84x slower seek, while
 * 8 MiB is indistinguishable from no clamp at all.
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
 * Content types for a document's own relative assets.
 *
 * `.js` and `.css` MUST get their real types here: the main `/viewer` route serves
 * every text kind as `text/plain` with `nosniff` on purpose, and a browser refuses
 * to execute a script or apply a stylesheet served that way — which is the second
 * reason a multi-file prototype rendered blank. Giving these two their real types
 * is safe in a way `text/html` would not be: neither can be rendered as a document,
 * so the "untrusted bytes must never be parsed as HTML" rule still holds.
 *
 * This list is exhaustive, and that is the security property: `classifyViewerAssetPath`
 * answers `null` for anything not here and the route 404s it. There is deliberately
 * no `text/plain` fallback — that fallback is what let a hostile document read
 * arbitrary files under its grant.
 *
 * Its media entries overlap the viewer's video list, and folding the two together
 * was considered and rejected: this is a sub-resource allow-list for a sandboxed
 * document, so every extension added here widens what such a document can reach.
 * It must be able to stay narrower than what the viewer will play.
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
  readonly dev: number;
  readonly ino: number;
}

/**
 * Whether a directory may be handed out as a viewer asset grant, decided by
 * filesystem IDENTITY rather than by comparing path strings.
 *
 * A grant covers a whole subtree, so the home directory — or anything above it —
 * is far too much to give a document that runs script: the extension allow-list
 * admits every `.json` outside a dot-directory, and on macOS
 * `~/Library/Application Support` is full of credential JSON. Refusing costs
 * nothing real: a single-file report at `~/report.html` has no relative assets to
 * resolve, and a prototype in its own directory still gets a full grant.
 *
 * **This used to compare strings, and three review rounds each found another
 * spelling that defeated it** — case (`/users/me`, because macOS `realpath(3)`
 * does not canonicalize case), Unicode normalization (NFD against NFC), and
 * duplicate separators. Each fix folded one more axis and left the next one open,
 * because the premise was wrong: two paths can name one directory while sharing
 * no prefix at all. On every macOS Catalina or later,
 * `/System/Volumes/Data/Users/me` **is** `/Users/me` — same `dev:ino`, and
 * `realpath` returns it unchanged, since a firmlink is not a symlink. No amount of
 * folding reaches that, and `/System/Volumes/Data` is the real root of all user
 * data while not being the string `"/"`.
 *
 * So the question is asked of the filesystem instead, in two parts, because an
 * alias namespace defeats each one alone.
 *
 * `homeChain` is home and each of its ancestors up to the root; a grant is refused
 * when it *is* any of them. That catches the firmlinked home, whose identity is
 * home's.
 *
 * `containsHome` covers the case the chain cannot see. `/System/Volumes/Data` is a
 * directory in its own right — its inode is not `/`'s — so walking up from home by
 * name never reaches it, yet it contains all of home. The caller answers this by
 * joining the grant with home's root-relative path and asking whether that lands
 * on home's identity: `/System/Volumes/Data` + `Users/me` is home, so refuse;
 * `/tmp` + `Users/me` does not exist, so allow. No macOS path is hardcoded.
 *
 * **What this does NOT cover, stated exactly rather than generally.** The join
 * tests one candidate, so it only fires on the directory where the alias namespace
 * reproduces home's whole root-relative path immediately below it. Home sits at
 * `Volumes/Data/Users/me` under `/System`, not at `Users/me`, so `/System` and
 * `/System/Volumes` are NOT refused even though they contain home. Both are
 * `root:wheel` on the sealed read-only system volume, so a document cannot be
 * planted there without root and SIP disabled, which is why this is recorded
 * rather than chased — but the earlier claim that "any future alias mount is
 * covered" was false, and an alias whose grandparent is user-writable would be a
 * real hole.
 *
 * A directory that is merely outside home (`/tmp/build`) stays grantable, which a
 * strict descendant-of-home test would have broken.
 *
 * **Measure this under node, not bun.** `realpath` canonicalizes a firmlink on bun
 * and returns it unchanged on node; the server runs node. Re-checking with bun
 * shows the alias collapsing and makes this whole guard look unnecessary.
 *
 * `ino` is a JS number while APFS inodes are 64-bit, and the loss is real —
 * `/System/Volumes/Data` is inode 1152921500311879682 and arrives here as
 * ...700. It cannot produce a false ALLOW: both sides go through the same
 * conversion, so two equal inodes always yield two equal numbers. The only
 * reachable error is over-refusal from a collision between distinct inodes, which
 * costs a document its grant and serves it inline.
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
 * The whole grant decision, with the filesystem behind one injected lookup.
 *
 * This exists because the interesting part was not the comparison — it was the
 * ancestor walk, the containment probe, and which side fails open. Those lived in
 * the route, which has no test, so every bypass in this guard's history was found
 * by running it against a real machine and none by the suite. Passing `identityOf`
 * in lets a test drive the real decision over a fake tree that can express the
 * shape which broke this repeatedly: one directory reachable by two paths.
 *
 * `identityOf` returns null for a path it cannot stat, and the three lookups do
 * NOT all fail the same way — which is the thing to know before editing this.
 * A null for home or for the grant REFUSES. A null for the containment probe
 * means "this grant does not contain home", so it ALLOWS, by design: that lookup
 * asks about a path which usually does not exist. The caller must therefore
 * supply an identity for every path this asks about; a lookup it forgot to
 * precompute would read as a legitimate absence rather than as an error.
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
 * Content type for a file the sandboxed viewer document is allowed to load, or
 * null when it is not an asset kind — which the asset route answers with a 404.
 *
 * `classifyViewerPath` applies this discipline on the `/viewer` side; this is the
 * same guard for the route `/viewer` redirects INTO, which needs it more. A grant
 * covers a whole SUBTREE (`isWithinGrantedDirectory` is a prefix test), and the
 * document reading it runs script under a `sandbox`-only CSP that restricts no
 * fetch destination — so it has both a read capability and a channel to send what
 * it reads anywhere.
 *
 * Only the portion BELOW the grant is filtered for dot segments, so a prototype
 * that itself lives under `~/.local/share` still loads its own assets while
 * nothing can descend into a `.ssh` or `.aws` sibling.
 *
 * This NARROWS that capability; it does not remove it. Everything the allow-list
 * admits is still readable anywhere under the grant — notably every `.json`
 * outside a dot-directory, and on macOS `~/Library/Application Support` is full of
 * credential JSON. Two things bound the damage: `isGrantableViewerAssetDirectory`
 * refuses to mint a grant at or above the home directory, and a prototype's own
 * directory is a much smaller blast radius. Closing it properly means giving
 * `VIEWER_CSP` a real `default-src`/`connect-src` so the exfiltration channel does
 * not exist, which needs verifying in a browser against an opaque origin.
 *
 * Callers MUST pass the realpath-resolved path, since that is what gets served,
 * and MUST have checked `isWithinGrantedDirectory` first — the relative portion is
 * computed by slicing, which assumes containment.
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
 * Serve a file as a real, refreshable URL so the viewer's "Open in new tab"
 * reloads from disk instead of showing a frozen snapshot. Markdown is rendered to
 * HTML; `.html` is served as-is; everything else is served as text/plain.
 *
 * `readTrustedFile` applies no path sandbox, so the `orchestration:read` scope below is
 * the only boundary — every path this route serves is an arbitrary absolute path, and
 * every request must present the scope. There is deliberately no local-process waiver:
 * a request's locality cannot be established from what it carries, because a co-located
 * proxy is indistinguishable from a local process at every signal the server can read.
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

    // Unconditional, because `readTrustedFile` applies no path sandbox: every byte
    // this route can serve is an arbitrary absolute path.
    //
    // This used to waive auth when the request looked like it came from a process on
    // this machine. It cannot: a co-located reverse proxy has the same loopback peer
    // as a local process, and nginx's default `Host: $proxy_host` rewrites the one
    // header that distinguished them. Measured against real proxies, seven of eight
    // configurations — including a bare `proxy_pass` with no `proxy_set_header` at
    // all — handed a remote, unauthenticated visitor the contents of any readable
    // text file. An L4/TCP forward (`stream`, HAProxy `mode tcp`, `socat`,
    // `ssh -L`) is worse still: the client supplies `Host` itself and no operator
    // configuration can intervene.
    //
    // Nothing shipped lost anything. "Open in new tab" opens this app's own origin
    // (`ChatMarkdown.tsx`), so it is a same-origin top-level navigation and carries
    // the `SameSite=Lax` session cookie; the `<img>`/`<iframe>` byte source is a
    // different URL built against the environment's base (`viewerPath.ts`), and was
    // never waived anyway. The waiver's stated beneficiary was a local `curl`, whose
    // own justification was that it can already read the file directly.
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);

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

    // Video carries the image branch's two re-added guards (regular file, size
    // bound) and adds Range, without which a media element cannot seek. Everything
    // here is after the auth call above on purpose: a `stat` ahead of it would turn
    // 404-vs-416 into an existence oracle and `Content-Range: bytes */N` into a
    // size oracle for a caller with no credentials.
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
      return yield* HttpServerResponse.file(absolutePath, {
        ...(range === undefined
          ? { status: 200, headers: videoHeaders }
          : {
              status: 206,
              offset: range.start,
              bytesToRead: range.end - range.start + 1,
              headers: {
                ...videoHeaders,
                "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
              },
            }),
        // Same funnel as the image branch: a file that vanished between stat and
        // open fails with a PlatformError this route has no other handler for.
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("Not Found", { status: 404 })));
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
      // Home and every ancestor up to the root, by filesystem identity. Comparing
      // path strings cannot work here: `/System/Volumes/Data/Users/me` IS
      // `/Users/me` on macOS, sharing no prefix and surviving `realPath` unchanged,
      // because a firmlink is not a symlink.
      // Stat every path once, up front: the walk and the containment probe are
      // synchronous once identities are in hand, which is what lets the decision
      // live in a testable pure function instead of in this handler.
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
      const identities = new Map<string, { readonly dev: number; readonly ino: number } | null>();
      for (const probePath of probePaths) {
        identities.set(probePath, yield* identityOf(probePath));
      }
      // `probePaths` is a second, independently maintained copy of the set of
      // paths the decision asks about. It is correct today, but a lookup added
      // there without being added here would return `undefined`, and for the
      // containment probe an absent identity ALLOWS. Distinguishing "not probed"
      // from "probed and unreadable" turns that future divergence from a silent
      // fail-open into a refusal.
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
      // Too broad to grant: serve the document inline instead, so it still renders
      // but gets no capability over the tree it happens to sit in. Streamed rather
      // than echoing `file.value.contents`, which `readTrustedFile` caps at 1MiB —
      // a self-contained report is exactly the shape that exceeds that, and it
      // would have been cut mid-tag with no error.
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

export const attachmentUploadRouteLayer = HttpRouter.add(
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
  // Reject directories and special files before opening. Response metadata comes from the handle.
  const pathInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  if (pathInfo?.type !== "File") return null;
  const file = yield* fileSystem.open(filePath, { flag: "r" });
  const info = yield* file.stat;
  return info.type === "File" ? { file, info } : null;
});

const streamStaticFile = (file: FileSystem.File, size: bigint) =>
  Stream.unfold(
    0n,
    Effect.fnUntraced(function* (offset: bigint) {
      if (offset >= size) return;
      const remaining = size - offset;
      const bytes = yield* file.readAlloc(remaining < 65_536n ? remaining : 65_536n);
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
    const mimeType = Mime.getType(filePath) ?? "application/octet-stream";
    const isHtml = mimeType === "text/html";

    // A hash-like name is not enough: custom static files can use the same naming pattern.
    const relativePath = path.relative(staticRoot, filePath).replaceAll("\\", "/");
    const immutable =
      !isHtml &&
      /^assets\/.+-[\w-]{8}\.[^/]+$/.test(relativePath) &&
      immutableBuildAssets.has(relativePath);
    const headers: Record<string, string> = {
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    };
    // Deployments can preserve HTML size and mtime while changing its bundle URLs.
    const modifiedAt = isHtml ? undefined : Option.getOrUndefined(fileInfo.mtime);
    const etag = modifiedAt
      ? `W/"${fileInfo.size.toString(16)}-${modifiedAt.getTime().toString(16)}"`
      : undefined;
    if (etag !== undefined && modifiedAt !== undefined) {
      headers.ETag = etag;
      headers["Last-Modified"] = modifiedAt.toUTCString();
    }

    // If-None-Match takes precedence over dates and uses weak comparison for
    // GET/HEAD, including when compression changes the transferred bytes.
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
          modifiedAt !== undefined &&
          Date.parse(modifiedAt.toUTCString()) <= Date.parse(ifModifiedSince);
    if (!isHtml && unchanged) {
      return HttpServerResponse.empty({
        status: 304,
        headers: { ...headers, Vary: "Accept-Encoding" },
      });
    }

    const contentType = isHtml ? "text/html; charset=utf-8" : mimeType;
    // The request scope closes the handle for GET, HEAD, 304, errors, and cancellation.
    // HEAD still passes through compression, which selects headers without reading the stream.
    return HttpServerResponse.stream(streamStaticFile(opened.file, fileInfo.size), {
      headers,
      contentType,
      contentLength: Number(fileInfo.size),
    });
  },
  Effect.catchTags({
    PlatformError: () =>
      Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
  }),
);

// Read the installed build's manifest once. Unknown files use revalidation.
export const staticAndDevRouteLayer = Layer.unwrap(
  loadImmutableBuildAssets.pipe(
    Effect.map((assets) => HttpRouter.add("GET", "*", handleStaticAndDevRequest(assets))),
  ),
);
