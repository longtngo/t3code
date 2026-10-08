import { EnvironmentId, THREAD_QUEUE_MAX_ENTRIES, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "./composerDraftStore";
import {
  applyQueueAction,
  EMPTY_QUEUE_DATA,
  queueEntryLabel,
  resolveThreadQueueMode,
  type QueueAction,
  type ThreadQueueData,
  type ThreadQueueEntry,
} from "./threadQueueRules";

const env = EnvironmentId.make("env-1");
const entry = (id: string, draftId: string | null = null): ThreadQueueEntry => ({
  environmentId: env,
  threadId: ThreadId.make(id),
  draftId: draftId === null ? null : DraftId.make(draftId),
  addedAt: 1,
  ownerId: "device-a",
  label: id,
});
const prior = { userMessageAt: null, turnId: null, sessionUpdatedAt: null };
const claimOf = (state: ThreadQueueData, key: string, claimId: string, now = 10) =>
  applyQueueAction(state, {
    kind: "claim",
    key,
    claimId,
    now,
    resolve: (e) => ({ entry: e, prior }),
  });
const queued: ThreadQueueData = {
  ...EMPTY_QUEUE_DATA,
  entries: [entry("A"), entry("B", "draft-B"), entry("C")],
};
const claimed = claimOf(queued, "env-1:A", "c1");
const claimedB = claimOf(queued, "env-1:B", "c1");
const handSent = applyQueueAction(claimed, {
  kind: "remove-sent",
  threadKey: "env-1:A",
  draftId: null,
  now: 15,
});

const failure = { threadKey: "env-1:A", title: "A", message: "boom" };

// Every action is a no-op when re-run on a document that already contains it.
describe("applyQueueAction is idempotent", () => {
  const cases: ReadonlyArray<readonly [string, ThreadQueueData, QueueAction]> = [
    ["enqueue", queued, { kind: "enqueue", entry: entry("D") }],
    ["enqueue at an index", queued, { kind: "enqueue", entry: entry("C"), index: 0 }],
    ["remove", queued, { kind: "remove", keys: ["env-1:B"] }],
    [
      "remove-sent by draft",
      queued,
      { kind: "remove-sent", threadKey: "env-2:x", draftId: DraftId.make("draft-B"), now: 15 },
    ],
    [
      "remove-sent taking over a claim by thread",
      claimed,
      { kind: "remove-sent", threadKey: "env-1:A", draftId: null, now: 15 },
    ],
    [
      "remove-sent taking over a claim by draft",
      claimedB,
      { kind: "remove-sent", threadKey: "env-2:x", draftId: DraftId.make("draft-B"), now: 15 },
    ],
    ["set-paused", queued, { kind: "set-paused", paused: true }],
    [
      "resume",
      { ...queued, paused: true, lastFailure: failure },
      { kind: "set-paused", paused: false, seenFailure: failure },
    ],
    [
      "claim",
      queued,
      {
        kind: "claim",
        key: "env-1:A",
        claimId: "c1",
        now: 10,
        resolve: (e) => ({ entry: e, prior }),
      },
    ],
    ["mark-sending", claimed, { kind: "mark-sending", claimId: "c1", now: 12 }],
    ["mark-sent", claimed, { kind: "mark-sent", claimId: "c1", now: 20 }],
    ["mark-sent on a hand-sent claim", handSent, { kind: "mark-sent", claimId: "c1", now: 20 }],
    ["release-hand-sent", handSent, { kind: "release-hand-sent", claimId: "c1" }],
    ["clear-in-flight", claimed, { kind: "clear-in-flight", claimId: "c1" }],
    [
      "clear-in-flight if unsent",
      claimed,
      { kind: "clear-in-flight", claimId: "c1", ifUnsent: true },
    ],
    [
      "fail",
      claimed,
      {
        kind: "fail",
        claimId: "c1",
        failure: { threadKey: "env-1:A", title: "A", message: "boom" },
      },
    ],
  ];
  it.each(cases)("%s", (_name, state, action) => {
    const once = applyQueueAction(state, action);
    expect(applyQueueAction(once, action)).toEqual(once);
  });

  it("a second claim never replaces a held one, and a re-sent markSent keeps the first time", () => {
    expect(claimOf(claimed, "env-1:C", "c2", 11)).toBe(claimed);
    const sent = applyQueueAction(claimed, { kind: "mark-sent", claimId: "c1", now: 20 });
    expect(
      applyQueueAction(sent, { kind: "mark-sent", claimId: "c1", now: 99 }).inFlight?.sentAt,
    ).toBe(20);
  });

  it("a paused queue refuses a claim, so a pause written first beats a claim decided before it", () => {
    const paused = { ...queued, paused: true };
    expect(claimOf(paused, "env-1:A", "c1")).toBe(paused);
  });

  it("adds nothing past the document's entry cap, but still moves a queued entry", () => {
    const full: ThreadQueueData = {
      ...EMPTY_QUEUE_DATA,
      entries: Array.from({ length: THREAD_QUEUE_MAX_ENTRIES }, (_, i) => entry(`T${i}`)),
    };
    expect(applyQueueAction(full, { kind: "enqueue", entry: entry("new") })).toBe(full);
    const moved = applyQueueAction(full, { kind: "enqueue", entry: entry("T9"), index: 0 });
    expect(moved.entries[0]?.threadId).toBe("T9");
  });

  // A reorder re-run after another device claimed or removed the entry must not bring it back.
  it("a reorder never adds an entry that is no longer queued", () => {
    expect(applyQueueAction(claimed, { kind: "enqueue", entry: entry("A"), index: 1 })).toBe(
      claimed,
    );
  });

  // An abandon that lost a race to the owner's mark-sent must not free the slot early.
  it("an abandon clears only a claim that is still unsent", () => {
    const sent = applyQueueAction(claimed, { kind: "mark-sent", claimId: "c1", now: 20 });
    const abandon: QueueAction = { kind: "clear-in-flight", claimId: "c1", ifUnsent: true };
    expect(applyQueueAction(sent, abandon)).toBe(sent);
    expect(applyQueueAction(claimed, abandon).inFlight).toBeNull();
    expect(applyQueueAction(sent, { kind: "clear-in-flight", claimId: "c1" }).inFlight).toBeNull();
  });

  it("a claim takes the entry out of the queue in the same step", () => {
    expect(claimed.entries.map((e) => e.threadId)).toEqual(["B", "C"]);
    expect(claimed.inFlight).toMatchObject({ claimId: "c1", claimedAt: 10, sentAt: null });
  });
});

describe("hand sends", () => {
  it("a sending mark needs this claim, unstarted and unsent", () => {
    expect(applyQueueAction(claimed, { kind: "mark-sending", claimId: "c2", now: 12 })).toBe(
      claimed,
    );
    expect(applyQueueAction(handSent, { kind: "mark-sending", claimId: "c1", now: 12 })).toBe(
      handSent,
    );
  });
});

describe("fail", () => {
  const failure = { threadKey: "env-1:A", title: "A", message: "boom" };
  it("clears its own claim and always pauses with the reason", () => {
    expect(applyQueueAction(claimed, { kind: "fail", claimId: "c1", failure })).toMatchObject({
      inFlight: null,
      paused: true,
      lastFailure: failure,
    });
    const other = applyQueueAction(claimed, { kind: "fail", claimId: "c2", failure });
    expect(other).toMatchObject({ paused: true, lastFailure: failure });
    expect(other.inFlight).toBe(claimed.inFlight);
  });
});

describe("resume", () => {
  const resume = (state: ThreadQueueData, seenFailure: typeof failure | null) =>
    applyQueueAction(state, { kind: "set-paused", paused: false, seenFailure });
  const pausedBy = (lastFailure: typeof failure | null): ThreadQueueData => ({
    ...queued,
    paused: true,
    lastFailure,
  });

  it("clears the failure it was shown", () => {
    expect(resume(pausedBy(failure), { ...failure })).toMatchObject({
      paused: false,
      lastFailure: null,
    });
  });

  // The failure has no id: thread, title and message together name it.
  it.each([
    ["thread", { ...failure, threadKey: "env-1:B" }],
    ["title", { ...failure, title: "B" }],
    ["message", { ...failure, message: "other" }],
    ["none shown", null],
  ] as const)("keeps a failure that differs from the one shown by its %s", (_field, newer) => {
    const state = pausedBy(newer === null ? failure : newer);
    expect(resume(state, newer === null ? null : failure)).toBe(state);
  });

  it("resumes a queue paused by hand after the failure it was shown was cleared", () => {
    expect(resume(pausedBy(null), failure)).toMatchObject({ paused: false, lastFailure: null });
  });
});

describe("queueEntryLabel", () => {
  it("keeps the first line, trimmed, at most 80 characters, or nothing", () => {
    expect(queueEntryLabel("  Fix the build\nthen deploy ")).toBe("Fix the build");
    expect(queueEntryLabel("x".repeat(200))).toHaveLength(80);
    expect(queueEntryLabel("   ")).toBeNull();
    expect(queueEntryLabel(undefined)).toBeNull();
  });
});

// Never server mode on a cached config or without the capability; a failed discovery is pending.
describe("resolveThreadQueueMode", () => {
  const live = {
    noPrimary: false,
    configSource: "live",
    capability: true,
    connected: true,
    liveDocument: true,
  } as const;
  it("is local only on a positive no-primary or a live config without the capability", () => {
    expect(resolveThreadQueueMode({ ...live, noPrimary: true, configSource: null })).toBe("local");
    expect(resolveThreadQueueMode({ ...live, capability: false })).toBe("local");
  });
  it("is pending on a cached config, a failed discovery, a disconnect, or before the first document", () => {
    expect(resolveThreadQueueMode({ ...live, configSource: "cache" })).toBe("pending");
    expect(resolveThreadQueueMode({ ...live, configSource: "cache", capability: false })).toBe(
      "pending",
    );
    expect(resolveThreadQueueMode({ ...live, configSource: null })).toBe("pending");
    expect(resolveThreadQueueMode({ ...live, connected: false })).toBe("pending");
    expect(resolveThreadQueueMode({ ...live, liveDocument: false })).toBe("pending");
  });
  it("is server once connected with a live document", () => {
    expect(resolveThreadQueueMode(live)).toBe("server");
  });
});
