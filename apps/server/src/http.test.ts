import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import {
  assetResponseHeaders,
  classifyViewerAssetPath,
  classifyViewerPath,
  downloadContentDisposition,
  isGrantableViewerAssetDirectory,
  resolveViewerAssetGrantDecision,
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

  it("classifies image extensions, which are served as bytes", () => {
    // Previously null, which is why opening one failed with "Failed to read '<path>'":
    // the route rejected it, and the RPC fell into the text reader's binary guard.
    expect(classifyViewerPath("/Users/me/photo.png")).toEqual({
      absolutePath: "/Users/me/photo.png",
      kind: "image",
    });
    for (const path of [
      "/a/b.jpg",
      "/a/b.JPEG",
      "/a/b.gif",
      "/a/b.webp",
      "/a/b.avif",
      "/a/b.ico",
    ]) {
      expect(classifyViewerPath(path)?.kind).toBe("image");
    }
    // SVG is an image here, but the route serves it under the strict asset CSP
    // rather than the html one, since a top-level .svg navigation can run script.
    expect(classifyViewerPath("/a/logo.svg")?.kind).toBe("image");
  });

  it("rejects unsupported, secret, and extension-less files", () => {
    expect(classifyViewerPath("/Users/me/video.mp4")).toBeNull();
    expect(classifyViewerPath("/Users/me/secret.env")).toBeNull();
    expect(classifyViewerPath("/Users/me/Makefile")).toBeNull();
    // A dot in a parent directory is not an extension of the final segment.
    expect(classifyViewerPath("/Users/me.dir/report")).toBeNull();
  });

  it("rejects a NUL byte, which makes Node's path APIs throw rather than fail", () => {
    // The text path only absorbed this by accident (realpath rejected it into a
    // 404); the byte path has no such accident to rely on.
    expect(classifyViewerPath("/Users/me/report%00.md")).toBeNull();
    expect(classifyViewerPath("/Users/me/photo%00.png")).toBeNull();
  });
});

describe("isGrantableViewerAssetDirectory", () => {
  // Identities, not paths. Every earlier version of this guard compared strings and
  // was defeated by another spelling of the same directory — case, Unicode
  // normalization, duplicate separators — until a macOS firmlink showed the premise
  // was wrong: /System/Volumes/Data/Users/me IS /Users/me, shares no prefix, and
  // survives realpath unchanged. Verified on a real machine: both report
  // dev 16777234, ino 302769.
  const root = { dev: 1, ino: 2 };
  const users = { dev: 1, ino: 10 };
  const home = { dev: 1, ino: 20 };
  const homeChain = [home, users, root];

  it("refuses home and every ancestor of it, however they are spelled", () => {
    expect(isGrantableViewerAssetDirectory(home, homeChain, false)).toBe(false);
    expect(isGrantableViewerAssetDirectory(users, homeChain, false)).toBe(false);
    expect(isGrantableViewerAssetDirectory(root, homeChain, false)).toBe(false);
    // The firmlink alias resolves to home's identity, so it is refused by the same
    // check that refuses home — no extra rule, which is the point of the rewrite.
    expect(isGrantableViewerAssetDirectory({ dev: 1, ino: 20 }, homeChain, false)).toBe(false);
  });

  it("allows a directory a prototype actually lives in", () => {
    // Inside home.
    expect(isGrantableViewerAssetDirectory({ dev: 1, ino: 21 }, homeChain, false)).toBe(true);
    // Outside home entirely (/tmp/build). A strict descendant-of-home rule would
    // have refused this; it is grantable because it is not home nor above it.
    expect(isGrantableViewerAssetDirectory({ dev: 1, ino: 99 }, homeChain, false)).toBe(true);
    // Same inode number on a different device is a different directory.
    expect(isGrantableViewerAssetDirectory({ dev: 2, ino: 20 }, homeChain, false)).toBe(true);
  });
});

