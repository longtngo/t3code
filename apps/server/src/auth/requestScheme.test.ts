import { describe, expect, it } from "vite-plus/test";

import { requestIsHttps } from "./requestScheme.ts";

const request = (headers: Record<string, string>, originalUrl = "/api/auth/browser-session") =>
  ({ headers, originalUrl }) as never;

describe("requestIsHttps", () => {
  it("trusts x-forwarded-proto from a terminating proxy", () => {
    // The remote deployments that matter: T3 Connect, Tailscale, app.t3.codes.
    expect(requestIsHttps(request({ "x-forwarded-proto": "https" }))).toBe(true);
    expect(requestIsHttps(request({ "x-forwarded-proto": "HTTPS" }))).toBe(true);
  });

  it("reads only the first hop of a proxy chain", () => {
    // The client-facing hop is the one that decides whether the cookie ever
    // travels in clear text; later hops may legitimately be http.
    expect(requestIsHttps(request({ "x-forwarded-proto": "https, http" }))).toBe(true);
    expect(requestIsHttps(request({ "x-forwarded-proto": "http, https" }))).toBe(false);
  });

  it("says no for plain http, so local sessions still work", () => {
    // The regression this must never cause: `npx t3` and the dev server are
    // plaintext, and a Secure cookie there is silently discarded by the browser,
    // making login impossible.
    expect(requestIsHttps(request({ "x-forwarded-proto": "http" }))).toBe(false);
    expect(requestIsHttps(request({}, "http://localhost:13773/api/auth"))).toBe(false);
  });

  it("falls back to the request url when no proxy header is present", () => {
    expect(requestIsHttps(request({}, "https://app.t3.codes/api/auth"))).toBe(true);
  });

  it("assumes plaintext when there is no scheme to read", () => {
    // A relative originalUrl is the common shape behind a direct listener.
    expect(requestIsHttps(request({}))).toBe(false);
    expect(requestIsHttps(request({ "x-forwarded-proto": "" }))).toBe(false);
    expect(requestIsHttps(request({}, "not a url"))).toBe(false);
  });
});
