// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { expect, it } from "@effect/vitest";
import {
  AUDIO_CONTENT_TYPE_BY_EXTENSION,
  VIDEO_CONTENT_TYPE_BY_EXTENSION,
} from "@t3tools/shared/filePreview";
import { Effect, Logger } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import {
  assetResponseByteCap,
  assetResponseHeaders,
  assetVideoRangeResponse,
  classifyViewerAssetPath,
  classifyViewerPath,
  viewerMediaContentType,
  VIEWER_ASSET_CONTENT_TYPES,
  downloadContentDisposition,
  isGrantableViewerAssetDirectory,
  resolveViewerAssetGrantDecision,
  isLocalLoopbackRequest,
  isLoopbackHostname,
  isWaivableLocalRequest,
  logRouteRefusals,
  resolveDevRedirectUrl,
} from "./http.ts";

/**
 * Retargeted from upstream #8919's `assetFileResponse` tests. That competing Range
 * implementation was dropped in favour of the fork's (which also serves audio,
 * clamps each response, and caps the rangeless branch), but its EDGE CASES still
 * apply to the parser that replaced it, and several were uncovered here: a suffix
 * larger than the file, an end past the file, an inverted range, `bytes=-0`, and
 * an empty file.
 */
describe("asset byte ranges (retargeted from upstream #8919)", () => {
  const SIZE = 10;
  const range = (header: string | undefined) => assetVideoRangeResponse(header, SIZE);

  it("serves the requested window, clamping what runs past the file", () => {
    expect(range("bytes=0-1")).toMatchObject({ status: 206, offset: 0, bytesToRead: 2 });
    expect(range("bytes=4-")).toMatchObject({ status: 206, offset: 4, bytesToRead: 6 });
    // Suffix: the last 3 bytes, so the offset is computed from the end.
    expect(range("bytes=-3")).toMatchObject({ status: 206, offset: 7, bytesToRead: 3 });
    // A suffix larger than the file is the whole file, not a negative offset.
    expect(range("bytes=-999999999999999999999999")).toMatchObject({
      status: 206,
      offset: 0,
      bytesToRead: 10,
    });
    // An end past the file clamps to the last byte rather than over-reading.
    expect(range("bytes=8-999999999999999999999999")).toMatchObject({
      status: 206,
      offset: 8,
      bytesToRead: 2,
    });
  });

  it("falls back to the full representation for a header it cannot use", () => {
    // RFC 9110 lets a server answer an unusable Range with the full file. An
    // inverted range (`bytes=8-2`) is in this class, not the 416 class.
    for (const header of [
      undefined,
      "items=0-1",
      "bytes=0-1,4-5",
      "bytes=8-2",
      "bytes=-",
      "bytes=bad",
    ]) {
      expect(range(header).status).toBe(200);
    }
  });

  it("refuses a range that lies outside the file", () => {
    for (const header of ["bytes=10-", "bytes=-0", "bytes=999999999999999999999999-"]) {
      expect(range(header)).toMatchObject({ status: 416 });
    }
  });

  it("refuses any range against an empty file", () => {
    expect(assetVideoRangeResponse("bytes=0-1", 0)).toMatchObject({ status: 416 });
  });
});

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

  it("classifies video, which streams bytes rather than being read as text", () => {
    expect(classifyViewerPath("/Users/me/demo.mp4")).toEqual({
      absolutePath: "/Users/me/demo.mp4",
      kind: "video",
    });
    expect(classifyViewerPath("/Users/me/clip.MOV")?.kind).toBe("video");
    expect(classifyViewerPath("/Users/me/clip.webm")?.kind).toBe("video");
    expect(classifyViewerPath("/Users/me/clip.m4v")?.kind).toBe("video");
    expect(classifyViewerPath("/Users/me/clip.ogv")?.kind).toBe("video");
  });

  it("classifies audio, which takes the same byte-and-Range branch as video", () => {
    // Same NUL-byte problem as video, and the same need for Range: seeking a
    // podcast-length .mp3 fails exactly the way seeking a video does without it.
    expect(classifyViewerPath("/Users/me/talk.mp3")).toEqual({
      absolutePath: "/Users/me/talk.mp3",
      kind: "audio",
    });
    for (const path of [
      "/a/b.WAV",
      "/a/b.m4a",
      "/a/b.flac",
      "/a/b.aac",
      "/a/b.ogg",
      "/a/b.oga",
      "/a/b.opus",
    ]) {
      expect(classifyViewerPath(path)?.kind).toBe("audio");
    }
  });

  it("still rejects media it cannot serve, so the 400 is not blanket-removed", () => {
    expect(classifyViewerPath("/Users/me/clip.avi")).toBeNull();
    expect(classifyViewerPath("/Users/me/clip.mkv")).toBeNull();
    expect(classifyViewerPath("/Users/me/archive.zip")).toBeNull();
  });

  it("rejects unsupported, secret, and extension-less files", () => {
    // `video.mp4` used to be asserted null here; video is a served kind of its own
    // now, and the case it stood for lives in the two assertions above.
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

  it("serves inline videos with their declared mime type", () => {
    expect(
      assetResponseHeaders("/attachments/demo.bin", {
        mimeType: 'video/mp4; codecs="avc1.42E01E"',
      }),
    ).toEqual({
      "Cache-Control": "private, max-age=3600",
      "Content-Type": "video/mp4",
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

describe("viewerMediaContentType", () => {
  it("pins a type for every video extension the classifier admits", () => {
    expect(viewerMediaContentType("/Users/me/demo.mp4")).toEqual({ "Content-Type": "video/mp4" });
    expect(viewerMediaContentType("/Users/me/demo.WEBM")).toEqual({ "Content-Type": "video/webm" });
    expect(viewerMediaContentType("/Users/me/clip.mov")).toEqual({
      "Content-Type": "video/quicktime",
    });
  });

  // The 416 and 413 bodies are text. Spreading a video Content-Type onto them
  // labels "Requested range not satisfiable" as video/mp4, which is why this is a
  // separate object rather than part of the shared video header block.
  it("is empty for a path it cannot vouch for, so nothing is asserted by default", () => {
    expect(viewerMediaContentType("/Users/me/clip.avi")).toEqual({});
    expect(viewerMediaContentType("/Users/me/Makefile")).toEqual({});
  });
});

describe("assetVideoRangeResponse", () => {
  it("advertises Range on a rangeless response rather than a bare 200", () => {
    expect(assetVideoRangeResponse(undefined, 3_014_000)).toEqual({
      status: 200,
      headers: { "Accept-Ranges": "bytes" },
    });
  });

  // The open-ended range is what a media element actually sends first, so this is
  // the path every <video> takes, not an edge case.
  it("answers an open-ended range with a 206 clamped to the 8 MiB per-response bound", () => {
    expect(assetVideoRangeResponse("bytes=0-", 100 * 1024 * 1024)).toEqual({
      status: 206,
      offset: 0,
      bytesToRead: 8 * 1024 * 1024,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes 0-${8 * 1024 * 1024 - 1}/${100 * 1024 * 1024}`,
      },
    });
  });

  it("serves a small file whole and reports the real end byte", () => {
    expect(assetVideoRangeResponse("bytes=0-", 1024)).toEqual({
      status: 206,
      offset: 0,
      bytesToRead: 1024,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": "bytes 0-1023/1024",
      },
    });
  });

  it("returns 416 with a size-only Content-Range for a start past the end", () => {
    expect(assetVideoRangeResponse("bytes=5000-", 1024)).toEqual({
      status: 416,
      headers: { "Accept-Ranges": "bytes", "Content-Range": "bytes */1024" },
    });
  });

  // RFC 9110 lets a server answer an unusable Range with the full representation,
  // which is what the parser's `undefined` means here.
  it("falls back to the full response for a header it cannot use", () => {
    expect(assetVideoRangeResponse("bytes=abc-def", 1024).status).toBe(200);
    expect(assetVideoRangeResponse("bytes=0-1,5-6", 1024).status).toBe(200);
  });

  // The cap bounds the ONE branch a range cannot bound. Both sides are asserted
  // because a cap applied to the ranged branch too would silently break seeking
  // in a large file, which is the case Range exists for.
  it("refuses a rangeless response past the size cap, and only that branch", () => {
    const overCap = 2 * 1024 * 1024 * 1024 + 1;
    expect(assetVideoRangeResponse(undefined, overCap)).toEqual({ status: 413 });
    expect(assetVideoRangeResponse(undefined, 2 * 1024 * 1024 * 1024).status).toBe(200);
    // A header the parser cannot use degrades to the full response, so it is the
    // rangeless branch and must be capped with it.
    expect(assetVideoRangeResponse("bytes=abc-def", overCap)).toEqual({ status: 413 });
    // A real range over the same file still streams its clamped window.
    expect(assetVideoRangeResponse("bytes=0-", overCap)).toEqual({
      status: 206,
      offset: 0,
      bytesToRead: 8 * 1024 * 1024,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes 0-${8 * 1024 * 1024 - 1}/${overCap}`,
      },
    });
  });
});

describe("viewerMediaContentType", () => {
  // The type must reach the byte responses and NOT the 416/413 ones, whose bodies
  // are text: spreading it there labels "Requested range not satisfiable" as an
  // audio file. Same split the video path already had.
  it("pins a type for both media families", () => {
    expect(viewerMediaContentType("/a/b.mp4")).toEqual({ "Content-Type": "video/mp4" });
    expect(viewerMediaContentType("/a/b.mp3")).toEqual({ "Content-Type": "audio/mpeg" });
    // Containers, not extensions: .m4a is MP4 and .opus is Ogg, and the decoders
    // key on that rather than on the suffix.
    expect(viewerMediaContentType("/a/b.m4a")).toEqual({ "Content-Type": "audio/mp4" });
    expect(viewerMediaContentType("/a/b.opus")).toEqual({ "Content-Type": "audio/ogg" });
    expect(viewerMediaContentType("/a/b.M4V")).toEqual({ "Content-Type": "video/mp4" });
  });

  it("stays empty for anything neither map carries", () => {
    // An empty object leaves the platform's own Mime lookup in place rather than
    // asserting a type this route cannot vouch for.
    expect(viewerMediaContentType("/a/b.mkv")).toEqual({});
    expect(viewerMediaContentType("/a/b.txt")).toEqual({});
  });
});

describe("viewer asset content types", () => {
  // The allow-list stays narrower than what the viewer plays on purpose, but
  // where it names the same extension it must serve the same type: one file
  // arriving as two types on two routes is the `.m4v` class of bug review already
  // caught once.
  it("agrees with the shared media tables wherever they overlap", () => {
    let overlapping = 0;
    for (const [extension, contentType] of Object.entries(VIEWER_ASSET_CONTENT_TYPES)) {
      const shared =
        VIDEO_CONTENT_TYPE_BY_EXTENSION[extension] ?? AUDIO_CONTENT_TYPE_BY_EXTENSION[extension];
      if (shared === undefined) continue;
      overlapping += 1;
      expect(contentType).toBe(shared);
    }
    // Without this the loop passes vacuously if the overlap ever drops to zero.
    expect(overlapping).toBeGreaterThan(0);
  });
});

describe("assetResponseByteCap", () => {
  // The policy, not the arithmetic: which kinds get an unbounded response bounded.
  it("caps images at the value /viewer already uses", () => {
    expect(assetResponseByteCap("/w/logo.png")).toBe(64 * 1024 * 1024);
    for (const path of [
      "/w/a.jpg",
      "/w/a.JPEG",
      "/w/a.gif",
      "/w/a.webp",
      "/w/a.avif",
      "/w/a.ico",
    ]) {
      expect(assetResponseByteCap(path)).toBe(64 * 1024 * 1024);
    }
  });

  it("leaves the kinds /viewer never served uncapped, so no new refusal appears", () => {
    // A PDF past 64 MiB is ordinary. Capping it would be a regression, not a fix.
    expect(assetResponseByteCap("/w/report.pdf")).toBeNull();
    expect(assetResponseByteCap("/w/report.html")).toBeNull();
    expect(assetResponseByteCap("/w/report.htm")).toBeNull();
  });

  it("leaves video to the Range branch, which bounds it per response", () => {
    expect(assetResponseByteCap("/w/demo.mp4")).toBeNull();
    expect(assetResponseByteCap("/w/demo.webm")).toBeNull();
  });
});

describe("viewer route auth ordering", () => {
  // Guards the invariant, not the implementation: everything reachable before
  // `authenticateRawRouteWithScope` must be pure string work over the URL. A stat
  // ahead of it turns 404-vs-416 into an existence oracle and `Content-Range:
  // bytes */N` into a size oracle, for a caller with no credentials at all.
  it("classifies a video path without touching the filesystem", () => {
    const classified = classifyViewerPath("/definitely/does/not/exist/anywhere.mp4");
    expect(classified).toEqual({
      absolutePath: "/definitely/does/not/exist/anywhere.mp4",
      kind: "video",
    });
  });

  // Pins the ORDER, not just the condition. A mutation run showed the waiver
  // assertion below survives both "delete the auth call entirely" and "move the
  // stat ahead of it" — the two failures whose whole cost is an unauthenticated
  // existence and size oracle. This asserts the video branch's first filesystem
  // call comes after the auth call in the route body.
  it("authenticates before the video branch touches the filesystem", () => {
    const source = NodeFS.readFileSync(new URL("./http.ts", import.meta.url), "utf8");
    const routeStart = source.indexOf("export const viewerRouteLayer");
    expect(routeStart).toBeGreaterThan(-1);
    const route = source.slice(routeStart);
    const authIndex = route.indexOf("authenticateRawRouteWithScope(AuthOrchestrationReadScope)");
    const videoBranchIndex = route.indexOf('if (kind === "video" || kind === "audio")');
    expect(authIndex).toBeGreaterThan(-1);
    expect(videoBranchIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeLessThan(videoBranchIndex);
    // And the branch really is the thing that stats, so the ordering above is
    // about the call that matters rather than an unrelated landmark.
    expect(route.slice(videoBranchIndex)).toContain("fileSystem.stat(absolutePath)");
  });

  it("never waives authentication for any byte kind", () => {
    const source = NodeFS.readFileSync(new URL("./http.ts", import.meta.url), "utf8");
    // Anchored on the waiver call itself rather than on the first kind in the
    // condition, which is what broke when audio was added: the condition wrapped
    // and `if (kind === "image"` started matching the image BRANCH instead.
    const waiverIndex = source.indexOf("!isWaivableLocalRequest(request)");
    expect(waiverIndex).toBeGreaterThan(-1);
    const conditionStart = source.lastIndexOf("if (", waiverIndex);
    expect(conditionStart).toBeGreaterThan(-1);
    const condition = source.slice(conditionStart, waiverIndex);
    // Every kind served as raw bytes must be excluded from the local-navigation
    // waiver; a kind missing here is served to an unauthenticated local caller.
    for (const kind of ["image", "video", "audio"]) {
      expect(condition).toContain(`kind === "${kind}"`);
    }
  });
});

describe("logRouteRefusals", () => {
  const captureLogs = () => {
    const logs: Array<{ readonly message: unknown }> = [];
    const logger = Logger.make(({ message }) => {
      logs.push({ message });
    });
    return { logs, layer: Logger.layer([logger], { mergeWithExisting: false }) };
  };

  const run = (status: number) =>
    Effect.gen(function* () {
      const capture = captureLogs();
      yield* Effect.succeed(HttpServerResponse.text("body", { status })).pipe(
        logRouteRefusals("/viewer"),
        Effect.provideService(HttpServerRequest.HttpServerRequest, {
          url: "/viewer/Users/me/clip.mp4",
        } as HttpServerRequest.HttpServerRequest),
        Effect.provide(capture.layer),
      );
      return capture.logs;
    });

  // Refusals are what is invisible today; a per-request line on a route that
  // streams a 561 MB file in 8 MiB windows would be its own problem.
  it.effect("logs every refusal status the byte routes answer with", () =>
    Effect.gen(function* () {
      for (const status of [400, 404, 413, 416, 500]) {
        const logs = yield* run(status);
        expect(logs).toHaveLength(1);
        expect(String(logs[0]?.message)).toContain("refused");
      }
    }),
  );

  it.effect("stays silent on every success, including a 206 range", () =>
    Effect.gen(function* () {
      for (const status of [200, 206, 304]) {
        expect(yield* run(status)).toEqual([]);
      }
    }),
  );

  // The unit tests above cover the wrapper; nothing in them notices if a route
  // stops using it. This asserts each byte-serving route is actually wrapped,
  // which is the seam the whole change lives on.
  it("wraps every byte-serving route, and leaves the static route alone", () => {
    const source = NodeFS.readFileSync(new URL("./http.ts", import.meta.url), "utf8");
    for (const [layer, prefix] of [
      ["export const assetRouteLayer", "ASSET_ROUTE_PREFIX"],
      ["export const viewerRouteLayer", "VIEWER_ROUTE_PREFIX"],
      ["export const viewerAssetRouteLayer", "VIEWER_ASSET_ROUTE_PREFIX"],
    ] as const) {
      const start = source.indexOf(layer);
      expect(start).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf("export const", start + layer.length));
      expect(body).toContain(`logRouteRefusals(${prefix})`);
    }
    // The static route 404s constantly in normal operation — wrapping it would
    // turn ordinary traffic into a warning stream.
    const staticStart = source.indexOf("export const staticAndDevRouteLayer");
    expect(staticStart).toBeGreaterThan(-1);
    expect(source.slice(staticStart)).not.toContain("logRouteRefusals");
  });
});
