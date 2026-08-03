/**
 * Detects file paths written as plain text in chat messages and resolves them to
 * the absolute paths the file viewer needs.
 *
 * Markdown link destinations (`[label](src/main.ts)`) were already resolved by
 * `markdown-links`; this module covers the far more common case of a model
 * simply *writing* a path in prose or inline code, which rendered as dead text.
 *
 * Detection reuses the terminal link scanner's pattern, so chat and terminal
 * agree on what looks like a path (including its delimiter trimming, which keeps
 * a sentence's trailing period out of the filename).
 *
 * Resolution is a ladder, cheapest and most certain first:
 *   1. already absolute            -> used as-is
 *   2. `~/…`                       -> expanded against the home inferred from cwd
 *   3. contains a separator        -> joined onto cwd
 *   4. bare filename (`util.ts`)   -> matched by basename against paths known
 *                                     from context; ambiguous or unknown names
 *                                     are left as plain text
 *
 * Step 4 is deliberately conservative. Joining a bare filename onto cwd is what
 * a naive resolver does, and it fabricates a plausible path that usually does not
 * exist — a link that opens an error is worse than no link at all.
 *
 * @module chatFilePathLinks
 */
import { extractTerminalLinks, resolvePathLinkTarget, splitPathAndPosition } from "./terminal-links";

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

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || WINDOWS_ABSOLUTE_PATTERN.test(path) || path.startsWith("\\\\");
}

function hasSeparator(path: string): boolean {
  return path.includes("/") || path.includes("\\");
}

function basenameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(index + 1) : path;
}

function withPosition(path: string, line: string | undefined, column: string | undefined): string {
  if (!line) return path;
  return `${path}:${line}${column ? `:${column}` : ""}`;
}

/**
 * Collapse `.` and `..` segments. Joining cwd with `./src/main.ts` otherwise
 * yields `/cwd/./src/main.ts`, which reads badly and leaves `..` for the
 * server's sandbox check to reason about; resolving it here keeps the path the
 * viewer receives canonical.
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
    const { path } = splitPathAndPosition(match.text);
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

  const { path, line, column } = splitPathAndPosition(trimmed);
  if (path.length === 0) return null;

  if (isAbsolute(path)) return withPosition(path, line, column);

  const cwd = options.cwd;

  // A bare filename carries no location of its own, so context has to supply it.
  if (!hasSeparator(path) && !path.startsWith("~")) {
    const matches = new Set(
      (options.knownPaths ?? []).filter((known) => basenameOf(known) === path),
    );
    if (matches.size !== 1) return null;
    const [only] = [...matches];
    return withPosition(only!, line, column);
  }

  if (!cwd) return null;
  const resolved = resolvePathLinkTarget(trimmed, cwd);
  const split = splitPathAndPosition(resolved);
  return withPosition(normalizeDotSegments(split.path), split.line, split.column);
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
