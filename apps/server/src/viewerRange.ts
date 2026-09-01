/**
 * HTTP Range parsing for the `/viewer` byte route.
 *
 * Ported from effect's own `HttpStaticServer` `parseRange`, which is not exported.
 * Ported rather than reinvented because the edge cases are all in the parser and
 * getting them wrong fails badly: an unclamped end makes the platform declare a
 * `content-length` it never sends and hold the socket open indefinitely, and a
 * start past EOF produces a negative content-length that destroys the connection.
 *
 * Deliberately NOT ported: `serveFile`, which evaluates `if-none-match` /
 * `if-modified-since` and can answer 304 before the range branch — a 304 in front
 * of a range request breaks seeking. (The route sends `Cache-Control: no-store`,
 * so a conforming client holds no validator to revalidate with and would not send
 * one anyway; the exclusion is about not adopting the branch, not about a request
 * we expect to see.)
 *
 * @module viewerRange
 */

export interface ViewerByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * `"overflow"` is distinct from `undefined` on purpose.
 *
 * A digit string too large for a safe integer is not malformed — it names a
 * position past any real file, and each of the three positions clamps somewhere
 * different. Collapsing it into `undefined` made every such header fall back to
 * the FULL representation, which quietly defeated the per-response clamp: a
 * `bytes=8-<huge>` on a 500 MB video sent 500 MB instead of a two-byte tail.
 * Upstream #8919's BigInt parser has no such cliff; this keeps `number` and
 * names the overflow instead.
 */
function parseInteger(value: string): number | "overflow" | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : "overflow";
}

/**
 * Parse one byte range against a known file size.
 *
 * `undefined` means "no usable range" — a malformed, multi-range, or wrong-unit
 * header, all of which RFC 9110 permits answering with the full representation.
 * `"unsatisfiable"` means the client named a range this file cannot supply, which
 * is a 416, NOT a full body.
 *
 * `suffix` reports which branch produced the result, because the two clamp in
 * opposite directions. effect's original does not return it.
 */
function parseViewerRange(
  header: string,
  fileSize: number,
): (ViewerByteRange & { readonly suffix: boolean }) | "unsatisfiable" | undefined {
  const value = header.trim();
  if (!value.toLowerCase().startsWith("bytes=")) return undefined;
  const rangeValue = value.slice(6).trim();
  if (rangeValue.length === 0 || rangeValue.includes(",")) return undefined;
  const separatorIndex = rangeValue.indexOf("-");
  if (separatorIndex === -1) return undefined;
  const startPart = rangeValue.slice(0, separatorIndex).trim();
  const endPart = rangeValue.slice(separatorIndex + 1).trim();
  if (startPart === "" && endPart === "") return undefined;

  if (startPart === "") {
    const suffixLength = parseInteger(endPart);
    if (suffixLength === undefined) return undefined;
    if (fileSize === 0 || suffixLength === 0) return "unsatisfiable";
    // A suffix larger than the file is the whole file, not a negative offset.
    if (suffixLength === "overflow") return { start: 0, end: fileSize - 1, suffix: true };
    return { start: Math.max(fileSize - suffixLength, 0), end: fileSize - 1, suffix: true };
  }

  const start = parseInteger(startPart);
  if (start === undefined) return undefined;
  const end = endPart === "" ? "open" : parseInteger(endPart);
  if (end === undefined) return undefined;
  // Syntax before satisfiability. An inverted spec is invalid rather than
  // unsatisfiable (RFC 9110 14.1.1), so the header is ignored and the client
  // gets the whole representation — not a 416 telling it the file is shorter
  // than it asked for.
  // An overflowing start is still larger than any concrete end, so it inverts
  // the spec exactly as a plain `bytes=100-50` does.
  const inverted =
    typeof end === "number" && (start === "overflow" || (typeof start === "number" && start > end));
  if (inverted) return undefined;
  // A start past every real file can never be supplied: 416, not a full body.
  if (start === "overflow" || start >= fileSize) return "unsatisfiable";
  // An end past the file clamps to the last byte, whether it overflowed or not.
  if (end === "open" || end === "overflow") return { start, end: fileSize - 1, suffix: false };
  return { start, end: Math.min(end, fileSize - 1), suffix: false };
}

/**
 * Bound one response to `maxBytes`.
 *
 * A forward range keeps its start and gives up its tail; a suffix range keeps its
 * end and gives up its head, because "the last N bytes" is the whole meaning of
 * the suffix form. A client that wants more comes back for the next range.
 */
function clampViewerRange(
  range: ViewerByteRange,
  suffix: boolean,
  maxBytes: number,
): ViewerByteRange {
  if (range.end - range.start + 1 <= maxBytes) return range;
  return suffix
    ? { start: range.end - maxBytes + 1, end: range.end }
    : { start: range.start, end: range.start + maxBytes - 1 };
}

/** Parse and clamp in one call — what the route uses. */
export function resolveViewerRange(
  header: string | undefined,
  fileSize: number,
  maxBytes: number,
): ViewerByteRange | "unsatisfiable" | undefined {
  if (header === undefined) return undefined;
  const parsed = parseViewerRange(header, fileSize);
  if (parsed === undefined || parsed === "unsatisfiable") return parsed;
  return clampViewerRange({ start: parsed.start, end: parsed.end }, parsed.suffix, maxBytes);
}
