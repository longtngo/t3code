import { describe, expect, it } from "vite-plus/test";

import {
  decideStreamingText,
  STREAMING_PARSE_INTERVAL_MS,
  STREAMING_PARSE_MIN_CHARS,
} from "./streamingMarkdownText";

const long = (extra = 0) => "x".repeat(STREAMING_PARSE_MIN_CHARS + extra);

describe("decideStreamingText", () => {
  it("renders a finished message exactly, however long it is", () => {
    // The stream ending is itself a commit, so the last delta is never the one
    // stranded on a timer.
    expect(
      decideStreamingText({
        incoming: long(9),
        committed: long(),
        isStreaming: false,
        now: 0,
        committedAt: 0,
      }),
    ).toEqual({ text: long(9), commitInMs: null });
  });

  it("passes short streaming messages straight through", () => {
    // These already parse in about a millisecond; delaying them would add the
    // stutter this exists to remove.
    const incoming = "x".repeat(STREAMING_PARSE_MIN_CHARS - 1);
    expect(
      decideStreamingText({ incoming, committed: "x", isStreaming: true, now: 0, committedAt: 0 }),
    ).toEqual({ text: incoming, commitInMs: null });
  });

  it("holds a long streaming message at the last committed text", () => {
    expect(
      decideStreamingText({
        incoming: long(1),
        committed: long(),
        isStreaming: true,
        now: 40,
        committedAt: 0,
      }),
    ).toEqual({ text: long(), commitInMs: STREAMING_PARSE_INTERVAL_MS - 40 });
  });

  it("counts down to one deadline rather than pushing it away", () => {
    // Re-arming on every delta must not starve the commit.
    const at = (now: number) =>
      decideStreamingText({
        incoming: long(1),
        committed: long(),
        isStreaming: true,
        now,
        committedAt: 0,
      }).commitInMs;
    expect(at(10)).toBe(STREAMING_PARSE_INTERVAL_MS - 10);
    expect(at(90)).toBe(STREAMING_PARSE_INTERVAL_MS - 90);
  });

  it("commits once the interval has elapsed", () => {
    expect(
      decideStreamingText({
        incoming: long(1),
        committed: long(),
        isStreaming: true,
        now: STREAMING_PARSE_INTERVAL_MS,
        committedAt: 0,
      }),
    ).toEqual({ text: long(1), commitInMs: null });
  });

  it("does not schedule work when nothing changed", () => {
    expect(
      decideStreamingText({
        incoming: long(),
        committed: long(),
        isStreaming: true,
        now: 1,
        committedAt: 0,
      }),
    ).toEqual({ text: long(), commitInMs: null });
  });
});

describe("throttle effect over a real stream", () => {
  it("cuts long-message parses to the interval, and short ones not at all", () => {
    // 200 deltas over 6s, the shape of a long assistant reply. Measured parse
    // cost of the 19 KB message this models: ~10ms per delta.
    const deltaCount = 200;
    const streamMs = 6_000;
    const run = (finalLength: number) => {
      let committed = "";
      let committedAt = -STREAMING_PARSE_INTERVAL_MS;
      let parses = 0;
      for (let i = 1; i <= deltaCount; i++) {
        const now = (streamMs / deltaCount) * i;
        const incoming = "x".repeat(Math.ceil((finalLength / deltaCount) * i));
        const decision = decideStreamingText({
          incoming,
          committed,
          isStreaming: true,
          now,
          committedAt,
        });
        if (decision.text !== committed) {
          committed = decision.text;
          committedAt = now;
          parses++;
        }
      }
      return parses;
    };

    // A 19 KB reply: only the deltas past the threshold get coalesced.
    expect(run(19_312)).toBeLessThan(100);
    // A 1.1 KB reply never crosses the threshold, so nothing is held back.
    expect(run(1_138)).toBe(deltaCount);
  });
});
