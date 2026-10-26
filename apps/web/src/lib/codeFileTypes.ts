import { getFiletypeFromFileName } from "@pierre/diffs";
import {
  isWorkspaceAudioPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspaceVideoPreviewPath,
  WORKSPACE_TEXT_VIEWER_EXTENSIONS,
} from "@t3tools/shared/filePreview";

/**
 * How the viewer should render a file. Previously lived in the fork's
 * `fileViewerStore`; that store was replaced by the right-panel surface model,
 * so the type lives with the classifier that produces it.
 */
export type FileViewerKind = "html" | "markdown" | "code" | "image" | "video" | "audio";

/**
 * The single gate for "is this an openable code file": keep it conservative, or prose like
 * `example.com` becomes a chip. Excludes `.md`/`.html` (own kinds), binaries, `.env` and
 * extension-less files (secrets), and `.m`/`.mm` (prose false positives). Derived from the list
 * the server's `/viewer` route reads so they cannot drift; dots dropped to match {@link extensionOf}.
 */
export const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  WORKSPACE_TEXT_VIEWER_EXTENSIONS.map((extension) => extension.slice(1)),
);

/** Strip query/hash and trailing separators, returning the final path segment. */
function basenameOf(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? path;
  const trimmed = clean.replace(/[\\/]+$/, "");
  const sep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return sep >= 0 ? trimmed.slice(sep + 1) : trimmed;
}

/**
 * Lowercased extension (without the dot) of the final path segment, or "" when the
 * segment has no extension. A leading dot (dotfile like `.env`) is not an extension,
 * but a real extension on a dotfile (`.eslintrc.json`) is.
 */
function extensionOf(path: string): string {
  const base = basenameOf(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Shared by the chip detector ({@link classifyInlineCodePath}) and the viewer. Null is NOT
 * "unviewable": the viewer falls back to its code view (how `Makefile` still renders); it only
 * means "do not turn this token into a chip".
 */
export function classifyFileViewerKind(path: string): FileViewerKind | null {
  const ext = extensionOf(path);
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  // Delegates to the shared predicate the workspace image preview and the server's
  // asset + viewer routes already share, so an extension can never be viewable on
  // one surface and a failed text read on another.
  if (isWorkspaceImagePreviewPath(path)) return "image";
  if (isWorkspaceVideoPreviewPath(path)) return "video";
  if (isWorkspaceAudioPreviewPath(path)) return "audio";
  if (TEXT_FILE_EXTENSIONS.has(ext)) return "code";
  return null;
}

/**
 * Resolve a Shiki language id for syntax-highlighting a code file, derived from its
 * filename via `@pierre/diffs` (the same resolver it uses for diffs). Returns "text"
 * for anything it doesn't recognise, which the highlighter renders as plain text.
 */
export function languageForPath(path: string): string {
  return getFiletypeFromFileName(basenameOf(path));
}
