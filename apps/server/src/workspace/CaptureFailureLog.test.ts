import { describe, expect, it } from "@effect/vitest";

import {
  CAPTURE_FAILED,
  DIFF_SUMMARY_UNAVAILABLE,
  UNREADABLE_MEMBERS,
  makeCaptureFailureLog,
} from "./CaptureFailureLog.ts";

const THREAD = "thread-1";
const OTHER = "thread-2";

describe("CaptureFailureLog", () => {
  it("reports a standing failure once", () => {
    const log = makeCaptureFailureLog();
    const report = () =>
      log.shouldReport({ threadId: THREAD, summary: UNREADABLE_MEMBERS, detail: "prm" });

    expect(report()).toBe(true);
    expect(report()).toBe(false);
    expect(report()).toBe(false);
  });

  it("reports again when the same kind names something different", () => {
    const log = makeCaptureFailureLog();

    expect(log.shouldReport({ threadId: THREAD, summary: UNREADABLE_MEMBERS, detail: "prm" })).toBe(
      true,
    );
    expect(
      log.shouldReport({ threadId: THREAD, summary: UNREADABLE_MEMBERS, detail: "prm, unimap" }),
    ).toBe(true);
  });

  // The case a single slot per thread gets wrong: each kind looks new because the other
  // evicted it, so both are reported on every turn.
  it("keeps two standing kinds apart instead of letting them evict each other", () => {
    const log = makeCaptureFailureLog();
    const both = () => [
      log.shouldReport({ threadId: THREAD, summary: DIFF_SUMMARY_UNAVAILABLE, detail: "no diff" }),
      log.shouldReport({ threadId: THREAD, summary: UNREADABLE_MEMBERS, detail: "prm" }),
    ];

    expect(both()).toEqual([true, true]);
    expect(both()).toEqual([false, false]);
    expect(both()).toEqual([false, false]);
  });

  it("reports a kind again once it has been forgotten, and only that kind", () => {
    const log = makeCaptureFailureLog();
    log.shouldReport({ threadId: THREAD, summary: DIFF_SUMMARY_UNAVAILABLE, detail: "no diff" });
    log.shouldReport({ threadId: THREAD, summary: UNREADABLE_MEMBERS, detail: "prm" });

    log.forget(THREAD, UNREADABLE_MEMBERS);

    expect(log.shouldReport({ threadId: THREAD, summary: UNREADABLE_MEMBERS, detail: "prm" })).toBe(
      true,
    );
    expect(
      log.shouldReport({ threadId: THREAD, summary: DIFF_SUMMARY_UNAVAILABLE, detail: "no diff" }),
    ).toBe(false);
  });

  it("keeps threads apart", () => {
    const log = makeCaptureFailureLog();

    expect(log.shouldReport({ threadId: THREAD, summary: CAPTURE_FAILED, detail: "boom" })).toBe(
      true,
    );
    expect(log.shouldReport({ threadId: OTHER, summary: CAPTURE_FAILED, detail: "boom" })).toBe(
      true,
    );
    expect(log.shouldReport({ threadId: THREAD, summary: CAPTURE_FAILED, detail: "boom" })).toBe(
      false,
    );

    log.forget(THREAD, CAPTURE_FAILED);
    expect(log.shouldReport({ threadId: OTHER, summary: CAPTURE_FAILED, detail: "boom" })).toBe(
      false,
    );
  });

  it("forgetting a kind a thread never stood in changes nothing", () => {
    const log = makeCaptureFailureLog();
    log.forget(THREAD, CAPTURE_FAILED);

    expect(log.shouldReport({ threadId: THREAD, summary: CAPTURE_FAILED, detail: "boom" })).toBe(
      true,
    );
  });
});