describe("classifyViewerAssetPath", () => {
  const grant = "/Users/me/proto";

  it("serves the asset kinds a document legitimately loads", () => {
    expect(classifyViewerAssetPath(grant, `${grant}/app.js`)?.contentType).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(classifyViewerAssetPath(grant, `${grant}/assets/site.css`)?.contentType).toBe(
      "text/css; charset=utf-8",
    );
    expect(classifyViewerAssetPath(grant, `${grant}/img/logo.png`)?.contentType).toBe("image/png");
    expect(classifyViewerAssetPath(grant, `${grant}/page.html`)).toEqual({
      contentType: "text/html; charset=utf-8",
      isDocument: true,
    });
  });

  it("refuses the kinds a document has no legitimate use for", () => {
    // The grant is a whole SUBTREE and the document that reads it runs script under
    // a sandbox-only CSP that restricts no fetch destination. An unlisted extension
    // used to fall back to text/plain, so every one of these was readable and
    // exfiltratable by a hostile document sitting at the top of the tree.
    expect(classifyViewerAssetPath(grant, `${grant}/notes.txt`)).toBeNull();
    expect(classifyViewerAssetPath(grant, `${grant}/secret.env`)).toBeNull();
    expect(classifyViewerAssetPath(grant, `${grant}/id_rsa`)).toBeNull();
    expect(classifyViewerAssetPath(grant, `${grant}/credentials.pem`)).toBeNull();
    // No extension at all: `lastIndexOf(".")` must not read a dot from a parent
    // segment, and must not slice the last character off a bare filename.
    expect(classifyViewerAssetPath(grant, `${grant}/Makefile`)).toBeNull();
    expect(classifyViewerAssetPath("/Users/me.dir", "/Users/me.dir/report")).toBeNull();
  });

  it("refuses dot segments below the grant, which is where credentials live", () => {
    expect(classifyViewerAssetPath("/Users/me", "/Users/me/.ssh/known_hosts.json")).toBeNull();
    expect(classifyViewerAssetPath("/Users/me", "/Users/me/.aws/config.json")).toBeNull();
    expect(classifyViewerAssetPath("/Users/me", "/Users/me/.env.json")).toBeNull();
  });

  it("still admits non-secret-looking files anywhere under the grant", () => {
    // Recording the residual, because the allow-list narrows this capability
    // rather than removing it: a `.json` outside a dot-directory is readable
    // anywhere below the grant. That is why the grant itself is bounded — see
    // isGrantableViewerAssetDirectory — and why closing it properly needs a real
    // CSP rather than a filename filter.
    expect(
      classifyViewerAssetPath("/Users/me/proto", "/Users/me/proto/deep/nested/data.json"),
    ).not.toBeNull();
  });

  it("allows dot segments in the grant itself, so a document under one still loads", () => {
    // Only the portion BELOW the grant is filtered: a prototype checked out at
    // ~/.local/share/proto must still be able to load its own assets.
    expect(
      classifyViewerAssetPath("/Users/me/.local/proto", "/Users/me/.local/proto/app.js")
        ?.contentType,
    ).toBe("text/javascript; charset=utf-8");
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
    expect(
      isWaivableLocalRequest(fakeRequest({ ...loopback, headers: { host: "localhost:13773" } })),
    ).toBe(true);
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
        isWaivableLocalRequest(
          fakeRequest({ ...loopback, headers: { host: "localhost", ...headers } }),
        ),
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

  it("refuses a cross-site top-level navigation, which is still a navigation", () => {
    // `evil.example` calling window.open on this origin satisfies both the mode and
    // dest checks; only Sec-Fetch-Site distinguishes it from the user's own tab.
    expect(
      isWaivableLocalRequest(
        fakeRequest({
          ...loopback,
          headers: {
            host: "127.0.0.1:13773",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
            "sec-fetch-site": "cross-site",
          },
        }),
      ),
    ).toBe(false);
  });

  it("waives a navigation the browser marks same-origin or none", () => {
    for (const site of ["same-origin", "none"]) {
      expect(
        isWaivableLocalRequest(
          fakeRequest({
            ...loopback,
            headers: {
              host: "127.0.0.1:13773",
              "sec-fetch-mode": "navigate",
              "sec-fetch-dest": "document",
              "sec-fetch-site": site,
            },
          }),
        ),
      ).toBe(true);
    }
  });

  it("still refuses anything that is not a loopback peer", () => {
    expect(
      isWaivableLocalRequest(
        fakeRequest({
          remoteAddress: "192.168.1.20",
          headers: {
            host: "127.0.0.1",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("assetResponseHeaders", () => {
  it("sandboxes SVG assets", () => {
    expect(assetResponseHeaders("/attachments/user-image.svg")).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders("/attachments/user-image.SVG")).toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("does not apply document policy to raster images", () => {
    expect(assetResponseHeaders("/attachments/user-image.png")).toEqual({
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("declares utf-8 for HTML assets so non-ASCII content renders correctly", () => {
    expect(assetResponseHeaders("/workspace/page.html")).toHaveProperty(
      "Content-Type",
      "text/html; charset=utf-8",
    );
    expect(assetResponseHeaders("/workspace/PAGE.HTM")).toHaveProperty(
      "Content-Type",
      "text/html; charset=utf-8",
    );
  });

  it("downloads uploaded documents without executing their content", () => {
    expect(assetResponseHeaders("/attachments/upload.html", { download: true })).toMatchObject({
      "Content-Disposition": "attachment",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "application/octet-stream",
    });
  });

  it("serves the real filename and mime type when the claims carry them", () => {
    expect(
      assetResponseHeaders("/attachments/thread-1-abc-pdf.pdf", {
        download: true,
        fileName: "Q3 report.pdf",
        mimeType: "application/pdf",
      }),
    ).toMatchObject({
      "Content-Disposition": 'attachment; filename="Q3 report.pdf"',
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "application/pdf",
    });
  });

  it("keeps renderable mime types as octet-stream downloads", () => {
    for (const mimeType of [
      "text/html",
      "text/xml",
      "image/svg+xml",
      "application/xhtml+xml",
      "application/rss+xml",
      "APPLICATION/XML",
      "IMAGE/SVG+XML",
      "application/xml-dtd",
      "application/xml-external-parsed-entity",
      "not a mime",
    ]) {
      expect(
        assetResponseHeaders("/attachments/upload.bin", { download: true, mimeType }),
      ).toHaveProperty("Content-Type", "application/octet-stream");
    }
  });

  it("preserves official Office Open XML mime types", () => {
    for (const mimeType of [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]) {
      expect(
        assetResponseHeaders("/attachments/upload.bin", { download: true, mimeType }),
      ).toHaveProperty("Content-Type", mimeType);
    }
  });
});

describe("downloadContentDisposition", () => {
  it("quotes plain names and strips quotes and control characters", () => {
    expect(downloadContentDisposition("report.pdf")).toBe('attachment; filename="report.pdf"');
    expect(downloadContentDisposition('we"ird\n.pdf')).toBe('attachment; filename="we_ird_.pdf"');
  });

  it("adds an RFC 5987 encoded name for non-ASCII filenames", () => {
    expect(downloadContentDisposition("répört.pdf")).toBe(
      `attachment; filename="r_p_rt.pdf"; filename*=UTF-8''r%C3%A9p%C3%B6rt.pdf`,
    );
    expect(downloadContentDisposition("résumé'(*).pdf")).toBe(
      `attachment; filename="r_sum_'(*).pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%27%28%2A%29.pdf`,
    );
  });

  it("does not throw on unpaired surrogates in the filename", () => {
    expect(downloadContentDisposition("bad\ud800name.pdf")).toBe(
      `attachment; filename="bad_name.pdf"; filename*=UTF-8''bad%EF%BF%BDname.pdf`,
    );
  });
});

describe("resolveViewerAssetGrantDecision", () => {
  // Drives the REAL decision — the ancestor walk, the containment probe, and the
  // null handling — over a fake filesystem that can express the thing that broke
  // it four times: one directory reachable by two unrelated paths.
  //
  // Every bypass in this guard's history was found by running it against a real
  // machine, and none by the suite, because the suite only ever exercised the
  // two-line comparison at the end. This is the shape that could have caught them.
  const dirname = (path: string) => {
    const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
    const cut = trimmed.lastIndexOf("/");
    return cut <= 0 ? "/" : trimmed.slice(0, cut);
  };
  const join = (...segments: ReadonlyArray<string>) => segments.join("/").replace(/\/+/g, "/");

  // "/" and "/Users" and home, plus an alias namespace under "/alias/data" that
  // reaches the SAME home directory — the firmlink shape.
  const tree: Record<string, { dev: number; ino: number }> = {
    "/": { dev: 1, ino: 1 },
    "/Users": { dev: 1, ino: 2 },
    "/Users/me": { dev: 1, ino: 3 },
    "/Users/me/proto": { dev: 1, ino: 4 },
    "/tmp": { dev: 1, ino: 5 },
    "/alias": { dev: 1, ino: 6 },
    "/alias/data": { dev: 1, ino: 7 },
    "/alias/data/Users": { dev: 1, ino: 2 },
    "/alias/data/Users/me": { dev: 1, ino: 3 },
    "/alias/data/Users/me/proto": { dev: 1, ino: 4 },
  };
  const decide = (directory: string) =>
    resolveViewerAssetGrantDecision({
      directory,
      homeDirectory: "/Users/me",
      identityOf: (path) => tree[path] ?? null,
      dirname,
      join,
    });

  it("refuses home, its ancestors, and their aliases", () => {
    expect(decide("/Users/me")).toBe(false);
    expect(decide("/Users")).toBe(false);
    expect(decide("/")).toBe(false);
    // The alias of home shares home's identity, so the chain catches it.
    expect(decide("/alias/data/Users/me")).toBe(false);
    expect(decide("/alias/data/Users")).toBe(false);
    // The alias ROOT has an identity of its own and appears nowhere in the chain —
    // this is the one the identity rewrite still granted, caught only by the
    // containment probe.
    expect(decide("/alias/data")).toBe(false);
  });

  it("does NOT cover an alias grandparent, which is the documented residual", () => {
    // "/alias" contains home too, but the containment probe tests one candidate —
    // join("/alias", "Users/me") — and home sits at "data/Users/me" below it, so
    // the probe misses. This is the real /System and /System/Volumes case, which
    // is judged unexploitable only because those are root-owned on a sealed
    // read-only volume. Asserted so the docstring's limitation is executable
    // rather than prose, and so widening the probe later shows up as a failure
    // here rather than passing unnoticed.
    expect(decide("/alias")).toBe(true);
  });

  it("still grants a directory a prototype lives in", () => {
    expect(decide("/Users/me/proto")).toBe(true);
    expect(decide("/alias/data/Users/me/proto")).toBe(true);
    expect(decide("/tmp")).toBe(true);
  });

  it("refuses when either side cannot be identified, rather than only the grant", () => {
    expect(decide("/does/not/exist")).toBe(false);
    expect(
      resolveViewerAssetGrantDecision({
        directory: "/Users/me/proto",
        homeDirectory: "/unreadable",
        identityOf: (path) => tree[path] ?? null,
        dirname,
        join,
      }),
    ).toBe(false);
  });
});
