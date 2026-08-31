import { describe, expect, it } from "vite-plus/test";

import { resolveViewerRange } from "./viewerRange.ts";

const SIZE = 3_000_000;
const CAP = 8 * 1024 * 1024;

describe("resolveViewerRange", () => {
  it("returns undefined for headers it will not parse, so the caller serves a full 200", () => {
    expect(resolveViewerRange(undefined, SIZE, CAP)).toBeUndefined();
    expect(resolveViewerRange("items=0-99", SIZE, CAP)).toBeUndefined();
    expect(resolveViewerRange("bytes=abc-def", SIZE, CAP)).toBeUndefined();
    expect(resolveViewerRange("bytes=0-99,200-299", SIZE, CAP)).toBeUndefined();
    expect(resolveViewerRange("bytes=-", SIZE, CAP)).toBeUndefined();
    expect(resolveViewerRange("bytes=0", SIZE, CAP)).toBeUndefined();
  });

  it("parses the three satisfiable forms", () => {
    expect(resolveViewerRange("bytes=0-99", SIZE, CAP)).toEqual({ start: 0, end: 99 });
    expect(resolveViewerRange("bytes=0-", SIZE, CAP)).toEqual({ start: 0, end: SIZE - 1 });
    expect(resolveViewerRange("bytes=-500", SIZE, CAP)).toEqual({
      start: SIZE - 500,
      end: SIZE - 1,
    });
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(resolveViewerRange("BYTES=0-100", SIZE, CAP)).toEqual({ start: 0, end: 100 });
    expect(resolveViewerRange("bytes= 0 - 100 ", SIZE, CAP)).toEqual({ start: 0, end: 100 });
  });

  it("separates a range the file cannot supply from a header it will not parse", () => {
    // Past MAX_SAFE_INTEGER the value is not a byte offset this parser will
    // accept, so it is "no usable range" and the caller serves a full 200 — RFC
    // 9110 permits ignoring a Range, and the rangeless stat cap bounds it. That is
    // deliberately NOT the same answer as a range the file genuinely cannot
    // supply, which must be a 416.
    expect(resolveViewerRange("bytes=9007199254740993-", SIZE, CAP)).toBeUndefined();
    expect(resolveViewerRange(`bytes=${SIZE}-`, SIZE, CAP)).toBe("unsatisfiable");
    expect(resolveViewerRange("bytes=999999999-", SIZE, CAP)).toBe("unsatisfiable");
    expect(resolveViewerRange("bytes=-0", SIZE, CAP)).toBe("unsatisfiable");
    expect(resolveViewerRange("bytes=100-50", SIZE, CAP)).toBe("unsatisfiable");
  });

  it("clamps an over-long forward range by moving end down", () => {
    expect(resolveViewerRange("bytes=0-", SIZE, 1000)).toEqual({ start: 0, end: 999 });
    expect(resolveViewerRange("bytes=0-9999999998", SIZE, 1000)).toEqual({ start: 0, end: 999 });
    expect(resolveViewerRange("bytes=2000-", SIZE, 1000)).toEqual({ start: 2000, end: 2999 });
  });

  // The regression this flag exists for. A suffix range asks for the TAIL;
  // clamping end downward would return the first CAP bytes of the window.
  it("clamps an over-long suffix range by moving start up, keeping the tail", () => {
    expect(resolveViewerRange("bytes=-1000000", SIZE, 1000)).toEqual({
      start: SIZE - 1000,
      end: SIZE - 1,
    });
  });

  it("never clamps a range already within the cap", () => {
    expect(resolveViewerRange("bytes=-500", SIZE, 1000)).toEqual({
      start: SIZE - 500,
      end: SIZE - 1,
    });
  });

  it("handles a zero-length file and a suffix larger than the file", () => {
    expect(resolveViewerRange("bytes=0-", 0, CAP)).toBe("unsatisfiable");
    expect(resolveViewerRange("bytes=-99999999", SIZE, CAP)).toEqual({
      start: 0,
      end: SIZE - 1,
    });
  });
});
