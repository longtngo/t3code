import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  THREAD_QUEUE_FAILURE_MESSAGE_MAX_LENGTH,
  THREAD_QUEUE_FAILURE_TITLE_MAX_LENGTH,
  THREAD_QUEUE_ID_MAX_LENGTH,
  THREAD_QUEUE_MAX_ENTRIES,
  THREAD_QUEUE_PRIOR_ID_MAX_LENGTH,
  ThreadQueueEntry,
  ThreadQueueInFlight,
  ThreadQueueSetInput,
  ThreadQueueSetResult,
  ThreadQueueSnapshot,
  ThreadQueueState,
} from "./threadQueue.ts";

const entry = {
  environmentId: "env-1",
  threadId: "thread-1",
  draftId: null,
  addedAt: 1,
  ownerId: "device-a",
  label: "Fix the build",
};
const entryDecodes = (value: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(ThreadQueueEntry)(value));
const inFlightDecodes = (value: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(ThreadQueueInFlight)(value));
const setInputDecodes = (value: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(ThreadQueueSetInput)(value));

describe("ThreadQueueEntry", () => {
  it("requires the device that queued it", () => {
    const { ownerId: _ownerId, ...withoutOwner } = entry;
    expect(entryDecodes(entry)).toBe(true);
    expect(entryDecodes(withoutOwner)).toBe(false);
  });

  it("holds a label of at most 80 characters, or none", () => {
    expect(entryDecodes({ ...entry, label: "x".repeat(80) })).toBe(true);
    expect(entryDecodes({ ...entry, label: "x".repeat(81) })).toBe(false);
    expect(entryDecodes({ ...entry, label: null })).toBe(true);
  });
});

describe("ThreadQueueInFlight", () => {
  const claim = {
    entry,
    claimId: "c",
    claimedAt: 1,
    priorUserMessageAt: null,
    priorTurnId: null,
    priorSessionUpdatedAt: null,
    sentAt: null,
  };

  it("treats sendingAt and handSent as absent keys, not undefined values", () => {
    expect(inFlightDecodes(claim)).toBe(true);
    expect(inFlightDecodes({ ...claim, sendingAt: 2, handSent: true })).toBe(true);
    expect(inFlightDecodes({ ...claim, sendingAt: undefined })).toBe(false);
    expect(inFlightDecodes({ ...claim, handSent: false })).toBe(false);
  });
});

describe("ThreadQueueSetInput", () => {
  const state = { entries: [entry], paused: false, inFlight: null, lastFailure: null };
  it("takes a whole state at a non-negative integer revision", () => {
    expect(setInputDecodes({ bootId: "b", expectedRevision: 0, state })).toBe(true);
    expect(setInputDecodes({ bootId: "b", expectedRevision: -1, state })).toBe(false);
    expect(setInputDecodes({ bootId: "b", expectedRevision: 1.5, state })).toBe(false);
  });
});

const decodes = (schema: Schema.Top, value: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema as Schema.Codec<unknown>)(value));
const claim = {
  entry,
  claimId: "c",
  claimedAt: 1,
  priorUserMessageAt: null,
  priorTurnId: null,
  priorSessionUpdatedAt: null,
  sentAt: null,
};
const failure = { threadKey: "env-1:thread-1", title: "t", message: "m" };
const document = {
  bootId: "b",
  revision: 0,
  entries: [],
  paused: false,
  inFlight: null,
  lastFailure: null,
};

describe("queue numbers are finite", () => {
  it.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN])("rejects %s", (n) => {
    expect(entryDecodes({ ...entry, addedAt: n })).toBe(false);
    expect(inFlightDecodes({ ...claim, claimedAt: n })).toBe(false);
    expect(inFlightDecodes({ ...claim, sentAt: n })).toBe(false);
    expect(inFlightDecodes({ ...claim, sendingAt: n })).toBe(false);
    expect(decodes(ThreadQueueSnapshot, { document, serverTime: n })).toBe(false);
    expect(decodes(ThreadQueueSetResult, { ok: true, document, serverTime: n })).toBe(false);
  });
});

