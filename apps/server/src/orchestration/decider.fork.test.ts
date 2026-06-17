import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = asProjectId("project-fork");
const SOURCE_THREAD_ID = asThreadId("thread-fork-src");

let sequence = 0;
const nextSequence = () => {
  sequence += 1;
  return sequence;
};

interface SeedMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming?: boolean;
  readonly providerMessageId?: string;
}

const seedReadModel = (messages: ReadonlyArray<SeedMessage>) =>
  Effect.gen(function* () {
    sequence = 0;
    let model: OrchestrationReadModel = createEmptyReadModel(NOW);
    model = yield* projectEvent(model, {
      sequence: nextSequence(),
      eventId: asEventId("evt-project"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: NOW,
      commandId: asCommandId("cmd-project"),
      causationEventId: null,
      correlationId: asCommandId("cmd-project"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        title: "Fork Project",
        workspaceRoot: "/tmp/fork",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    model = yield* projectEvent(model, {
      sequence: nextSequence(),
      eventId: asEventId("evt-thread"),
      aggregateKind: "thread",
      aggregateId: SOURCE_THREAD_ID,
      type: "thread.created",
      occurredAt: NOW,
      commandId: asCommandId("cmd-thread"),
      causationEventId: null,
      correlationId: asCommandId("cmd-thread"),
      metadata: {},
      payload: {
        threadId: SOURCE_THREAD_ID,
        projectId: PROJECT_ID,
        title: "Source Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-opus",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "auto-accept-edits",
        branch: "feature/x",
        worktreePath: "/tmp/fork/worktree",
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    for (const message of messages) {
      model = yield* projectEvent(model, {
        sequence: nextSequence(),
        eventId: asEventId(`evt-msg-${message.id}`),
        aggregateKind: "thread",
        aggregateId: SOURCE_THREAD_ID,
        type: "thread.message-sent",
        occurredAt: NOW,
        commandId: asCommandId(`cmd-msg-${message.id}`),
        causationEventId: null,
        correlationId: asCommandId(`cmd-msg-${message.id}`),
        metadata: {},
        payload: {
          threadId: SOURCE_THREAD_ID,
          messageId: asMessageId(message.id),
          role: message.role,
          text: message.text,
          turnId: null,
          streaming: message.streaming ?? false,
          ...(message.providerMessageId !== undefined
            ? { providerMessageId: message.providerMessageId }
            : {}),
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
    }
    return model;
  });

const forkCommand = (forkBeforeMessageId?: string) =>
  ({
    type: "thread.fork",
    commandId: asCommandId("cmd-fork"),
    sourceThreadId: SOURCE_THREAD_ID,
    newThreadId: asThreadId("thread-fork-new"),
    ...(forkBeforeMessageId !== undefined
      ? { forkBeforeMessageId: asMessageId(forkBeforeMessageId) }
      : {}),
    title: "Source Thread (fork)",
    createdAt: NOW,
  }) as const;

// Extract keeps the discriminated payload (Omit<union> would collapse it).
type ForkedEvent = Extract<OrchestrationEvent, { type: "thread.forked" }>;

const expectForked = (event: unknown): ForkedEvent => {
  if (Array.isArray(event)) {
    throw new Error("expected a single thread.forked event, got an array");
  }
  const single = event as { type?: unknown };
  if (single.type !== "thread.forked") {
    throw new Error(`expected thread.forked, got ${String(single.type)}`);
  }
  return single as ForkedEvent;
};

it.layer(NodeServices.layer)("decider thread.fork", (it) => {
  it.effect("clones messages before the fork point and carries config 1:1", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel([
        { id: "m1", role: "user", text: "hello" },
        { id: "m2", role: "assistant", text: "hi", providerMessageId: "uuid-a" },
        { id: "m3", role: "user", text: "again" },
      ]);
      const decided = yield* decideOrchestrationCommand({
        command: forkCommand("m3"),
        readModel,
      });
      const forked = expectForked(decided);

      expect(forked.payload.threadId).toBe("thread-fork-new");
      expect(forked.payload.sourceThreadId).toBe(SOURCE_THREAD_ID);
      expect(forked.payload.projectId).toBe(PROJECT_ID);
      expect(forked.payload.title).toBe("Source Thread (fork)");
      // 1:1 config carry-over.
      expect(forked.payload.modelSelection.model).toBe("claude-opus");
      expect(forked.payload.runtimeMode).toBe("auto-accept-edits");
      expect(forked.payload.branch).toBe("feature/x");
      expect(forked.payload.worktreePath).toBe("/tmp/fork/worktree");
      // Only messages strictly before m3 are cloned.
      expect(forked.payload.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
      // Precise anchor available -> not approximate.
      expect(forked.payload.forkContextApproximate).toBe(false);
      expect(forked.payload.forkResume).toMatchObject({
        fork: true,
        sourceThreadId: SOURCE_THREAD_ID,
        resumeSessionAt: "uuid-a",
      });

      // Projecting the event materializes an independent new thread.
      const projected = yield* projectEvent(readModel, { ...forked, sequence: nextSequence() });
      const newThread = projected.threads.find((thread) => thread.id === "thread-fork-new");
      expect(newThread?.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
      expect(newThread?.session).toBeNull();
      expect(newThread?.pendingForkResume).toMatchObject({ fork: true });
      // Original thread is untouched.
      const source = projected.threads.find((thread) => thread.id === SOURCE_THREAD_ID);
      expect(source?.messages.map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
    }),
  );

  it.effect("flags approximate context when no provider anchor is present", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel([
        { id: "m1", role: "user", text: "hello" },
        { id: "m2", role: "assistant", text: "hi" },
        { id: "m3", role: "user", text: "again" },
      ]);
      const forked = expectForked(
        yield* decideOrchestrationCommand({ command: forkCommand("m3"), readModel }),
      );
      expect(forked.payload.forkContextApproximate).toBe(true);
      expect(forked.payload.forkResume).toMatchObject({ fork: true });
      expect((forked.payload.forkResume as { resumeSessionAt?: string }).resumeSessionAt).toBe(
        undefined,
      );
    }),
  );

  it.effect("forks the entire session (no forkBeforeMessageId) with full, precise context", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel([
        { id: "m1", role: "user", text: "hello" },
        { id: "m2", role: "assistant", text: "hi" },
        { id: "m3", role: "user", text: "again" },
        { id: "m4", role: "assistant", text: "sure" },
      ]);
      const forked = expectForked(
        yield* decideOrchestrationCommand({ command: forkCommand(), readModel }),
      );
      // Every message is cloned, first to last.
      expect(forked.payload.messages.map((message) => message.id)).toEqual(["m1", "m2", "m3", "m4"]);
      // Whole-session fork carries the full parent context ⇒ not approximate.
      expect(forked.payload.forkContextApproximate).toBe(false);
      expect(forked.payload.forkResume).toMatchObject({ fork: true });
    }),
  );

  it.effect("refuses a whole-session fork while the final message is streaming", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel([
        { id: "m1", role: "user", text: "hello" },
        { id: "m2", role: "assistant", text: "partial", streaming: true },
      ]);
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: forkCommand(), readModel }),
      );
      expect(error.message).toContain("still streaming");
    }),
  );

  it.effect("forking before the first message yields an empty, fresh thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel([
        { id: "m1", role: "user", text: "hello" },
        { id: "m2", role: "assistant", text: "hi" },
      ]);
      const forked = expectForked(
        yield* decideOrchestrationCommand({ command: forkCommand("m1"), readModel }),
      );
      expect(forked.payload.messages).toEqual([]);
      expect(forked.payload.forkContextApproximate).toBe(false);
      expect(forked.payload.forkResume).toBe(undefined);
    }),
  );

  it.effect("refuses to fork while the last cloned message is still streaming", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel([
        { id: "m1", role: "user", text: "hello" },
        { id: "m2", role: "assistant", text: "partial", streaming: true },
        { id: "m3", role: "user", text: "again" },
      ]);
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: forkCommand("m3"), readModel }),
      );
      expect(error.message).toContain("still streaming");
    }),
  );

  it.effect("rejects forking before a non-existent message", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel([{ id: "m1", role: "user", text: "hello" }]);
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: forkCommand("does-not-exist"), readModel }),
      );
      expect(error.message).toContain("does not exist");
    }),
  );
});
