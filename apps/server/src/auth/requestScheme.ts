import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

const firstHeaderValue = (value: string | undefined): string | undefined => {
  const first = value?.split(",")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : undefined;
};

/**
 * Whether the client reached us over HTTPS, including through a terminating proxy.
 *
 * Used to decide the `Secure` flag on the session cookie. `x-forwarded-proto` is
 * trusted here because the failure mode is safe in the direction that matters: a
 * spoofed `https` on a plaintext request makes the browser refuse to store the
 * cookie, which only breaks the sender's own login. It cannot cause a cookie to
 * be sent over plaintext, which is what the flag exists to prevent.
 *
 * T3 Code is served over plain HTTP locally (`npx t3`, the dev server) and over
 * HTTPS remotely (T3 Connect, Tailscale, app.t3.codes), so this cannot simply be
 * hardcoded either way.
 */
export function requestIsHttps(
  request: Pick<HttpServerRequest.HttpServerRequest, "headers" | "originalUrl">,
): boolean {
  const forwarded = firstHeaderValue(request.headers["x-forwarded-proto"]);
  if (forwarded !== undefined) {
    return forwarded.toLowerCase() === "https";
  }
  try {
    return new URL(request.originalUrl).protocol === "https:";
  } catch {
    // A relative originalUrl (the common case behind a direct listener) carries
    // no scheme; absent any other signal, assume plaintext and omit Secure.
    return false;
  }
}
