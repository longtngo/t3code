import { describe, expect, it } from "vite-plus/test";

import {
  VIEWER_ASSET_TOKEN_TTL_MS,
  isWithinGrantedDirectory,
  mintViewerAssetToken,
  parseViewerAssetSuffix,
  resetViewerAssetTokens,
  resolveViewerAssetGrant,
} from "./viewerAssetTokens.ts";

const NOW = 1_700_000_000_000;

describe("mint/resolve", () => {
  it("resolves a freshly minted token to its directory", () => {
    resetViewerAssetTokens();
    const token = mintViewerAssetToken("/Users/me/proto", NOW);
    expect(resolveViewerAssetGrant(token, NOW)).toBe("/Users/me/proto");
  });

  it("mints unguessable, distinct tokens", () => {
    resetViewerAssetTokens();
    const a = mintViewerAssetToken("/a", NOW);
    const b = mintViewerAssetToken("/a", NOW);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-f0-9]{32}$/);
  });

  it("expires a token once its ttl has passed", () => {
    resetViewerAssetTokens();
    const token = mintViewerAssetToken("/a", NOW);
    expect(resolveViewerAssetGrant(token, NOW + VIEWER_ASSET_TOKEN_TTL_MS - 1)).toBe("/a");
    expect(resolveViewerAssetGrant(token, NOW + VIEWER_ASSET_TOKEN_TTL_MS)).toBeNull();
  });

  it("returns null for a token it never issued", () => {
    resetViewerAssetTokens();
    expect(resolveViewerAssetGrant("deadbeef", NOW)).toBeNull();
  });
});

describe("parseViewerAssetSuffix", () => {
  it("splits the token from the absolute path", () => {
    expect(parseViewerAssetSuffix("/abc123/Users/me/proto/index.html")).toEqual({
      token: "abc123",
      absolutePath: "/Users/me/proto/index.html",
    });
  });

  it("decodes percent-encoded segments", () => {
    expect(parseViewerAssetSuffix("/abc123/Users/me/my%20proto/app.js")?.absolutePath).toBe(
      "/Users/me/my proto/app.js",
    );
  });

  it("rejects a malformed suffix, a non-hex token, and a bad encoding", () => {
    expect(parseViewerAssetSuffix("/abc123")).toBeNull();
    expect(parseViewerAssetSuffix("/")).toBeNull();
    expect(parseViewerAssetSuffix("")).toBeNull();
    // A non-hex token can never have been minted, so reject before any filesystem work.
    expect(parseViewerAssetSuffix("/../../etc/passwd")).toBeNull();
    expect(parseViewerAssetSuffix("/abc123/Users/%E0%A4%A.js")).toBeNull();
  });

  it("rejects a NUL byte, which makes Node's path APIs throw rather than fail", () => {
    expect(parseViewerAssetSuffix("/abc123/Users/me/a%00.js")).toBeNull();
  });
});

describe("isWithinGrantedDirectory", () => {
  it("accepts the directory itself and anything beneath it", () => {
    expect(isWithinGrantedDirectory("/Users/me/proto", "/Users/me/proto")).toBe(true);
    expect(isWithinGrantedDirectory("/Users/me/proto", "/Users/me/proto/app.js")).toBe(true);
    expect(isWithinGrantedDirectory("/Users/me/proto", "/Users/me/proto/assets/deep/x.css")).toBe(
      true,
    );
  });

  it("refuses a sibling whose name merely shares the prefix", () => {
    // Without the trailing separator, "/a/proto-secrets" would count as inside "/a/proto".
    expect(isWithinGrantedDirectory("/a/proto", "/a/proto-secrets/x.js")).toBe(false);
    expect(isWithinGrantedDirectory("/a/proto", "/a/protos/x.js")).toBe(false);
  });

  it("refuses a path outside the grant", () => {
    expect(isWithinGrantedDirectory("/Users/me/proto", "/Users/me/.ssh/id_rsa")).toBe(false);
    expect(isWithinGrantedDirectory("/Users/me/proto", "/etc/passwd")).toBe(false);
  });

  it("tolerates a granted directory that already ends in a separator", () => {
    expect(isWithinGrantedDirectory("/a/proto/", "/a/proto/x.js")).toBe(true);
    expect(isWithinGrantedDirectory("/a/proto/", "/a/protos/x.js")).toBe(false);
  });
});
