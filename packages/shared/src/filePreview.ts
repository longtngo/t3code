export const WORKSPACE_BROWSER_PREVIEW_EXTENSIONS = [".htm", ".html", ".pdf"] as const;

export const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
] as const;

/**
 * Text/code files the viewer will open: the chip + side-panel treatment in the
 * client, and the raw `/viewer` route on the server.
 *
 * Keep it conservative. It is the single gate for "is this an openable code
 * file", so a loose list means false-positive chips on prose tokens like
 * `example.com`. Deliberately excludes `.md`/`.html` (their own kinds),
 * binary/media formats, `.env` and extension-less files, and the ambiguous
 * `.m`/`.mm` (Objective-C vs MATLAB).
 *
 * It lives here because the two surfaces have to agree: an extension viewable
 * on one and a failed text read on the other is a broken "Open in new tab".
 * They were hand-synced copies carrying "keep the two in sync" comments, which
 * held only for as long as everyone read them.
 */
export const WORKSPACE_TEXT_VIEWER_EXTENSIONS = [
  // Plain text / data / config
  ".txt",
  ".log",
  ".csv",
  ".tsv",
  ".json",
  ".json5",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".cfg",
  ".properties",
  ".xml",
  ".sql",
  // Scripting / systems languages
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hh",
  ".cs",
  ".php",
  ".swift",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".lua",
  ".pl",
  ".pm",
  ".r",
  ".dart",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".clj",
  ".cljs",
  ".cljc",
  ".edn",
  // JS/TS + web frameworks
  ".js",
  ".cjs",
  ".mjs",
  ".jsx",
  ".ts",
  ".cts",
  ".mts",
  ".tsx",
  ".vue",
  ".svelte",
  ".astro",
  ".css",
  ".scss",
  ".sass",
  ".less",
  // Schemas / build / infra / misc
  ".graphql",
  ".gql",
  ".proto",
  ".gradle",
  ".groovy",
  ".tf",
  ".hcl",
  ".vim",
  ".diff",
  ".patch",
] as const;

function hasPreviewExtension(path: string, extensions: ReadonlyArray<string>): boolean {
  const pathWithoutQuery = path.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  return extensions.some((extension) => pathWithoutQuery.endsWith(extension));
}

export function isWorkspaceBrowserPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_BROWSER_PREVIEW_EXTENSIONS);
}

export function isWorkspaceImagePreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_IMAGE_PREVIEW_EXTENSIONS);
}

export function isWorkspacePreviewEntryPath(path: string): boolean {
  return isWorkspaceBrowserPreviewPath(path) || isWorkspaceImagePreviewPath(path);
}
