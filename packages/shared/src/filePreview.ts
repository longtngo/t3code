import { videoMimeType } from "./video.ts";

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
 * image) also gates the "open in a browser preview" affordances, which a video
 * has no use for, so the `/api/assets` mint gate names this predicate directly
 * instead. The pull-request markdown renderer derives its own bare-URL pattern
 * from this list rather than repeating it, so the two cannot disagree about what
 * a video is.
 *
 * Deliberately narrower than the attachment table in `apps/web/src/types.ts`,
 * which also names `.avi` and `.mkv` — real video an attachment can carry and no
 * browser can decode from a `<video>`. Those two are NOT one list for that
 * reason, but they must never disagree where they overlap, which
 * `apps/web/src/types.test.ts` asserts.
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
/**
 * Audio files the viewer will play. Separate from the video list because the two
 * render different elements, but reached through `isWorkspaceMediaPreviewPath`
 * everywhere the distinction does not matter.
 *
 * `.opus` and `.oga` are Ogg containers and carry `audio/ogg`, which is what the
 * decoders actually key on; `.m4a` is an MP4 container, so it takes `audio/mp4`
 * for the same reason `.m4v` takes `video/mp4`.
 */
export const WORKSPACE_AUDIO_PREVIEW_EXTENSIONS = [
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
] as const;

/** Content type per audio extension, pinned for the same reason video's is. */
export const AUDIO_CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
};

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

const IMAGE_MIME_TYPE_BY_EXTENSION = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

const BROWSER_MIME_TYPE_BY_EXTENSION = new Map([
  [".htm", "text/html"],
  [".html", "text/html"],
  [".pdf", "application/pdf"],
]);

/** Classifies a literal filesystem extension, without URL decoding or suffix removal. */
export function mediaMimeTypeFromExtension(extension: string): string | null {
  if (!/^\.[a-z0-9]+$/i.test(extension)) return null;
  return (
    IMAGE_MIME_TYPE_BY_EXTENSION.get(extension.toLowerCase()) ??
    videoMimeType({ name: `media${extension}`, mimeType: "" })
  );
}

/** Files the server serves in place from anywhere on its host: media plus browser documents. */
export function hostPreviewMimeTypeFromExtension(extension: string): string | null {
  if (!/^\.[a-z0-9]+$/i.test(extension)) return null;
  return (
    mediaMimeTypeFromExtension(extension) ??
    BROWSER_MIME_TYPE_BY_EXTENSION.get(extension.toLowerCase()) ??
    null
  );
}

/** Classifies an authored media path or URL. Filesystem validation uses the literal extension. */
export function mediaMimeType(path: string): string | null {
  const trimmed = path.trim();
  const source = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  const dataMimeType = /^data:((?:image|video)\/[\w.+-]+)[;,]/i.exec(source)?.[1];
  if (dataMimeType) return dataMimeType.toLowerCase();

  let sourcePath = source.split(/[?#]/, 1)[0] ?? "";
  if (/^(?:https?:|file:|\/\/)/i.test(source)) {
    try {
      sourcePath = new URL(source, "https://media.invalid").pathname;
    } catch {
      return null;
    }
  }
  try {
    sourcePath = decodeURIComponent(sourcePath);
  } catch {
    // A literal percent character is valid in a filename.
  }
  const basename = sourcePath.split(/[\\/]/).at(-1) ?? "";
  const extensionIndex = basename.lastIndexOf(".");
  return extensionIndex < 0 ? null : mediaMimeTypeFromExtension(basename.slice(extensionIndex));
}

export function mediaKindFromPath(path: string): "image" | "video" | null {
  const mimeType = mediaMimeType(path);
  if (mimeType === null) return null;
  return mimeType.startsWith("video/") ? "video" : "image";
}

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

/**
 * FORK: kept over upstream's `videoMimeType`-backed variant. That one admits
 * `.avi` and `.mkv`, which no browser decodes from a `<video>`; this list is
 * deliberately narrower (see WORKSPACE_VIDEO_PREVIEW_EXTENSIONS above).
 */
export function isWorkspaceVideoPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_VIDEO_PREVIEW_EXTENSIONS);
}

export function isWorkspaceAudioPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_AUDIO_PREVIEW_EXTENSIONS);
}

/**
 * Audio and video together, which is how every consumer actually uses them: both
 * are bytes the text reader must never see, both need Range so a media element
 * can seek, and both take the basename-scoped asset claim rather than the
 * directory-scoped one. Kept as one predicate so a call site cannot pick up video
 * and quietly miss audio.
 */
export function isWorkspaceMediaPreviewPath(path: string): boolean {
  return isWorkspaceVideoPreviewPath(path) || isWorkspaceAudioPreviewPath(path);
}

export function isWorkspacePreviewEntryPath(path: string): boolean {
  return isWorkspaceBrowserPreviewPath(path) || isWorkspaceImagePreviewPath(path);
}
