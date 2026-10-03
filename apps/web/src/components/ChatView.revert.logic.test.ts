import {
  MessageId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import { claimThreadRewind, countRevertDiscardedMessages } from "./ChatView.logic";
import { makeThreadProjectionFixture } from "../test-fixtures";

const base = makeThreadProjectionFixture();
const NOW = DateTime.makeUnsafe("2026-09-12T12:00:00.000Z");
const instanceId = ProviderInstanceId.make("claude");

function run(ordinal: number, status: OrchestrationV2Run["status"] = "completed") {
  return {
    id: RunId.make(`run-${ordinal}`),
    threadId: base.thread.id,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "claude-sonnet-4-6" },
    providerThreadId: null,
    userMessageId: MessageId.make(`user-${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: NOW,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  } satisfies OrchestrationV2Run;
}

function message(id: string, runOrdinal: number | null, role: "user" | "assistant") {
  return {
    createdBy: "user",
    creationSource: "web",
    id: MessageId.make(id),
    threadId: base.thread.id,
    runId: runOrdinal === null ? null : RunId.make(`run-${runOrdinal}`),
    nodeId: null,
    role,
    text: id,
    attachments: [],
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  } satisfies OrchestrationV2ConversationMessage;
}

describe("countRevertDiscardedMessages", () => {
  // Three runs of one user + one assistant message each, plus a run-less notice.
  const projection = {
    runs: [run(1), run(2), run(3)],
    messages: [
      message("user-1", 1, "user"),
      message("reply-1", 1, "assistant"),
      message("user-2", 2, "user"),
      message("reply-2", 2, "assistant"),
      message("notice", null, "assistant"),
      message("user-3", 3, "user"),
      message("reply-3", 3, "assistant"),
    ],
  };

  it("counts every message of the runs the rewind rolls back, the edited one included", () => {
    // "Edit from here" on run 2's message rewinds to turn count 1.
    expect(countRevertDiscardedMessages(projection, 1)).toBe(4);
    expect(countRevertDiscardedMessages(projection, 0)).toBe(6);
    expect(countRevertDiscardedMessages(projection, 3)).toBe(0);
  });

  it("does not count runs an earlier rewind already removed", () => {
    expect(
      countRevertDiscardedMessages(
        { ...projection, runs: [run(1), run(2), run(3, "rolled_back")] },
        1,
      ),
    ).toBe(2);
    expect(countRevertDiscardedMessages(null, 0)).toBe(0);
  });

  it("does not count a queued run, which the rewind leaves in place", () => {
    expect(
      countRevertDiscardedMessages({ ...projection, runs: [run(1), run(2), run(3, "queued")] }, 1),
    ).toBe(2);
  });
});

describe("claimThreadRewind", () => {
  afterEach(() => {
    useComposerDraftStore.setState({ rewindingThreadKeys: new Set() });
  });

  it("lets exactly one of two back-to-back confirmations start a rewind", () => {
    expect(claimThreadRewind("env:thread-a")).toBe(true);
    expect(claimThreadRewind("env:thread-a")).toBe(false);
    // Another thread's rewind is independent.
    expect(claimThreadRewind("env:thread-b")).toBe(true);
    expect(useComposerDraftStore.getState().rewindingThreadKeys).toEqual(
      new Set(["env:thread-a", "env:thread-b"]),
    );
  });
});
