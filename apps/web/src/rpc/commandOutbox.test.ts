import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  MAX_QUEUED_TURNS,
  type QueuedTurn,
  enqueueTurn,
  expireQueuedTurns,
  flushOutbox,
  getQueuedTurns,
  hasQueuedTurnForThread,
  sanitizeRehydratedQueue,
  removeQueuedTurn,
} from "./commandOutbox";

function queuedTurn(commandId: string, threadId = "t1"): QueuedTurn {
  return {
    environmentId: "env-1" as never,
    threadId: threadId as never,
    messageId: `m-${commandId}` as never,
    commandId,
    input: {
      threadId,
      commandId,
      createdAt: "2026-08-02T00:00:00.000Z",
      message: { messageId: `m-${commandId}`, role: "user", text: "hi", attachments: [] },
    },
    enqueuedAt: "2026-08-02T00:00:00.000Z",
  };
}

beforeEach(() => {
  for (const turn of getQueuedTurns()) removeQueuedTurn(turn.commandId);
});

describe("commandOutbox", () => {
  it("ignores a re-enqueue of the same commandId (defence against a replay race)", () => {
    enqueueTurn(queuedTurn("a"));
    enqueueTurn(queuedTurn("a"));
    expect(getQueuedTurns()).toHaveLength(1);
  });

  it("removes a single queued turn by commandId", () => {
    enqueueTurn(queuedTurn("a"));
    enqueueTurn(queuedTurn("b"));
    removeQueuedTurn("a");
    expect(getQueuedTurns().map((turn) => turn.commandId)).toEqual(["b"]);
  });

  it("flushes oldest-first and dequeues each success", async () => {
    enqueueTurn(queuedTurn("a"));
    enqueueTurn(queuedTurn("b"));
    const sent: string[] = [];
    await flushOutbox(async (turn) => {
      sent.push(turn.commandId);
    });
    expect(sent).toEqual(["a", "b"]);
    expect(getQueuedTurns()).toHaveLength(0);
  });

  it("replays the SAME commandId so the server can dedupe", async () => {
    enqueueTurn(queuedTurn("stable-id"));
    const seen: string[] = [];
    // First flush drops the connection; the turn stays queued for the retry.
    await flushOutbox(async () => {
      throw new Error("SocketCloseError: connection reset");
    });
    expect(getQueuedTurns()).toHaveLength(1);
    await flushOutbox(async (turn) => {
      seen.push(String(turn.input.commandId));
    });
    expect(seen).toEqual(["stable-id"]);
  });

  it("keeps the rest of a failing environment queued and in order", async () => {
    enqueueTurn(queuedTurn("a"));
    enqueueTurn(queuedTurn("b"));
    const sent: string[] = [];
    await flushOutbox(async (turn) => {
      sent.push(turn.commandId);
      if (turn.commandId === "a") throw new Error("SocketCloseError: connection reset");
    });
    // "b" shares the blocked environment, so it must NOT jump ahead of "a".
    expect(sent).toEqual(["a"]);
    expect(getQueuedTurns().map((turn) => turn.commandId)).toEqual(["a", "b"]);
  });

  it("still drains other environments when one is unreachable", async () => {
    enqueueTurn({ ...queuedTurn("a"), environmentId: "env-down" as never });
    enqueueTurn({ ...queuedTurn("b"), environmentId: "env-up" as never });
    const sent: string[] = [];
    await flushOutbox(async (turn) => {
      if (turn.environmentId === "env-down") {
        throw new Error("SocketCloseError: connection reset");
      }
      sent.push(turn.commandId);
    });
    expect(sent).toEqual(["b"]);
    expect(getQueuedTurns().map((turn) => turn.commandId)).toEqual(["a"]);
  });

  it("removes the sent turn by identity, not by position", async () => {
    enqueueTurn(queuedTurn("a"));
    await flushOutbox(async () => {
      // A concurrent clear + enqueue during the in-flight send puts a DIFFERENT,
      // unsent turn at index 0; a positional dequeue would delete it.
      for (const turn of getQueuedTurns()) removeQueuedTurn(turn.commandId);
      enqueueTurn(queuedTurn("c"));
    });
    expect(getQueuedTurns().map((turn) => turn.commandId)).toEqual(["c"]);
  });

  it("refuses to queue past the cap so the composer keeps the text", () => {
    for (let index = 0; index < MAX_QUEUED_TURNS; index += 1) {
      expect(enqueueTurn(queuedTurn(`turn-${index}`))).toBe(true);
    }
    expect(enqueueTurn(queuedTurn("overflow"))).toBe(false);
    expect(getQueuedTurns()).toHaveLength(MAX_QUEUED_TURNS);
  });

  it("drops a terminally-failed turn so it cannot wedge the queue", async () => {
    enqueueTurn(queuedTurn("bad"));
    enqueueTurn(queuedTurn("good"));
    const terminal: string[] = [];
    const sent: string[] = [];
    await flushOutbox(
      async (turn) => {
        sent.push(turn.commandId);
        if (turn.commandId === "bad") throw new Error("Thread not found.");
      },
      { onTerminalError: (turn) => terminal.push(turn.commandId) },
    );
    expect(terminal).toEqual(["bad"]);
    expect(sent).toEqual(["bad", "good"]);
    expect(getQueuedTurns()).toHaveLength(0);
  });

  it("is a no-op when the queue is empty", async () => {
    let calls = 0;
    await flushOutbox(async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });
});

describe("sanitizeRehydratedQueue", () => {
  const fresh = queuedTurn("fresh");

  it("returns an empty queue for non-array or corrupt persisted values", () => {
    // A corrupt entry previously set `queue` to a non-array and threw at the app root.
    expect(sanitizeRehydratedQueue(null)).toEqual([]);
    expect(sanitizeRehydratedQueue("nope")).toEqual([]);
    expect(sanitizeRehydratedQueue(undefined)).toEqual([]);
  });

  it("drops entries missing required fields", () => {
    expect(sanitizeRehydratedQueue([{ commandId: "a" }, fresh])).toEqual([fresh]);
  });

  it("drops entries with an unparseable enqueue time", () => {
    expect(sanitizeRehydratedQueue([{ ...fresh, enqueuedAt: "nonsense" }])).toEqual([]);
  });

  it("KEEPS aged-out entries so expiry can be reported instead of silent", () => {
    // Rehydrate runs before any UI exists; dropping here would destroy the
    // message with no toast and no draft to fall back on.
    const stale = { ...queuedTurn("stale"), enqueuedAt: new Date(0).toISOString() };
    expect(sanitizeRehydratedQueue([stale])).toEqual([stale]);
  });
});

describe("expireQueuedTurns", () => {
  it("removes and returns aged-out turns, leaving fresh ones queued", () => {
    const fresh = queuedTurn("fresh");
    const stale = { ...queuedTurn("stale"), enqueuedAt: new Date(0).toISOString() };
    enqueueTurn(stale);
    enqueueTurn(fresh);

    const expired = expireQueuedTurns(Date.parse(fresh.enqueuedAt) + 1000);

    expect(expired.map((turn) => turn.commandId)).toEqual(["stale"]);
    expect(getQueuedTurns().map((turn) => turn.commandId)).toEqual(["fresh"]);
  });
});

describe("hasQueuedTurnForThread", () => {
  it("reports whether a thread already has a turn waiting", () => {
    expect(hasQueuedTurnForThread("t1" as never)).toBe(false);
    enqueueTurn(queuedTurn("a", "t1"));
    expect(hasQueuedTurnForThread("t1" as never)).toBe(true);
    expect(hasQueuedTurnForThread("t2" as never)).toBe(false);
  });
});
