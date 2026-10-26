import type * as HttpServerRequest from "effect/http/HttpServerRequest";

const firstHeaderValue = (value: string | undefined): string | undefined => {
  const first = value?.split(",")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : undefined;
};

/**
 * Whether the client reached us over HTTPS, for the cookie's `Secure` flag. Only
 * `x-forwarded-proto` is a real signal (we never terminate TLS), so it relies on the proxy
 * overwriting it. A spoofed `https` only breaks the sender's own login; a spoofed `http`
 * costs something, so a positive HTTPS signal from either source wins.
 */
export function requestIsHttps(
  request: Pick<HttpServerRequest.HttpServerRequest, "headers" | "originalUrl">,
): boolean {
  if (firstHeaderValue(request.headers["x-forwarded-proto"])?.toLowerCase() === "https") {
    return true;
  }
  try {
    return new URL(request.originalUrl).protocol === "https:";
  } catch {
    // A relative originalUrl (the common case behind a direct listener) carries
    // no scheme; absent any other signal, assume plaintext and omit Secure.
    return false;
  }
}
