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
 * Video files the viewer will play. Kept separate from the browser and image
 * lists rather than folded into either: `isWorkspacePreviewEntryPath` (browser ∪
 * image) is the `/api/assets` mint gate, and video is deliberately not served
 * there yet. Matches the set the pull-request markdown renderer already treats as
 * video, so the two cannot disagree about what a video is.
 */
export const WORKSPACE_VIDEO_PREVIEW_EXTENSIONS = [
  ".m4v",
  ".mov",
  ".mp4",
  ".ogv",
  ".webm",
] as const;

/**
 * Content type per video extension. The `/viewer` route pins this through
 * `headers` because `HttpServerResponse.file` drops its `contentType` option, so
 * the served type can only ever be one the allow-list above admits.
 */
export const VIDEO_CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  // video/mp4, not the non-IANA video/x-m4v the platform's own Mime table would
  // pick: `.m4v` IS mp4, the responses carry `nosniff`, and apps/web/src/types.ts
  // already made this call for attachments. Two tables disagreeing on one
  // extension is the drift this shared list exists to prevent.
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".ogv": "video/ogg",
  ".webm": "video/webm",
};

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

export function isWorkspaceVideoPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_VIDEO_PREVIEW_EXTENSIONS);
}

export function isWorkspacePreviewEntryPath(path: string): boolean {
  return isWorkspaceBrowserPreviewPath(path) || isWorkspaceImagePreviewPath(path);
}
