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

function parseInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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
    if (suffixLength === 0 || fileSize === 0) return "unsatisfiable";
    return { start: Math.max(fileSize - suffixLength, 0), end: fileSize - 1, suffix: true };
  }

  const start = parseInteger(startPart);
  if (start === undefined) return undefined;
  if (endPart === "") {
    if (start >= fileSize) return "unsatisfiable";
    return { start, end: fileSize - 1, suffix: false };
  }
  const end = parseInteger(endPart);
  if (end === undefined) return undefined;
  if (start > end || start >= fileSize) return "unsatisfiable";
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
