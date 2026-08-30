import { useEffect, useReducer, useRef } from "react";

/**
 * Assistant text changes on every token chunk, and ChatMarkdown re-runs the
 * whole remark/rehype pipeline over the entire message body each time.
 *
 * Measured against real assistant messages copied out of a live database: a
 * 1.1 KB reply parses in ~1 ms, but a 19 KB one costs ~21 ms per delta -- more
 * than a 60 Hz frame -- and streaming one to completion burns ~1.9 s of main
 * thread. Cost tracks length at roughly 1 ms per 1,000 characters.
 *
 * So coalesce the long ones and leave the short ones exactly as they were:
 * throttling a message that already parses in a millisecond would only make it
 * arrive in visible steps, which is the stutter this is meant to remove.
 */

/** Where a parse first costs about half a frame. Below it there is nothing to save. */
export const STREAMING_PARSE_MIN_CHARS = 4_000;

/**
 * Ten updates a second still reads as streaming text, and holds the parse to
 * roughly a fifth of wall time even at the 21 ms worst case measured.
 */
export const STREAMING_PARSE_INTERVAL_MS = 100;

type StreamingTextInput = {
  readonly incoming: string;
  readonly committed: string;
  readonly isStreaming: boolean;
  readonly now: number;
  readonly committedAt: number;
};

type StreamingTextDecision = {
  /** The text to parse and render on this pass. */
  readonly text: string;
  /** Milliseconds until `incoming` should be rendered, or null if it already is. */
  readonly commitInMs: number | null;
};

/**
 * Decides what a streaming message should render right now. Pure so the timing
 * rules can be tested without a clock or a DOM.
 */
export function decideStreamingText({
  incoming,
  committed,
  isStreaming,
  now,
  committedAt,
}: StreamingTextInput): StreamingTextDecision {
  // A finished message renders exactly, always: the stream ending is itself a
  // commit, so the last delta is never the one left waiting on a timer.
  if (!isStreaming || incoming === committed) {
    return { text: incoming, commitInMs: null };
  }
  if (incoming.length < STREAMING_PARSE_MIN_CHARS) {
    return { text: incoming, commitInMs: null };
  }
  const remaining = STREAMING_PARSE_INTERVAL_MS - (now - committedAt);
  return remaining > 0
    ? { text: committed, commitInMs: remaining }
    : { text: incoming, commitInMs: null };
}

/**
 * Caps how often a long streaming message is re-parsed. Short messages and
 * finished messages pass straight through.
 */
export function useStreamingMarkdownText(incoming: string, isStreaming: boolean): string {
  const committedRef = useRef({ text: incoming, at: 0 });
  const [, commitNow] = useReducer((tick: number) => tick + 1, 0);

  const decision = decideStreamingText({
    incoming,
    committed: committedRef.current.text,
    isStreaming,
    now: Date.now(),
    committedAt: committedRef.current.at,
  });

  // Recorded after the render commits, not during it, and only when the text
  // actually moved -- restamping a held-back render would push the deadline
  // forward on every delta and the message would never catch up.
  useEffect(() => {
    if (decision.text === committedRef.current.text) return;
    committedRef.current = { text: decision.text, at: Date.now() };
  });

  // `commitInMs` counts down toward one fixed deadline, so re-arming it on each
  // delta keeps the same target rather than moving it.
  const { commitInMs } = decision;
  useEffect(() => {
    if (commitInMs === null) return;
    const timer = setTimeout(commitNow, commitInMs);
    return () => {
      clearTimeout(timer);
    };
  }, [commitInMs]);

  return decision.text;
}
