/**
 * HTTP Range parsing for `/viewer`, ported from effect's unexported `HttpStaticServer` parser: an
 * unclamped end hangs the socket and a start past EOF destroys the connection. Deliberately NOT
 * ported: `serveFile`'s 304 branch, which would answer before the range and break seeking.
 */

export interface ViewerByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * `"overflow"` is distinct from `undefined` on purpose: a digit string too large for a safe integer
 * names a position past any file, and each position clamps differently. Collapsing it made
 * `bytes=8-<huge>` on a 500 MB video send all 500 MB instead of a two-byte tail.
 */
function parseInteger(value: string): number | "overflow" | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : "overflow";
}

/**
 * Parse one byte range against a known file size. `undefined` means no usable range (full body is
 * permitted); `"unsatisfiable"` is a 416, NOT a full body. `suffix` reports which branch produced
 * the result, because the two clamp in opposite directions.
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
  // Syntax before satisfiability: an inverted spec is invalid, not unsatisfiable (RFC 9110 14.1.1),
  // so the client gets the whole representation rather than a 416. An overflowing start inverts
  // the spec exactly as `bytes=100-50` does.
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
