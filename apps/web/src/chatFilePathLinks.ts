/**
 * Detects file paths written in chat prose and resolves them to absolute paths, using the terminal
 * link scanner's pattern. Resolution ladder: absolute as-is; `~/` against the inferred home; with a
 * separator, joined onto cwd; a bare filename only by an unambiguous basename match from context,
 * because joining it onto cwd fabricates a path that usually does not exist.
 */
import {
  formatFilePathPosition,
  resolvePathLinkTarget,
  splitFilePathPosition,
} from "@t3tools/shared/fileLinks";

import { classifyFileViewerKind } from "./lib/codeFileTypes";
import { isKnownFilesystemRootPath } from "./markdown-links";
import { extractTerminalLinks } from "./terminal-links";

export interface ChatFilePathMention {
  /** The matched text, exactly as it appears in the message. */
  readonly raw: string;
  /** Start offset of {@link raw} within the scanned text. */
  readonly start: number;
  /** End offset (exclusive) of {@link raw} within the scanned text. */
  readonly end: number;
  /** Absolute path for the viewer, possibly carrying a `:line[:column]` suffix. */
  readonly targetPath: string;
}

export interface ChatFilePathResolution {
  /** Working directory of the thread, used for `~/` and relative resolution. */
  readonly cwd?: string | undefined;
  /** Absolute paths already known from context, used to place bare filenames. */
  readonly knownPaths?: readonly string[] | undefined;
}

const URL_LIKE_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;
/**
 * A bare `name.ext`, which the terminal scanner deliberately ignores because it
 * requires a separator. Matching it here is safe only because resolution demands
 * an unambiguous basename hit in context, so ordinary prose ("Node.js", "v1.2")
 * finds nothing and stays plain text.
 */
const BARE_FILENAME_PATTERN = /[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+(?::\d+){0,2}/g;

/** Whether a path is rooted, and so addressable without a cwd. */
export function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || WINDOWS_ABSOLUTE_PATTERN.test(path) || path.startsWith("\\\\");
}

const isAbsolute = isAbsoluteFilePath;

function hasSeparator(path: string): boolean {
  return path.includes("/") || path.includes("\\");
}

function basenameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(index + 1) : path;
}

/**
 * Collapse `.` and `..` segments so the viewer receives one canonical spelling of a path.
 * Not a safety measure: the read RPC is bounded by request scope, not by path.
 */
function normalizeDotSegments(path: string): string {
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const isAbsolutePosix = path.startsWith("/");
  const segments = path.split(/[\\/]/);
  const output: string[] = [];
  for (const segment of segments) {
    if (segment === "." || segment === "") {
      // Keep a leading empty segment so POSIX roots survive the rejoin.
      if (output.length === 0 && segment === "" && isAbsolutePosix) output.push("");
      continue;
    }
    if (segment === "..") {
      const last = output[output.length - 1];
      if (output.length > 0 && last !== ".." && last !== "") {
        output.pop();
        continue;
      }
      if (isAbsolutePosix) continue; // Cannot ascend past the root.
    }
    output.push(segment);
  }
  const joined = output.join(separator);
  return isAbsolutePosix && !joined.startsWith("/") ? `/${joined}` : joined;
}

/**
 * Collect the absolute paths a message states outright. These become the context
 * that lets a later bare filename in the same message resolve — the common shape
 * of "I edited /abs/path/util.ts … util.ts now exports X".
 */
export function collectKnownAbsolutePaths(text: string): string[] {
  const found: string[] = [];
  for (const match of extractTerminalLinks(text)) {
    if (match.kind !== "path") continue;
    const { path } = splitFilePathPosition(match.text);
    if (!isAbsolute(path) || URL_LIKE_PATTERN.test(path)) continue;
    found.push(path);
  }
  return found;
}

/**
 * Resolve one path-shaped string to an absolute target, or `null` when it cannot
 * be placed confidently. See the module docstring for the resolution ladder.
 */
export function resolveChatFilePathMention(
  raw: string,
  options: ChatFilePathResolution,
): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || URL_LIKE_PATTERN.test(trimmed)) return null;

  const position = splitFilePathPosition(trimmed);
  const { path } = position;
  if (path.length === 0) return null;

  // The extension allow-list (lib/codeFileTypes.ts) is the main gate; linkifying any path-shaped
  // token chipped prose like `example.com`. Widened only by shapes that cannot be prose, so folders
  // are clickable (93.3% genuine paths over 82,872 messages; app-route prefixes excluded). `~/` is
  // tested separately because `isAbsolute` rejects it.
  if (
    classifyFileViewerKind(path) === null &&
    !isKnownFilesystemRootPath(path) &&
    !path.startsWith("~/")
  ) {
    return null;
  }

  if (isAbsolute(path)) return formatFilePathPosition(position);

  const cwd = options.cwd;

  // A bare filename carries no location of its own, so context has to supply it.
  if (!hasSeparator(path) && !path.startsWith("~")) {
    const matches = new Set(
      (options.knownPaths ?? []).filter((known) => basenameOf(known) === path),
    );
    if (matches.size !== 1) return null;
    const [only] = [...matches];
    return formatFilePathPosition({ ...position, path: only! });
  }

  if (!cwd) return null;
  const resolved = resolvePathLinkTarget(trimmed, cwd);
  const split = splitFilePathPosition(resolved);
  return formatFilePathPosition({ ...split, path: normalizeDotSegments(split.path) });
}

/**
 * Find every resolvable file-path mention in a run of plain text, in document
 * order. Offsets refer to the input string so a caller can splice the text into
 * linked and unlinked segments without re-scanning.
 */
export function findChatFilePathMentions(
  text: string,
  options: ChatFilePathResolution,
): ChatFilePathMention[] {
  const mentions: ChatFilePathMention[] = [];
  for (const match of extractTerminalLinks(text)) {
    if (match.kind !== "path") continue;
    const targetPath = resolveChatFilePathMention(match.text, options);
    if (!targetPath) continue;
    mentions.push({
      raw: match.text,
      start: match.start,
      end: match.end,
      targetPath,
    });
  }

  // Second pass for bare `name.ext` mentions, which the terminal scanner skips.
  // Only those the context can place survive resolution, so this cannot turn
  // ordinary prose into links.
  if ((options.knownPaths?.length ?? 0) > 0) {
    BARE_FILENAME_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(BARE_FILENAME_PATTERN)) {
      const start = match.index ?? -1;
      const raw = match[0];
      if (start < 0 || raw.length === 0) continue;
      const end = start + raw.length;
      if (mentions.some((other) => start < other.end && other.start < end)) continue;
      const targetPath = resolveChatFilePathMention(raw, options);
      if (!targetPath) continue;
      mentions.push({ raw, start, end, targetPath });
    }
  }

  return mentions.toSorted((a, b) => a.start - b.start);
}
