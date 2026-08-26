// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FileFinder } from "@ff-labs/fff-node";
import { it, afterEach, describe, expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { vi } from "vite-plus/test";

import { FILESYSTEM_BROWSE_MAX_ENTRIES } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-entries-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn(function* (opts?: { prefix?: string; git?: boolean }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: opts?.prefix ?? "t3code-workspace-entries-",
  });
  if (opts?.git) {
    yield* git(dir, ["init"]);
  }
  return dir;
});

function writeTextFile(
  cwd: string,
  relativePath: string,
  contents = "",
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });
}

const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "WorkspaceEntries.test.git",
      command: "git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const searchWorkspaceEntries = (input: {
  cwd: string;
  query: string;
  limit: number;
  kind?: "file" | "directory";
}) =>
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    return yield* workspaceEntries.search(input);
  });

const appendSeparator = (input: string) =>
  Effect.map(HostProcessPlatform, (platform) =>
    input.endsWith("/") || input.endsWith("\\")
      ? input
      : `${input}${platform === "win32" ? "\\" : "/"}`,
  );

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceEntries", (it) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("list", () => {
    it.effect("returns the complete cached workspace index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "README.md");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.list({ cwd });

        expect(result.entries).toEqual(
          expect.arrayContaining([
            { path: "src", kind: "directory" },
            { path: "src/components", kind: "directory" },
            {
              path: "src/components/Composer.tsx",
              kind: "file",
            },
            { path: "README.md", kind: "file" },
          ]),
        );
        expect(result.entries.some((entry) => entry.path.startsWith("node_modules"))).toBe(false);
        expect(result.truncated).toBe(false);
      }),
    );
  });

  describe("search", () => {
    it.effect("returns files and directories relative to cwd", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/index.ts");
        yield* writeTextFile(cwd, "README.md");
        yield* writeTextFile(cwd, ".git/HEAD");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/components");
        expect(paths).toContain("src/components/Composer.tsx");
        expect(paths).toContain("README.md");
        expect(paths.some((entryPath) => entryPath.startsWith(".git"))).toBe(false);
        expect(paths.some((entryPath) => entryPath.startsWith("node_modules"))).toBe(false);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("filters and ranks entries by query", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-query-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/components/composePrompt.ts");
        yield* writeTextFile(cwd, "docs/composition.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "compo", limit: 5 });

        expect(result.entries.length).toBeGreaterThan(0);
        expect(result.entries.some((entry) => entry.path === "src/components")).toBe(true);
        expect(result.entries.every((entry) => entry.path.toLowerCase().includes("compo"))).toBe(
          true,
        );
      }),
    );

    it.effect("supports fuzzy subsequence queries for composer path search", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-fuzzy-query-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/components/composePrompt.ts");
        yield* writeTextFile(cwd, "docs/composition.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "cmp", limit: 10 });
        const paths = result.entries.map((entry) => entry.path);

        expect(result.entries.length).toBeGreaterThan(0);
        expect(paths).toContain("src/components");
        expect(paths).toContain("src/components/Composer.tsx");
      }),
    );

    it.effect("prioritizes exact basename matches ahead of broader path matches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-exact-ranking-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "docs/composer.tsx-notes.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "Composer.tsx", limit: 5 });

        expect(result.entries[0]?.path).toBe("src/components/Composer.tsx");
      }),
    );

    it.effect("tracks truncation without sorting every fuzzy match", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-fuzzy-limit-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/components/composePrompt.ts");
        yield* writeTextFile(cwd, "docs/composition.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "cmp", limit: 1 });

        expect(result.entries).toHaveLength(1);
        expect(result.truncated).toBe(true);
      }),
    );

    it.effect("applies the file filter before limiting search results", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-file-limit-" });
        yield* writeTextFile(cwd, "src/index.ts");
        yield* writeTextFile(cwd, "src/internal.ts");

        const result = yield* searchWorkspaceEntries({
          cwd,
          query: "src",
          limit: 1,
          kind: "file",
        });

        expect(result.entries).toEqual([{ path: "src/index.ts", kind: "file" }]);
        expect(result.truncated).toBe(true);
      }),
    );

    it.effect("answers an empty file-filtered query with a bounded file listing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-empty-query-" });
        yield* writeTextFile(cwd, "src/index.ts");
        yield* writeTextFile(cwd, "README.md");

        const result = yield* searchWorkspaceEntries({
          cwd,
          query: "",
          limit: 10,
          kind: "file",
        });

        const paths = result.entries.map((entry) => entry.path);
        expect(paths).toHaveLength(2);
        expect(paths).toContain("src/index.ts");
        expect(paths).toContain("README.md");
        expect(result.entries.every((entry) => entry.kind === "file")).toBe(true);
      }),
    );

    it.effect("returns only directories for the directory filter", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-directory-filter-" });
        yield* writeTextFile(cwd, "src/index.ts");

        const result = yield* searchWorkspaceEntries({
          cwd,
          query: "src",
          limit: 10,
          kind: "directory",
        });

        expect(result.entries).toEqual([{ path: "src", kind: "directory" }]);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("excludes gitignored paths for git repositories", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-gitignore-", git: true });
        yield* writeTextFile(cwd, ".gitignore", ".convex/\nconvex/\nignored.txt\n");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");
        yield* writeTextFile(cwd, "ignored.txt", "ignore me");
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "convex/UOoS-l/convex_local_storage/modules/data.json", "{}");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths).not.toContain("ignored.txt");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
        expect(paths.some((entryPath) => entryPath.startsWith("convex/"))).toBe(false);
      }),
    );

    it.effect("excludes tracked paths that match ignore rules", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({
          prefix: "t3code-workspace-tracked-gitignore-",
          git: true,
        });
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");
        yield* git(cwd, ["add", ".convex/local-storage/data.json", "src/keep.ts"]);
        yield* writeTextFile(cwd, ".gitignore", ".convex/\n");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
      }),
    );

    it.effect("excludes .convex in non-git workspaces", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-non-git-convex-" });
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
      }),
    );

    it.effect("supports typo-resistant file search through fff", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-fff-typo-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");

        const result = yield* searchWorkspaceEntries({ cwd, query: "compoesr", limit: 10 });

        expect(result.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: "src/components/Composer.tsx" }),
          ]),
        );
      }),
    );

    it.effect("rebuilds the cached index after refresh fails", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-refresh-failure-" });
        yield* writeTextFile(cwd, "src/index.ts", "export {};\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const createSpy = vi.spyOn(FileFinder, "create");
        yield* workspaceEntries.list({ cwd });
        expect(createSpy).toHaveBeenCalledTimes(1);

        vi.spyOn(FileFinder.prototype, "scanFiles").mockReturnValueOnce({
          ok: false,
          error: "scan failed",
        });
        yield* workspaceEntries.refresh(cwd);

        yield* workspaceEntries.list({ cwd });
        expect(createSpy).toHaveBeenCalledTimes(2);
      }),
    );
  });

  describe("searchContents", () => {
    it.effect("returns content matches with file paths, line numbers, and ranges", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-search-" });
        yield* writeTextFile(
          cwd,
          "src/shapes.ts",
          "export const square = 4;\nexport const Square = 16;\nexport const squareSize = 8;\n",
        );
        yield* writeTextFile(cwd, "src/other.ts", "const circle = true;\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "Square",
          limit: 100,
          caseSensitive: false,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches.map((match) => [match.path, match.lineNumber])).toEqual([
          ["src/shapes.ts", 1],
          ["src/shapes.ts", 2],
        ]);
        expect(result.matches[0]?.matchRanges).toEqual([{ start: 13, end: 19 }]);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("honors case sensitivity and gitignore rules", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-ignore-", git: true });
        yield* writeTextFile(cwd, ".gitignore", "ignored.txt\n");
        yield* writeTextFile(cwd, "src/keep.ts", "square\nSquare\n");
        yield* writeTextFile(cwd, "ignored.txt", "Square\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "Square",
          limit: 100,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({ path: "src/keep.ts", lineNumber: 2 });
      }),
    );

    it.effect("filters whole-word matches by word boundaries without widening ranges", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-whole-word-" });
        yield* writeTextFile(cwd, "src/words.ts", "note notes denote\nfootnote note\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "note",
          limit: 100,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        // "notes", "denote", and "footnote" are word-adjacent and excluded;
        // ranges cover exactly the query, never boundary characters.
        expect(result.matches).toEqual([
          expect.objectContaining({
            path: "src/words.ts",
            lineNumber: 1,
            matchRanges: [{ start: 0, end: 4 }],
          }),
          expect.objectContaining({
            path: "src/words.ts",
            lineNumber: 2,
            matchRanges: [{ start: 9, end: 13 }],
          }),
        ]);
      }),
    );

    it.effect("finds later whole-word matches in a file after rejected raw matches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-late-whole-word-" });
        yield* writeTextFile(cwd, "src/words.ts", `${"afoo\n".repeat(10)}foo\n`);

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo",
          limit: 1,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches).toEqual([
          expect.objectContaining({
            path: "src/words.ts",
            lineNumber: 11,
            matchRanges: [{ start: 0, end: 3 }],
          }),
        ]);
      }),
    );

    it.effect("treats astral-plane letters as whole word characters", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-astral-word-" });
        yield* writeTextFile(cwd, "src/words.ts", "𐐀foo foo foo𐐀\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo",
          limit: 100,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches).toEqual([
          expect.objectContaining({
            path: "src/words.ts",
            lineNumber: 1,
            matchRanges: [{ start: 6, end: 9 }],
          }),
        ]);
      }),
    );

    it.effect("matches punctuation-edged whole-word queries including adjacent occurrences", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-punctuation-" });
        yield* writeTextFile(cwd, "src/words.ts", "-foo- -foo- -foo-\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "-foo-",
          limit: 100,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        // Consuming-boundary regex would swallow the separating spaces and
        // drop the middle occurrence; boundary post-filtering keeps all three.
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({
          path: "src/words.ts",
          lineNumber: 1,
          matchRanges: [
            { start: 0, end: 5 },
            { start: 6, end: 11 },
            { start: 12, end: 17 },
          ],
        });
      }),
    );

    it.effect("matches punctuation-edged regex queries as whole words", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-regex-punctuation-" });
        yield* writeTextFile(cwd, "src/words.ts", "foo- foo-\nafoo-b\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo-",
          limit: 100,
          caseSensitive: true,
          wholeWord: true,
          useRegex: true,
        });

        // wholeWord + useRegex must not silently drop non-word-edged patterns
        // like "foo-", and "afoo-" is excluded because 'a'/'f' are both word
        // characters at the match's left edge.
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({
          path: "src/words.ts",
          lineNumber: 1,
          matchRanges: [
            { start: 0, end: 4 },
            { start: 5, end: 9 },
          ],
        });
      }),
    );

    it.effect("caps matches per file so one dense file cannot fill the page", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-per-file-cap-" });
        yield* writeTextFile(cwd, "src/dense.ts", "needle\n".repeat(300));
        yield* writeTextFile(cwd, "src/other.ts", "needle\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "needle",
          limit: 500,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        const byPath = new Map<string, number>();
        for (const match of result.matches) {
          byPath.set(match.path, (byPath.get(match.path) ?? 0) + 1);
        }
        expect(byPath.get("src/dense.ts")).toBe(100);
        expect(byPath.get("src/other.ts")).toBe(1);
      }),
    );

    it.effect("preserves regex escapes during case-insensitive searches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-regex-" });
        yield* writeTextFile(cwd, "src/shapes.ts", "Square\nsquare\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "\\SQUARE",
          limit: 100,
          caseSensitive: false,
          wholeWord: false,
          useRegex: true,
        });

        expect(result.matches.map((match) => match.lineNumber)).toEqual([1, 2]);
      }),
    );

    it.effect("preserves invalid regex errors during case-insensitive searches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-invalid-regex-" });
        yield* writeTextFile(cwd, "src/shapes.ts", "foobar\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo)bar(",
          limit: 100,
          caseSensitive: false,
          wholeWord: false,
          useRegex: true,
        });

        expect(result.regexFallbackError).toBeDefined();
        expect(result.matches).toEqual([]);
      }),
    );

    it.effect("maps multi-byte lines to string-indexed ranges", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-multibyte-" });
        yield* writeTextFile(cwd, "src/notes.ts", 'const label = "héllo wörld";\n');

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "wörld",
          limit: 100,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches).toHaveLength(1);
        const match = result.matches[0]!;
        const range = match.matchRanges[0]!;
        expect(match.lineContent.slice(range.start, range.end)).toBe("wörld");
      }),
    );
  });

  describe("browse with includeFiles", () => {
    it.effect("returns files and directories, directories first, each tagged", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-listing-" });
        yield* writeTextFile(cwd, "readme.md", "hi");
        yield* writeTextFile(cwd, "src/index.ts", "export {};\n");
        yield* writeTextFile(cwd, ".env", "SECRET=1");

        const result = yield* workspaceEntries.browse({
          partialPath: yield* appendSeparator(cwd),
          includeFiles: true,
        });

        expect(result.entries).toEqual([
          { name: "src", fullPath: path.join(cwd, "src"), kind: "directory" },
          { name: ".env", fullPath: path.join(cwd, ".env"), kind: "file" },
          { name: "readme.md", fullPath: path.join(cwd, "readme.md"), kind: "file" },
        ]);
        expect(result.truncated).toBe(false);
        expect(result.totalCount).toBe(3);
        // The client cannot tell a legacy directories-only answer from a real
        // listing without this, so it gates the whole feature on it.
        expect(result.listedFiles).toBe(true);
      }),
    );

    it.effect("resolves a symlinked directory as a directory, not a file", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-listing-link-" });
        yield* writeTextFile(cwd, "real/inner.txt", "x");
        yield* writeTextFile(cwd, "target.txt", "x");
        yield* Effect.promise(() =>
          NodeFSP.symlink(path.join(cwd, "real"), path.join(cwd, "link-dir")),
        );
        yield* Effect.promise(() =>
          NodeFSP.symlink(path.join(cwd, "target.txt"), path.join(cwd, "link-file")),
        );
        yield* Effect.promise(() =>
          NodeFSP.symlink(path.join(cwd, "nope"), path.join(cwd, "dead")),
        );

        const result = yield* workspaceEntries.browse({
          partialPath: yield* appendSeparator(cwd),
          includeFiles: true,
        });
        const kindOf = (name: string) => result.entries.find((entry) => entry.name === name)?.kind;

        // `dirent.isDirectory()` answers false for both of these; only a stat
        // tells them apart, and on macOS this is what /etc and /tmp look like.
        expect(kindOf("link-dir")).toBe("directory");
        // A symlinked file must stay a file: `other` rows render disabled, so
        // demoting these would make every symlinked file unopenable.
        expect(kindOf("link-file")).toBe("file");
        expect(kindOf("dead")).toBe("other");
      }),
    );

    it.effect("caps the listing to the alphabetical head and reports the true total", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-listing-cap-" });
        const total = FILESYSTEM_BROWSE_MAX_ENTRIES + 5;
        const named = (index: number) => `file-${String(index).padStart(6, "0")}.txt`;
        // Served in reverse order on purpose. A real `readdir` returns whatever
        // the filesystem's directory order is — on the temp dir this suite
        // creates it happens to come back sorted, which makes "cap then sort"
        // and "sort then cap" indistinguishable and the assertion vacuous.
        vi.mocked(NodeFSP.readdir).mockResolvedValueOnce(
          Array.from({ length: total }, (_unused, index) => ({
            name: named(total - 1 - index),
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => false,
          })) as never,
        );

        const result = yield* workspaceEntries.browse({
          partialPath: yield* appendSeparator(cwd),
          includeFiles: true,
        });

        expect(result.entries.length).toBe(FILESYSTEM_BROWSE_MAX_ENTRIES);
        expect(result.truncated).toBe(true);
        expect(result.totalCount).toBe(total);
        // "Showing N of M" only tells the truth if the M-N dropped are the tail.
        // Capping the directory's own order and sorting the survivors satisfies
        // every count above while omitting names from the middle of the list.
        const names = result.entries.map((entry) => entry.name);
        expect(names[0]).toBe(named(0));
        expect(names.at(-1)).toBe(named(FILESYSTEM_BROWSE_MAX_ENTRIES - 1));
      }),
    );

    it.effect("reports an unreadable directory instead of returning it empty", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-listing-eacces-" });
        const readdirMock = vi.mocked(NodeFSP.readdir);
        readdirMock.mockImplementationOnce(() => {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          return Promise.reject(error);
        });

        const listing = yield* Effect.exit(
          workspaceEntries.browse({
            partialPath: yield* appendSeparator(cwd),
            includeFiles: true,
          }),
        );

        // Autocomplete degrades EACCES to an empty array; a viewer that did the
        // same would render an unreadable folder as an empty one. Assert which
        // failure, or any bug that throws at all satisfies this.
        expect(listing._tag).toBe("Failure");
        const error = listing._tag === "Failure" ? Cause.squash(listing.cause) : undefined;
        expect((error as { readonly _tag?: string } | undefined)?._tag).toBe(
          "WorkspaceEntriesReadDirectoryError",
        );

        // The other half of the guard: the autocomplete path must keep
        // degrading quietly, because a command palette that errors on an
        // unreadable directory is worse than one that shows nothing.
        readdirMock.mockImplementationOnce(() => {
          const denied = new Error("permission denied") as NodeJS.ErrnoException;
          denied.code = "EACCES";
          return Promise.reject(denied);
        });
        const autocomplete = yield* workspaceEntries.browse({
          partialPath: yield* appendSeparator(cwd),
        });
        expect(autocomplete.entries).toEqual([]);
        expect(autocomplete.listedFiles).toBeUndefined();
      }),
    );

    it.effect("lets only two listings hold a libuv thread at once", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-listing-permits-" });
        const partialPath = yield* appendSeparator(cwd);

        // `readdir` is held open until released, so "how many have started" is
        // exactly "how many hold a pool thread" — no timing involved.
        const release: Array<() => void> = [];
        let started = 0;
        let onStart: (() => void) | null = null;
        const hold = () => {
          started += 1;
          onStart?.();
          return new Promise((resolve) => {
            release.push(() => {
              resolve([] as never);
            });
          });
        };
        // Queued per call rather than installed persistently: `restoreAllMocks`
        // does not give this module-level `vi.fn` its original implementation
        // back, so a lingering never-resolving `readdir` would hang every later
        // test in the file.
        for (let call = 0; call < 3; call += 1) {
          vi.mocked(NodeFSP.readdir).mockImplementationOnce(hold as never);
        }
        const startedAtLeast = (count: number) =>
          new Promise<void>((resolve) => {
            onStart = () => {
              if (started >= count) resolve();
            };
            onStart();
          });

        const listings = yield* Effect.forkChild(
          Effect.all(
            Array.from({ length: 3 }, () =>
              workspaceEntries.browse({ partialPath, includeFiles: true }),
            ),
            { concurrency: "unbounded" },
          ),
        );

        yield* Effect.promise(() => startedAtLeast(2));
        // Three were asked for and nothing has finished, so a third reader here
        // means the permit is not being taken.
        expect(started).toBe(2);

        release[0]?.();
        yield* Effect.promise(() => startedAtLeast(3));
        expect(started).toBe(3);
        for (const resolve of release) resolve();
        yield* Fiber.join(listings);
      }),
    );
  });

  describe("browse", () => {
    it.effect("returns matching directories and excludes files", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-prefix-" });
        yield* writeTextFile(cwd, "alphabet.txt", "ignore me");
        yield* writeTextFile(cwd, "alpha/index.ts", "export {};\n");
        yield* writeTextFile(cwd, "alpine/index.ts", "export {};\n");

        const result = yield* workspaceEntries.browse({
          partialPath: path.join(cwd, "alp"),
        });

        expect(result).toEqual({
          parentPath: cwd,
          entries: [
            { name: "alpha", fullPath: path.join(cwd, "alpha") },
            { name: "alpine", fullPath: path.join(cwd, "alpine") },
          ],
        });
      }),
    );

    it.effect("shows dot directories in directory mode and hidden-prefix mode", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-hidden-" });
        yield* writeTextFile(cwd, ".config/settings.json", "{}");
        yield* writeTextFile(cwd, "config/settings.json", "{}");
        const cwdWithSeparator = yield* appendSeparator(cwd);

        const directoryResult = yield* workspaceEntries.browse({
          partialPath: cwdWithSeparator,
        });
        const hiddenPrefixResult = yield* workspaceEntries.browse({
          partialPath: `${cwdWithSeparator}.c`,
        });

        expect(directoryResult.entries.map((entry) => entry.name)).toEqual([".config", "config"]);
        expect(hiddenPrefixResult).toEqual({
          parentPath: cwd,
          entries: [{ name: ".config", fullPath: path.join(cwd, ".config") }],
        });
      }),
    );

    it.effect("supports relative paths when cwd is provided", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-relative-" });
        yield* writeTextFile(cwd, "packages/pkg.json", "{}");

        const result = yield* workspaceEntries.browse({
          cwd,
          partialPath: "./pack",
        });

        expect(result).toEqual({
          parentPath: cwd,
          entries: [{ name: "packages", fullPath: path.join(cwd, "packages") }],
        });
      }),
    );

    it.effect("rejects relative paths without cwd", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

        const error = yield* workspaceEntries
          .browse({
            partialPath: "./src",
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspaceEntriesCurrentProjectRequiredError");
        expect(error.message).toBe(
          "A current project is required to browse relative workspace path './src'.",
        );
      }),
    );

    it.effect("returns an empty listing when the OS denies directory access", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-eacces-" });

        const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        vi.mocked(NodeFSP.readdir).mockRejectedValueOnce(denied);

        const result = yield* workspaceEntries.browse({
          partialPath: yield* appendSeparator(cwd),
        });
        expect(result).toEqual({ parentPath: cwd, entries: [] });
      }),
    );
  });
});
