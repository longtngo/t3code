import {
  audioMimeTypeFromExtension,
  isWorkspaceImagePreviewPath,
  mediaMimeTypeFromExtension,
} from "./mediaPreview.ts";
export {
  isWorkspaceImagePreviewPath,
  mediaKindFromPath,
  mediaMimeTypeFromExtension,
  WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
} from "./mediaPreview.ts";

export type FilePreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "html"
  | "markdown"
  | "mermaid"
  | "font"
  | "archive"
  | "sqlite"
  | "docx"
  | "xlsx"
  | "pptx"
  | "odt"
  | "ods"
  | "odp"
  | "rtf"
  | "epub"
  | "ipynb"
  | "text"
  | "unsupported";

export function filePreviewKind(
  file: { readonly name: string; readonly mimeType?: string },
  options?: { readonly richDocuments?: boolean },
): FilePreviewKind {
  const mime = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const name = file.name.toLowerCase();
  const extension = name.slice(name.lastIndexOf("."));
  const generic = !mime || mime === "application/octet-stream" || mime === "text/plain";
  const richDocuments = options?.richDocuments !== false;
  const office = richDocuments ? officePreviewKind(file) : null;
  if (office) return office;
  const binary = binaryPreviewKind(file);
  if (binary) return binary;
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/html") return "html";
  if (mime === "text/markdown" || mime === "text/x-markdown") return "markdown";
  if (richDocuments && mime === "text/vnd.mermaid") return "mermaid";
  if (richDocuments && mime.startsWith("font/")) return "font";
  // Linux's MIME database also assigns .otf to OpenDocument formula templates.
  // FontFace validates the actual bytes before a specimen is shown.
  if (
    richDocuments &&
    extension === ".otf" &&
    mime === "application/vnd.oasis.opendocument.formula-template"
  )
    return "font";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (generic) {
    if (extension === ".pdf") return "pdf";
    if (/^\.html?$/.test(extension)) return "html";
    if (/^\.(md|markdown|mdown|mkd|mdx)$/.test(extension)) return "markdown";
    if (richDocuments && /^\.(mmd|mermaid)$/.test(extension)) return "mermaid";
    if (richDocuments && isWorkspaceFontPreviewPath(name)) return "font";
    if (richDocuments && extension === ".rtf") return "text";
    const media = mediaMimeTypeFromExtension(extension);
    if (media?.startsWith("image/")) return "image";
    if (media?.startsWith("video/")) return "video";
    if (audioMimeTypeFromExtension(extension) !== null) return "audio";
    if (
      /^\.(txt|log|json|jsonc|jsonl|ndjson|yaml|yml|toml|ini|conf|config|env|csv|tsv|xml|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyi|rb|go|rs|swift|kt|kts|java|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|graphql|gql|vue|svelte|r|lua|ex|exs|erl|hs|clj|dart|diff|patch|lock|properties|gradle)$/.test(
        extension,
      ) ||
      /^(dockerfile|makefile|gemfile|rakefile|license|readme|\.gitignore|\.gitattributes|\.editorconfig|\.env)(\.|$)/i.test(
        name.split(/[\\/]/).at(-1) ?? "",
      )
    )
      return "text";
  }
  if (
    mime.startsWith("text/") ||
    /^(application\/(json|.*\+json|xml|.*\+xml|javascript|x-javascript|yaml|x-yaml|toml|sql))$/.test(
      mime,
    )
  )
    return "text";
  return "unsupported";
}

const BINARY_MIME_TYPES = new Map([
  [".zip", "application/zip"],
  [".jar", "application/java-archive"],
  [".tar", "application/x-tar"],
  [".gz", "application/gzip"],
  [".tgz", "application/gzip"],
  [".sqlite", "application/vnd.sqlite3"],
  [".sqlite3", "application/vnd.sqlite3"],
  [".db", "application/vnd.sqlite3"],
]);

export function binaryPreviewKind(file: {
  readonly name: string;
  readonly mimeType?: string;
}): "archive" | "sqlite" | null {
  const mime = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (["application/vnd.sqlite3", "application/x-sqlite3", "application/x-sqlite"].includes(mime))
    return "sqlite";
  if (
    [
      "application/zip",
      "application/x-zip-compressed",
      "application/java-archive",
      "application/x-java-archive",
      "application/x-tar",
      "application/gzip",
      "application/x-gzip",
      "application/x-compressed-tar",
    ].includes(mime)
  )
    return "archive";
  if (mime && mime !== "application/octet-stream" && mime !== "text/plain") return null;
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  const inferred = BINARY_MIME_TYPES.get(extension);
  return inferred === "application/vnd.sqlite3" ? "sqlite" : inferred ? "archive" : null;
}

export const FILE_TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

const OFFICE_MIME_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  epub: "application/epub+zip",
  ipynb: "application/x-ipynb+json",
} as const;

export type OfficePreviewKind = keyof typeof OFFICE_MIME_TYPES;

