import { getFiletypeFromFileName } from "@pierre/diffs";
import {
  isWorkspaceImagePreviewPath,
  WORKSPACE_TEXT_VIEWER_EXTENSIONS,
} from "@t3tools/shared/filePreview";

/**
 * How the viewer should render a file. Previously lived in the fork's
 * `fileViewerStore`; that store was replaced by the right-panel surface model,
 * so the type lives with the classifier that produces it.
 */
export type FileViewerKind = "html" | "markdown" | "code" | "image";

/**
 * Curated allow-list of text/code file extensions that get the clickable-chip +
 * side-panel treatment (alongside the specially-handled `.md`/`.html`). Keep this
 * conservative — it is the single gate for "is this an openable code file", so a
 * loose list means false-positive chips on prose tokens like `example.com`.
 *
 * Deliberately excludes: `.md`/`.html` (handled as their own kinds), binary/media
 * formats, `.env` and extension-less files (secrets / keeps the server `/viewer`
 * unit test valid), and the ambiguous single-letter `.m`/`.mm` (Objective-C vs
 * MATLAB — high prose-false-positive risk).
 *
 * Derived from the shared list the server's `/viewer` route reads too, so the two
 * cannot drift; this side drops the leading dot because it matches on the bare
 * extension {@link extensionOf} produces.
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
 * Single source of truth mapping a file path to how the viewer should render it,
 * or null when the path is not an openable document. Shared by the in-message chip
 * detector ({@link classifyInlineCodePath}) and the viewer.
 *
 * A null result is NOT "unviewable" — the viewer falls back to its code view, which
 * is how extension-less files (`Makefile`, `Dockerfile`) opened via the address bar
 * still render. Null only means "do not turn this token into a chip", which is the
 * conservative half of the contract described on {@link TEXT_FILE_EXTENSIONS}.
 */
export function classifyFileViewerKind(path: string): FileViewerKind | null {
  const ext = extensionOf(path);
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  // Delegates to the shared predicate the workspace image preview and the server's
  // asset + viewer routes already share, so an extension can never be viewable on
  // one surface and a failed text read on another.
  if (isWorkspaceImagePreviewPath(path)) return "image";
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
