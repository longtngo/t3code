import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { PendingBackgroundWorkTask } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadProjectionFixture } from "../test-fixtures";
import { backgroundPanelTasks, backgroundTaskKindLabel } from "./BackgroundTasksPanel.logic";

const base = makeThreadProjectionFixture();
const NOW = DateTime.makeUnsafe("2026-09-12T12:00:00.000Z");
const instanceId = ProviderInstanceId.make("claude");

function run(status: OrchestrationV2Run["status"]): OrchestrationV2Run {
  return {
    id: RunId.make("run-1"),
    threadId: base.thread.id,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "claude-sonnet-4-6" },
    providerThreadId: null,
    userMessageId: MessageId.make("message-1"),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: NOW,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function providerThread(
  id: string,
  tasks: OrchestrationV2ProviderThread["pendingBackgroundTasks"],
): OrchestrationV2ProviderThread {
  return {
    id: ProviderThreadId.make(id),
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: instanceId,
    providerSessionId: null,
    appThreadId: base.thread.id,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "active",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: tasks,
    contextUsage: null,
    nativeMetadata: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function projection(
  runs: ReadonlyArray<OrchestrationV2Run>,
  providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>,
  activeProviderThreadId: string | null,
): OrchestrationV2ThreadProjection {
  return {
    ...base,
    thread: {
      ...base.thread,
      activeProviderThreadId:
        activeProviderThreadId === null ? null : ProviderThreadId.make(activeProviderThreadId),
    },
    runs,
    providerThreads,
  };
}

const shell = { taskId: "bash-1", description: "npm run dev", kind: "command" } as const;
const watcher = { taskId: "monitor-1", description: "watch CI", kind: "monitor" } as const;

describe("backgroundPanelTasks", () => {
  it("lists the active provider thread's roster while a run is working", () => {
    const tasks = backgroundPanelTasks({
      projection: projection(
        [run("running")],
        [providerThread("pt-old", [watcher]), providerThread("pt-live", [shell, shell])],
        "pt-live",
      ),
      settledTasks: [],
    });
    // Only the active provider thread, deduplicated by task id.
    expect(tasks).toEqual([shell]);
  });

  it("shows exactly the banner's list once the run settles", () => {
    const settled: ReadonlyArray<PendingBackgroundWorkTask> = [watcher];
    const tasks = backgroundPanelTasks({
      projection: projection([run("completed")], [providerThread("pt-live", [shell])], "pt-live"),
      settledTasks: settled,
    });
    expect(tasks).toBe(settled);
  });

  it("is the settled list when there is no projection yet", () => {
    expect(backgroundPanelTasks({ projection: null, settledTasks: [] })).toEqual([]);
  });
});

describe("backgroundTaskKindLabel", () => {
  it("names every kind", () => {
    expect(
      (["subagent", "command", "monitor", "background_task"] as const).map(backgroundTaskKindLabel),
    ).toEqual(["Subagent", "Shell", "Monitor", "Task"]);
  });
});
