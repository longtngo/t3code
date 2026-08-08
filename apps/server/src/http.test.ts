import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import {
  classifyViewerPath,
  isLocalLoopbackRequest,
  isLoopbackHostname,
  isWaivableLocalRequest,
  resolveDevRedirectUrl,
} from "./http.ts";
import type { HttpServerRequest } from "effect/unstable/http";

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

function fakeRequest(input: {
  readonly headers?: Record<string, string>;
  readonly remoteAddress?: string | null;
}): HttpServerRequest.HttpServerRequest {
  return {
    headers: input.headers ?? {},
    source: input.remoteAddress === undefined ? undefined : { remoteAddress: input.remoteAddress },
  } as unknown as HttpServerRequest.HttpServerRequest;
}

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
      kind: "markdown",
    });
    expect(classifyViewerPath("/Users/me/notes.MARKDOWN")?.kind).toBe("markdown");
    // Percent-encoded segments (e.g. spaces) are decoded back to the real path.
    expect(classifyViewerPath("/Users/me/my%20report.md")?.absolutePath).toBe(
      "/Users/me/my report.md",
    );
  });

  it("classifies html extensions", () => {
    expect(classifyViewerPath("/tmp/out.html")).toEqual({
      absolutePath: "/tmp/out.html",
      kind: "html",
    });
    expect(classifyViewerPath("/tmp/out.HTM")?.kind).toBe("html");
  });

  it("classifies text/code extensions as text", () => {
    expect(classifyViewerPath("/Users/me/notes.txt")).toEqual({
      absolutePath: "/Users/me/notes.txt",
      kind: "text",
    });
    expect(classifyViewerPath("/Users/me/validate_sql_qa.py")?.kind).toBe("text");
    expect(classifyViewerPath("/tmp/server.LOG")?.kind).toBe("text");
    expect(classifyViewerPath("/a/Component.tsx")?.kind).toBe("text");
  });

  it("rejects relative paths and malformed encodings", () => {
    expect(classifyViewerPath("Users/me/report.md")).toBeNull();
    expect(classifyViewerPath("")).toBeNull();
    expect(classifyViewerPath("/Users/me/%E0%A4%A.md")).toBeNull();
  });

  it("rejects unsupported, secret, and extension-less files", () => {
    expect(classifyViewerPath("/Users/me/photo.png")).toBeNull();
    expect(classifyViewerPath("/Users/me/secret.env")).toBeNull();
    expect(classifyViewerPath("/Users/me/Makefile")).toBeNull();
    // A dot in a parent directory is not an extension of the final segment.
    expect(classifyViewerPath("/Users/me.dir/report")).toBeNull();
  });
});

describe("isWaivableLocalRequest", () => {
  const loopback = { remoteAddress: "127.0.0.1" } as const;

  it("waives a genuine top-level navigation from a local browser", () => {
    expect(
      isWaivableLocalRequest(
        fakeRequest({
          ...loopback,
          headers: {
            host: "127.0.0.1:13773",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          },
        }),
      ),
    ).toBe(true);
  });

  it("waives a non-browser caller, which sends no Sec-Fetch-* at all", () => {
    // curl or an editor can already read the file directly with the user's own
    // permissions, which is the premise the waiver rests on.
    expect(isWaivableLocalRequest(fakeRequest({ ...loopback, headers: { host: "localhost:13773" } })))
      .toBe(true);
  });

  it("refuses a cross-origin fetch from a page the user is merely visiting", () => {
    // The disclosure path: any site could read any file, because this server answers
    // with `access-control-allow-origin: *`.
    expect(
      isWaivableLocalRequest(
        fakeRequest({
          ...loopback,
          headers: {
            host: "127.0.0.1:13773",
            origin: "https://evil.example",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
          },
        }),
      ),
    ).toBe(false);
  });

  it("refuses a no-cors fetch and a subresource load", () => {
    for (const headers of [
      { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "empty" },
      { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
    ]) {
      expect(
        isWaivableLocalRequest(fakeRequest({ ...loopback, headers: { host: "localhost", ...headers } })),
      ).toBe(false);
    }
  });

  it("refuses a DNS-rebound request, whose peer is loopback but whose Host is not", () => {
    expect(
      isWaivableLocalRequest(
        fakeRequest({
          ...loopback,
          headers: {
            host: "evil.example",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          },
        }),
      ),
    ).toBe(false);
  });

  it("still refuses anything that is not a loopback peer", () => {
    expect(
      isWaivableLocalRequest(
        fakeRequest({
          remoteAddress: "192.168.1.20",
          headers: { host: "127.0.0.1", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
        }),
      ),
    ).toBe(false);
  });
});