describe("queue document bounds", () => {
  const state = { entries: [], paused: false, inFlight: null, lastFailure: null };
  const id = (length: number) => "x".repeat(length);

  it(`holds at most ${THREAD_QUEUE_MAX_ENTRIES} entries`, () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...entry, threadId: `thread-${i}` }));
    expect(decodes(ThreadQueueState, { ...state, entries: many(THREAD_QUEUE_MAX_ENTRIES) })).toBe(
      true,
    );
    expect(
      decodes(ThreadQueueState, { ...state, entries: many(THREAD_QUEUE_MAX_ENTRIES + 1) }),
    ).toBe(false);
  });

  it.each(["ownerId", "draftId", "environmentId", "threadId"] as const)(
    "bounds an entry's %s",
    (field) => {
      expect(entryDecodes({ ...entry, [field]: id(THREAD_QUEUE_ID_MAX_LENGTH) })).toBe(true);
      expect(entryDecodes({ ...entry, [field]: id(THREAD_QUEUE_ID_MAX_LENGTH + 1) })).toBe(false);
    },
  );

  it.each([
    ["claimId", THREAD_QUEUE_ID_MAX_LENGTH],
    ["priorUserMessageAt", THREAD_QUEUE_PRIOR_ID_MAX_LENGTH],
    ["priorTurnId", THREAD_QUEUE_PRIOR_ID_MAX_LENGTH],
    ["priorSessionUpdatedAt", THREAD_QUEUE_PRIOR_ID_MAX_LENGTH],
  ] as const)("bounds a claim's %s at %i", (field, max) => {
    expect(inFlightDecodes({ ...claim, [field]: id(max) })).toBe(true);
    expect(inFlightDecodes({ ...claim, [field]: id(max + 1) })).toBe(false);
  });

  it.each([
    ["threadKey", THREAD_QUEUE_ID_MAX_LENGTH * 2 + 1],
    ["title", THREAD_QUEUE_FAILURE_TITLE_MAX_LENGTH],
    ["message", THREAD_QUEUE_FAILURE_MESSAGE_MAX_LENGTH],
  ] as const)("bounds a failure's %s at %i", (field, max) => {
    const withField = (length: number) => ({
      ...state,
      lastFailure: { ...failure, [field]: id(length) },
    });
    expect(decodes(ThreadQueueState, withField(max))).toBe(true);
    expect(decodes(ThreadQueueState, withField(max + 1))).toBe(false);
  });

  it("bounds a write's bootId", () => {
    const input = (length: number) => ({ bootId: id(length), expectedRevision: 0, state });
    expect(setInputDecodes(input(THREAD_QUEUE_ID_MAX_LENGTH))).toBe(true);
    expect(setInputDecodes(input(THREAD_QUEUE_ID_MAX_LENGTH + 1))).toBe(false);
  });
});

// An MCP thread id encodes a client request id of up to 256 characters, and a run id encodes
// the thread id again: the longest is several thousand characters, not a few hundred.
describe("queue ids hold the longest ids the server derives", () => {
  const threadId = ["thread", "mcp", "0b5c8a3e-6a7a-4c3e-9f2f-0a1b2c3d4e5f", "0"]
    .toSpliced(3, 0, encodeURIComponent("你".repeat(256)))
    .join(":");
  const runId = ["run", "thread", encodeURIComponent(threadId), "ordinal", "1"].join(":");

  it("queues the thread and claims it with its run id as the prior turn", () => {
    expect(runId.length).toBeGreaterThan(3_000);
    expect(entryDecodes({ ...entry, threadId })).toBe(true);
    expect(inFlightDecodes({ ...claim, entry: { ...entry, threadId }, priorTurnId: runId })).toBe(
      true,
    );
    expect(
      decodes(ThreadQueueState, {
        entries: [],
        paused: false,
        inFlight: null,
        lastFailure: { ...failure, threadKey: `${"e".repeat(36)}:${threadId}` },
      }),
    ).toBe(true);
  });
});

// A delegated-task thread id encodes the command id that made it, and its run id encodes the
// thread id once more, so the run id outgrows the cap every queue id shares.
describe("a claim holds the run id of the longest delegated-task thread", () => {
  const encodeOnce = (parts: ReadonlyArray<string>) =>
    parts.map((part, i) => (i === 0 ? part : encodeURIComponent(part))).join(":");
  const commandFor = (request: string) =>
    encodeOnce(["command", "mcp", "0b5c8a3e-6a7a-4c3e-9f2f-0a1b2c3d4e5f", request, "0"]);
  const threadFor = (request: string) =>
    encodeOnce(["thread", "delegated-task", commandFor(request)]);
  // The longest request whose thread id still fits the entry cap.
  let request = "";
  while (threadFor(`${request}你`).length <= THREAD_QUEUE_ID_MAX_LENGTH) request += "你";
  const threadId = threadFor(request);
  const runId = encodeOnce(["run", "thread", threadId, "ordinal", "1"]);

  it("claims it with its run id as the prior turn", () => {
    expect(runId.length).toBeGreaterThan(THREAD_QUEUE_ID_MAX_LENGTH);
    expect(entryDecodes({ ...entry, threadId })).toBe(true);
    expect(inFlightDecodes({ ...claim, entry: { ...entry, threadId }, priorTurnId: runId })).toBe(
      true,
    );
  });
});