export function officePreviewKind(file: {
  readonly name: string;
  readonly mimeType?: string;
}): OfficePreviewKind | null {
  const mime = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mime === "text/rtf") return "rtf";
  for (const kind of Object.keys(OFFICE_MIME_TYPES) as OfficePreviewKind[]) {
    if (mime === OFFICE_MIME_TYPES[kind]) return kind;
    if (
      (!mime ||
        mime === "application/octet-stream" ||
        mime === "text/plain" ||
        (kind === "ipynb" && mime === "application/json")) &&
      file.name.toLowerCase().endsWith(`.${kind}`)
    )
      return kind;
  }
  return null;
}

export function decodeFilePreviewText(bytes: Uint8Array, truncated = false) {
  const bounded = bytes.subarray(0, FILE_TEXT_PREVIEW_MAX_BYTES);
  if (bounded.some((byte) => byte === 0))
    throw new Error("This file contains binary data and cannot be shown as text.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return {
      text: decoder.decode(bounded, { stream: truncated || bytes.length > bounded.length }),
      truncated: truncated || bytes.length > bounded.length,
    };
  } catch {
    throw new Error("This file is not UTF-8 text. Open it in another app to view its contents.");
  }
}

export const WORKSPACE_BROWSER_PREVIEW_EXTENSIONS = [".htm", ".html", ".pdf"] as const;

/**
 * Video the viewer will play: narrower than `apps/web/src/types.ts`'s attachment table, which also
 * names `.avi`/`.mkv` that no `<video>` decodes (`types.test.ts` asserts they agree where they
 * overlap). Separate from the browser/image lists, which also gate "open in a browser preview".
 */
export const WORKSPACE_VIDEO_PREVIEW_EXTENSIONS = [
  ".m4v",
  ".mov",
  ".mp4",
  ".ogv",
  ".webm",
] as const;

/**
 * Audio the viewer will play, reached with video through `isWorkspaceMediaPreviewPath`.
 * `.opus`/`.oga` are Ogg containers (`audio/ogg`); `.m4a` is MP4 (`audio/mp4`).
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

/** Content type per audio extension; the `/viewer` route pins it because `HttpServerResponse.file` drops `contentType`. */
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
  // video/mp4, not the non-IANA video/x-m4v: `.m4v` IS mp4, responses carry `nosniff`, and
  // apps/web/src/types.ts made the same call for attachments.
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".ogv": "video/ogg",
  ".webm": "video/webm",
};

/**
 * Text/code files the client chip and the server `/viewer` route both open, shared so they agree.
 * Conservative on purpose (a loose list chips prose like `example.com`): no `.md`/`.html`, media,
 * `.env`, extension-less files, or the ambiguous `.m`/`.mm`.
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

const BROWSER_MIME_TYPE_BY_EXTENSION = new Map([
  [".htm", "text/html"],
  [".html", "text/html"],
  [".pdf", "application/pdf"],
]);

const FONT_MIME_TYPE_BY_EXTENSION = new Map([
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

export function isWorkspaceFontPreviewPath(path: string): boolean {
  return /\.(ttf|otf|woff2?)$/i.test(path);
}

export function hostPreviewMimeTypeFromExtension(extension: string): string | null {
  if (!/^\.[a-z0-9-]+$/i.test(extension)) return null;
  return (
    mediaMimeTypeFromExtension(extension) ??
    audioMimeTypeFromExtension(extension) ??
    BROWSER_MIME_TYPE_BY_EXTENSION.get(extension.toLowerCase()) ??
    FONT_MIME_TYPE_BY_EXTENSION.get(extension.toLowerCase()) ??
    BINARY_MIME_TYPES.get(extension.toLowerCase()) ??
    (Object.hasOwn(OFFICE_MIME_TYPES, extension.toLowerCase().slice(1))
      ? OFFICE_MIME_TYPES[extension.toLowerCase().slice(1) as OfficePreviewKind]
      : null) ??
    null
  );
}

function hasPreviewExtension(path: string, extensions: ReadonlyArray<string>): boolean {
  const literalPath = path.toLowerCase();
  return extensions.some((extension) => literalPath.endsWith(extension));
}

export function isWorkspaceBrowserPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_BROWSER_PREVIEW_EXTENSIONS);
}

/** FORK: list-backed, not upstream's `videoMimeType`, which admits `.avi`/`.mkv` no `<video>` decodes. */
export function isWorkspaceVideoPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_VIDEO_PREVIEW_EXTENSIONS);
}

/** FORK: list-backed so it never admits an extension `AUDIO_CONTENT_TYPE_BY_EXTENSION` lacks. */
export function isWorkspaceAudioPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_AUDIO_PREVIEW_EXTENSIONS);
}

/** Audio or video: bytes the text reader must never see, served with Range and the basename claim. */
export function isWorkspaceMediaPreviewPath(path: string): boolean {
  return isWorkspaceVideoPreviewPath(path) || isWorkspaceAudioPreviewPath(path);
}

export function isWorkspacePreviewEntryPath(path: string): boolean {
  return (
    isWorkspaceBrowserPreviewPath(path) ||
    isWorkspaceImagePreviewPath(path) ||
    isWorkspaceFontPreviewPath(path) ||
    officePreviewKind({ name: path }) !== null ||
    binaryPreviewKind({ name: path }) !== null
  );
}
