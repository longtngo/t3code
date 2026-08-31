import { describe, expect, it } from "vite-plus/test";

import {
  collectKnownAbsolutePaths,
  findChatFilePathMentions,
  resolveChatFilePathMention,
} from "./chatFilePathLinks";

const CWD = "/Users/dev/project";

describe("resolveChatFilePathMention", () => {
  it("passes an absolute path through unchanged", () => {
    expect(resolveChatFilePathMention("/Users/dev/project/src/main.ts", { cwd: CWD })).toBe(
      "/Users/dev/project/src/main.ts",
    );
  });

  it("keeps a line/column suffix so the viewer can jump to it", () => {
    expect(resolveChatFilePathMention("/Users/dev/project/src/main.ts:42:7", { cwd: CWD })).toBe(
      "/Users/dev/project/src/main.ts:42:7",
    );
  });

  it("expands a home-relative path using the home inferred from cwd", () => {
    expect(resolveChatFilePathMention("~/notes/todo.md", { cwd: CWD })).toBe(
      "/Users/dev/notes/todo.md",
    );
  });

  it("resolves a cwd-relative path that carries a separator", () => {
    expect(resolveChatFilePathMention("src/lib/util.ts", { cwd: CWD })).toBe(
      "/Users/dev/project/src/lib/util.ts",
    );
  });

  it("resolves an explicitly relative path", () => {
    expect(resolveChatFilePathMention("./src/main.ts", { cwd: CWD })).toBe(
      "/Users/dev/project/src/main.ts",
    );
  });

  it("resolves a bare filename from a path seen elsewhere in context", () => {
    expect(
      resolveChatFilePathMention("util.ts", {
        cwd: CWD,
        knownPaths: ["/Users/dev/project/src/lib/util.ts"],
      }),
    ).toBe("/Users/dev/project/src/lib/util.ts");
  });

  it("carries a line suffix onto a context-resolved bare filename", () => {
    expect(
      resolveChatFilePathMention("util.ts:12", {
        cwd: CWD,
        knownPaths: ["/Users/dev/project/src/lib/util.ts"],
      }),
    ).toBe("/Users/dev/project/src/lib/util.ts:12");
  });

  it("refuses an ambiguous bare filename rather than guessing", () => {
    expect(
      resolveChatFilePathMention("util.ts", {
        cwd: CWD,
        knownPaths: ["/Users/dev/project/src/lib/util.ts", "/Users/dev/project/test/util.ts"],
      }),
    ).toBeNull();
  });

  it("refuses a bare filename with no context rather than inventing a cwd-relative path", () => {
    // Joining cwd here would produce /Users/dev/project/util.ts, which probably
    // does not exist — a dead link is worse than plain text.
    expect(resolveChatFilePathMention("util.ts", { cwd: CWD })).toBeNull();
  });

  it("does not resolve a relative path without a cwd", () => {
    expect(resolveChatFilePathMention("src/lib/util.ts", {})).toBeNull();
    expect(resolveChatFilePathMention("/Users/dev/project/a.ts", {})).toBe(
      "/Users/dev/project/a.ts",
    );
  });

  it("links a folder path, which has no extension to pass the allow-list", () => {
    // The reported defect: the same folder chipped inside backticks and stayed
    // dead text in prose.
    expect(resolveChatFilePathMention("/Users/dev/reports/runbooks", { cwd: CWD })).toBe(
      "/Users/dev/reports/runbooks",
    );
    expect(resolveChatFilePathMention("/Users/dev/reports/runbooks/", { cwd: CWD })).toBe(
      "/Users/dev/reports/runbooks/",
    );
    // Not absolute by isAbsoluteFilePath, so it needs its own clause.
    expect(resolveChatFilePathMention("~/.claude-personal/skills", { cwd: CWD })).toBe(
      "/Users/dev/.claude-personal/skills",
    );
  });

  it("holds the line against the shapes the root list exists to exclude", () => {
    // Measured false-positive classes. SPA routes look exactly like absolute
    // paths, which is why the root list omits app-route-shaped prefixes.
    expect(resolveChatFilePathMention("/chat/thread-123", { cwd: CWD })).toBeNull();
    expect(resolveChatFilePathMention("/api/v1.2", { cwd: CWD })).toBeNull();
    // Relative shapes keep the extension gate: this branch has a different
    // false-positive budget, and these are ordinary prose and git refs.
    expect(resolveChatFilePathMention("origin/main", { cwd: CWD })).toBeNull();
    expect(resolveChatFilePathMention("and/or", { cwd: CWD })).toBeNull();
    // An escaped-backslash sequence in prose is not a UNC path. The UNC clause
    // was dropped after measuring 0 true positives against it.
    expect(resolveChatFilePathMention("\\\\nline2", { cwd: CWD })).toBeNull();
  });

  it("only links file kinds the viewer can render", () => {
    // Extension-less paths and secrets are deliberately excluded — the curated
    // allow-list in lib/codeFileTypes.ts is the gate.
    // /etc/hosts and .env now chip: they are real absolute paths under known
    // roots, and the widened gate deliberately admits those. The read RPC has no
    // sandbox and the address bar already accepts any path, so this exposes
    // nothing new — it removes a formatting requirement, not a check.
    expect(resolveChatFilePathMention("/etc/hosts", { cwd: CWD })).toBe("/etc/hosts");
    expect(resolveChatFilePathMention("/Users/dev/project/.env", { cwd: CWD })).toBe(
      "/Users/dev/project/.env",
    );
    // Video is a viewable kind now, so a bare video path chips like any other
    // document. Other media stays excluded — the viewer has nothing to show for it.
    expect(resolveChatFilePathMention("/Users/dev/project/clip.mp4", { cwd: CWD })).toBe(
      "/Users/dev/project/clip.mp4",
    );
    // Superseded by the widened root gate: an absolute path under a known root
    // chips whatever its extension, so .avi now gets a chip that opens an error.
    // That is the measured ~5.6% class the design accepts by name. The extension
    // allow-list still governs RELATIVE paths, which is where it earns its keep.
    expect(resolveChatFilePathMention("clip.avi", { cwd: CWD })).toBeNull();
    expect(resolveChatFilePathMention("media/clip.avi", { cwd: CWD })).toBeNull();
    expect(resolveChatFilePathMention("/Users/dev/project/notes.md", { cwd: CWD })).toBe(
      "/Users/dev/project/notes.md",
    );
    expect(resolveChatFilePathMention("/Users/dev/project/main.py", { cwd: CWD })).toBe(
      "/Users/dev/project/main.py",
    );
  });

  it("links images, which the viewer now renders instead of failing to read", () => {
    // Previously excluded as "media". Chipping them is what makes an image
    // clickable in chat at all; before this the path was inert prose.
    expect(resolveChatFilePathMention("/Users/dev/project/logo.png", { cwd: CWD })).toBe(
      "/Users/dev/project/logo.png",
    );
    expect(resolveChatFilePathMention("/Users/dev/project/shot.jpeg", { cwd: CWD })).toBe(
      "/Users/dev/project/shot.jpeg",
    );
  });

  it("does not chip prose that merely looks path-shaped", () => {
    // The exact false positives that sank the auto-chip-any-extension approach.
    expect(resolveChatFilePathMention("example.com", { cwd: CWD })).toBeNull();
    expect(resolveChatFilePathMention("v1.2", { cwd: CWD })).toBeNull();
    expect(resolveChatFilePathMention("Node.js", { cwd: CWD })).toBeNull();
  });

  it("ignores urls", () => {
    expect(resolveChatFilePathMention("https://example.com/a/b.ts", { cwd: CWD })).toBeNull();
  });

  it("treats a duplicate known path as unambiguous", () => {
    expect(
      resolveChatFilePathMention("util.ts", {
        cwd: CWD,
        knownPaths: ["/Users/dev/project/src/util.ts", "/Users/dev/project/src/util.ts"],
      }),
    ).toBe("/Users/dev/project/src/util.ts");
  });
});

