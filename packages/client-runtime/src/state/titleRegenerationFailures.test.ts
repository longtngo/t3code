import { describe, expect, it } from "vite-plus/test";

import { shouldReportTitleRegenerationFailure } from "./titleRegenerationFailures.ts";

describe("shouldReportTitleRegenerationFailure", () => {
  // The value is persisted, so a thread arriving in the first snapshot can
  // carry a failure from days ago. Reporting on first observation would toast
  // history on every page load.
  it("stays silent the first time a thread is observed", () => {
    expect(
      shouldReportTitleRegenerationFailure({
        observedBefore: false,
        previousFailedAt: null,
        failedAt: "2026-08-16T12:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("reports a failure that appeared since the last observation", () => {
    expect(
      shouldReportTitleRegenerationFailure({
        observedBefore: true,
        previousFailedAt: null,
        failedAt: "2026-08-16T12:00:00.000Z",
      }),
    ).toBe(true);
  });

  // Unrelated updates re-emit the thread shell; the same failure must not
  // toast again on every one of them.
  it("stays silent while the same failure is still on the thread", () => {
    expect(
      shouldReportTitleRegenerationFailure({
        observedBefore: true,
        previousFailedAt: "2026-08-16T12:00:00.000Z",
        failedAt: "2026-08-16T12:00:00.000Z",
      }),
    ).toBe(false);
  });

  // A timestamp rather than a boolean is what makes this case reportable.
  it("reports a second failure after a first one", () => {
    expect(
      shouldReportTitleRegenerationFailure({
        observedBefore: true,
        previousFailedAt: "2026-08-16T12:00:00.000Z",
        failedAt: "2026-08-16T12:05:00.000Z",
      }),
    ).toBe(true);
  });

  it("stays silent when a retry cleared the failure", () => {
    expect(
      shouldReportTitleRegenerationFailure({
        observedBefore: true,
        previousFailedAt: "2026-08-16T12:00:00.000Z",
        failedAt: null,
      }),
    ).toBe(false);
  });
});
