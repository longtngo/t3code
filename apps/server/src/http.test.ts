import { describe, expect, it } from "vite-plus/test";

import type { HttpServerRequest } from "effect/unstable/http";

import {
  classifyViewerPath,
  isLocalLoopbackRequest,
  isLoopbackHostname,
  resolveDevRedirectUrl,
} from "./http.ts";

function fakeRequest(input: {
  readonly headers?: Record<string, string>;
  readonly remoteAddress?: string | null;
}): HttpServerRequest.HttpServerRequest {
  return {
    headers: input.headers ?? {},
    source: input.remoteAddress === undefined ? undefined : { remoteAddress: input.remoteAddress },
  } as unknown as HttpServerRequest.HttpServerRequest;
}

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("isLocalLoopbackRequest", () => {
  it("trusts a loopback TCP peer", () => {
    expect(isLocalLoopbackRequest(fakeRequest({ remoteAddress: "127.0.0.1" }))).toBe(true);
    expect(isLocalLoopbackRequest(fakeRequest({ remoteAddress: "::1" }))).toBe(true);
    // IPv4-mapped IPv6 loopback is normalized before the check.
    expect(isLocalLoopbackRequest(fakeRequest({ remoteAddress: "::ffff:127.0.0.1" }))).toBe(true);
  });

  it("does not trust a remote TCP peer (Host header is irrelevant)", () => {
    expect(isLocalLoopbackRequest(fakeRequest({ remoteAddress: "192.168.1.20" }))).toBe(false);
    // Even a spoofed Host: localhost cannot flip the decision — peer is what counts.
    expect(
      isLocalLoopbackRequest(
        fakeRequest({ headers: { host: "localhost" }, remoteAddress: "203.0.113.5" }),
      ),
    ).toBe(false);
  });

  it("never trusts a forwarded/proxied request even from a loopback peer", () => {
    expect(
      isLocalLoopbackRequest(
        fakeRequest({ headers: { "x-forwarded-for": "203.0.113.5" }, remoteAddress: "127.0.0.1" }),
      ),
    ).toBe(false);
    expect(
      isLocalLoopbackRequest(
        fakeRequest({ headers: { forwarded: "for=203.0.113.5" }, remoteAddress: "127.0.0.1" }),
      ),
    ).toBe(false);
  });

  it("does not trust a request with no resolvable peer", () => {
    expect(isLocalLoopbackRequest(fakeRequest({}))).toBe(false);
    expect(isLocalLoopbackRequest(fakeRequest({ remoteAddress: null }))).toBe(false);
  });
});

describe("classifyViewerPath", () => {
  it("classifies markdown extensions and decodes the suffix", () => {
    expect(classifyViewerPath("/Users/me/report.md")).toEqual({
      absolutePath: "/Users/me/report.md",
      isMarkdown: true,
    });
    expect(classifyViewerPath("/Users/me/notes.MARKDOWN")?.isMarkdown).toBe(true);
    // Percent-encoded segments (e.g. spaces) are decoded back to the real path.
    expect(classifyViewerPath("/Users/me/my%20report.md")?.absolutePath).toBe(
      "/Users/me/my report.md",
    );
  });

  it("classifies html extensions", () => {
    expect(classifyViewerPath("/tmp/out.html")).toEqual({
      absolutePath: "/tmp/out.html",
      isMarkdown: false,
    });
    expect(classifyViewerPath("/tmp/out.HTM")?.isMarkdown).toBe(false);
  });

  it("rejects relative paths and malformed encodings", () => {
    expect(classifyViewerPath("Users/me/report.md")).toBeNull();
    expect(classifyViewerPath("")).toBeNull();
    expect(classifyViewerPath("/Users/me/%E0%A4%A.md")).toBeNull();
  });

  it("rejects unsupported and extension-less files", () => {
    expect(classifyViewerPath("/Users/me/secret.env")).toBeNull();
    expect(classifyViewerPath("/Users/me/Makefile")).toBeNull();
    // A dot in a parent directory is not an extension of the final segment.
    expect(classifyViewerPath("/Users/me.dir/report")).toBeNull();
  });
});
