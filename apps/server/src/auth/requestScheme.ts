import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

const firstHeaderValue = (value: string | undefined): string | undefined => {
  const first = value?.split(",")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : undefined;
};

/**
 * Whether the client reached us over HTTPS, including through a terminating proxy.
 *
 * Used to decide the `Secure` flag on the session cookie. T3 Code is served over
 * plain HTTP locally (`npx t3`, the dev server) and over HTTPS remotely (T3
 * Connect, Tailscale, app.t3.codes), so this cannot be hardcoded either way.
 *
 * `x-forwarded-proto` is the only real signal: the server always listens with a
 * plain `NodeHttp.createServer()` and never terminates TLS itself, and
 * `originalUrl` is an origin-form path, so the URL fallback below is a
 * belt-and-braces branch that a live request does not reach. Which means the
 * `Secure` flag is only as correct as the terminating proxy -- a proxy that
 * forwards a client-supplied value instead of overwriting it lets a client
 * downgrade its own cookie. See docs/operations/reverse-proxy.md.
 *
 * Spoofing is safe in the direction that matters: a spoofed `https` on a
 * plaintext request makes the browser refuse the cookie, breaking only the
 * sender's own login. A spoofed `http` is the direction that costs something,
 * so a positive HTTPS signal from either source wins over it.
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