describe("collectKnownAbsolutePaths", () => {
  it("harvests absolute paths from surrounding prose", () => {
    const text = [
      "I updated /Users/dev/project/src/lib/util.ts and it now compiles.",
      "See also `/Users/dev/project/README.md`.",
    ].join("\n");
    expect(collectKnownAbsolutePaths(text)).toEqual([
      "/Users/dev/project/src/lib/util.ts",
      "/Users/dev/project/README.md",
    ]);
  });

  it("strips a line/column suffix so basenames match", () => {
    expect(
      collectKnownAbsolutePaths("see /Users/dev/project/src/main.ts:10:3 for details"),
    ).toEqual(["/Users/dev/project/src/main.ts"]);
  });

  it("ignores relative paths", () => {
    expect(collectKnownAbsolutePaths("edit src/main.ts please")).toEqual([]);
  });
});

describe("findChatFilePathMentions", () => {
  it("finds an absolute path inside prose with its offsets", () => {
    const text = "Look at /Users/dev/project/src/main.ts now";
    const mentions = findChatFilePathMentions(text, { cwd: CWD });
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.raw).toBe("/Users/dev/project/src/main.ts");
    expect(mentions[0]?.targetPath).toBe("/Users/dev/project/src/main.ts");
    expect(text.slice(mentions[0]!.start, mentions[0]!.end)).toBe("/Users/dev/project/src/main.ts");
  });

  it("does not include a trailing sentence period in the path", () => {
    const mentions = findChatFilePathMentions("Edited /Users/dev/project/a.ts.", { cwd: CWD });
    expect(mentions[0]?.raw).toBe("/Users/dev/project/a.ts");
  });

  it("skips mentions that cannot be resolved", () => {
    expect(findChatFilePathMentions("just some prose about things", { cwd: CWD })).toEqual([]);
    expect(findChatFilePathMentions("open util.ts", { cwd: CWD })).toEqual([]);
  });

  it("resolves a bare filename using an absolute path from the same text", () => {
    const text = "I changed /Users/dev/project/src/lib/util.ts. Now util.ts exports a helper.";
    const mentions = findChatFilePathMentions(text, {
      cwd: CWD,
      knownPaths: collectKnownAbsolutePaths(text),
    });
    expect(mentions.map((m) => m.targetPath)).toEqual([
      "/Users/dev/project/src/lib/util.ts",
      "/Users/dev/project/src/lib/util.ts",
    ]);
    expect(mentions[1]?.raw).toBe("util.ts");
  });

  it("returns mentions in document order and never overlapping", () => {
    const text = "/Users/dev/a.ts then /Users/dev/b.ts";
    const mentions = findChatFilePathMentions(text, { cwd: CWD });
    expect(mentions.map((m) => m.raw)).toEqual(["/Users/dev/a.ts", "/Users/dev/b.ts"]);
    expect(mentions[0]!.end).toBeLessThanOrEqual(mentions[1]!.start);
  });
});
