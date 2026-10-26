import * as DocumentText from "../provider/DocumentText.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  GuestMessageId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type UserInputAttachments,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  createAttachmentId,
  createPendingAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorDispatchError,
} from "./Orchestrator.ts";
import { creditSpendIntakeAllowAll } from "./ProviderTurnStartService.testkit.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { dispatchCommand, launchThread } from "./ThreadMessageIntake.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import { CreditSpendGuard } from "../provider/Services/CreditSpendGuard.ts";

const layerIntakeTest = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-question-intake-",
}).pipe(
  Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  Layer.provideMerge(creditSpendIntakeAllowAll),
  Layer.provideMerge(ServerSettings.layerTest()),
);

const layerFailingDispatchHandler =
  (captured: OrchestrationV2ServerCommand[]) => (command: OrchestrationV2ServerCommand) => {
    captured.push(command);
    return Effect.fail(
      new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Stop after intake",
      }),
    );
  };

const layerFailingDispatch = (captured: OrchestrationV2ServerCommand[]) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    dispatch: layerFailingDispatchHandler(captured),
  });

const NOW = DateTime.makeUnsafe("2026-09-13T00:00:00.000Z");

const answeredRespondEvents = (input: {
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly attachmentsByQuestionId: UserInputAttachments;
}): OrchestrationV2StoredEvent[] => [
  {
    sequence: 1,
    commandId: null,
    event: {
      id: EventId.make("evt-recorded-answer"),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: NOW,
      payload: {
        id: TurnItemId.make("item-recorded-answer"),
        type: "user_input_request",
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: NOW,
        updatedAt: NOW,
        requestId: RuntimeRequestId.make(input.requestId),
        questions: [],
        questionAnswer: {
          requestId: input.requestId,
          answers: {},
          attachmentsByQuestionId: input.attachmentsByQuestionId,
        },
      },
    },
  },
];

it.effect("claims question uploads and passes readable paths through the V2 request command", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const id = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${id}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-1"),
      threadId: ThreadId.make("thread-answer"),
      requestId: RuntimeRequestId.make("request-1"),
      answers: { q: ["Selected option"] },
      attachmentsByQuestionId: {
        q: [{ type: "image", id, name: "screen.png", mimeType: "image/png", sizeBytes: 3 }],
      },
    }).pipe(Effect.provide(layerFailingDispatch(captured)), Effect.result);
    expect(captured).toHaveLength(1);
    const command = captured[0]!;
    expect(command.type).toBe("runtime-request.respond");
    if (command.type !== "runtime-request.respond") return;
    const attachment = command.attachmentsByQuestionId?.q?.[0];
    expect(attachment).toBeDefined();
    const path = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: attachment!,
    });
    expect(path).not.toBeNull();
    expect(NodeFS.readFileSync(path!)).toEqual(Buffer.from([1, 2, 3]));
    expect(command.answers?.q).toEqual([
      "Selected option",
      `Attached image "screen.png": "${path}"`,
    ]);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("retains claimed copies when dispatch failure may have been accepted", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-ambiguous"),
      threadId: ThreadId.make("thread-ambiguous"),
      requestId: RuntimeRequestId.make("request-ambiguous"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(Effect.provide(layerFailingDispatch(captured)), Effect.result);
    expect(result._tag).toBe("Failure");
    expect(captured).toHaveLength(1);
    const threadFiles = NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
      entry.startsWith("thread-ambiguous-"),
    );
    expect(threadFiles).toHaveLength(1);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when the command was already rejected", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-rejected"),
      threadId: ThreadId.make("thread-rejected"),
      requestId: RuntimeRequestId.make("request-rejected"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: (command) =>
            Effect.fail(
              new OrchestratorCommandPreviouslyRejectedError({
                commandId: command.commandId,
                commandType: command.type,
                detail: "rejected earlier",
              }),
            ),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-rejected-"),
      ),
    ).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when dispatch replays an earlier accepted response", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-replay");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const earlierAttachment = {
      type: "image" as const,
      id: ChatAttachmentId.make("thread-replay-00000000-0000-4000-8000-0000000000aa"),
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${earlierAttachment.id}.png`),
      new Uint8Array([4, 4, 4]),
    );
    const storedEvents = answeredRespondEvents({
      threadId,
      requestId: "request-replay",
      attachmentsByQuestionId: { q: [earlierAttachment] },
    });
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-replay"),
      threadId,
      requestId: RuntimeRequestId.make("request-replay"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents }),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Success");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-replay-"),
      ),
    ).toEqual([`${earlierAttachment.id}.png`]);
    expect(
      NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${earlierAttachment.id}.png`)),
    ).toEqual(Buffer.from([4, 4, 4]));
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("a retried response re-claims the preserved pending uploads", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-retry");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    const lateId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const command: OrchestrationV2Command = {
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-retry"),
      threadId,
      requestId: RuntimeRequestId.make("request-retry"),
      answers: { q1: ["one"], q2: ["two"] },
      attachmentsByQuestionId: {
        q1: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        q2: [
          {
            type: "image",
            id: lateId,
            name: "late.png",
            mimeType: "image/png",
            sizeBytes: 2,
          },
        ],
      },
    };
    const captured: OrchestrationV2ServerCommand[] = [];
    const first = yield* dispatchCommand(command).pipe(
      Effect.provide(layerFailingDispatch(captured)),
      Effect.result,
    );
    expect(first._tag).toBe("Failure");
    expect(captured).toHaveLength(0);

    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${lateId}.png`),
      new Uint8Array([7, 7]),
    );
    const retry = yield* dispatchCommand(command).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: (dispatched) => {
            captured.push(dispatched);
            return Effect.succeed({ sequence: 1, storedEvents: [] });
          },
        }),
      ),
      Effect.result,
    );
    expect(retry._tag).toBe("Success");
    const dispatched = captured[0]!;
    expect(dispatched.type).toBe("runtime-request.respond");
    if (dispatched.type !== "runtime-request.respond") return;
    for (const attachment of [
      ...(dispatched.attachmentsByQuestionId?.q1 ?? []),
      ...(dispatched.attachmentsByQuestionId?.q2 ?? []),
    ]) {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      expect(path).not.toBeNull();
      expect(NodeFS.existsSync(path!)).toBe(true);
    }
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-retry-"),
      ),
    ).toHaveLength(2);
  }).pipe(Effect.provide(layerIntakeTest)),
);
describe("credit spend gate at client intake", () => {
  const blockedInstance = ProviderInstanceId.make("claude-blocked");
  const openInstance = ProviderInstanceId.make("claude-open");
  const REASON = 'Claude has used 100% of Weekly and "Allow to spend credits" is off.';
  const threadId = ThreadId.make("thread-credit-gate");

  const gateLayer = (input: { readonly receiptExists?: boolean } = {}) =>
    Layer.mergeAll(
      Layer.succeed(
        CreditSpendGuard,
        CreditSpendGuard.of({
          refusalFor: (instanceId) =>
            Effect.succeed(instanceId === blockedInstance ? REASON : null),
          // Client intake is a real start: it must use the re-reading gate.
          cachedRefusalFor: () => Effect.die("intake must use refusalFor"),
          resumeCheck: () => Effect.die("intake must use refusalFor"),
        }),
      ),
      Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
        getByCommandId: () =>
          Effect.succeed(input.receiptExists === true ? Option.some({} as never) : Option.none()),
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-credit-intake-" }).pipe(
        Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
    );

  const threadsOn = (instanceId: ProviderInstanceId, captured: OrchestrationV2ServerCommand[]) =>
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () => Effect.succeed({ providerInstanceId: instanceId } as never),
      dispatch: (command) =>
        Effect.sync(() => {
          captured.push(command);
          return { sequence: 1, storedEvents: [] };
        }),
    });

  const send = (commandId: string) =>
    ({
      type: "message.dispatch",
      commandId: CommandId.make(commandId),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: MessageId.make(commandId),
      text: "Go",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    }) satisfies OrchestrationV2Command;

  it.effect("refuses a send to a blocked instance before anything is dispatched", () =>
    Effect.gen(function* () {
      const captured: OrchestrationV2ServerCommand[] = [];
      const error = yield* dispatchCommand(send("credit-send")).pipe(
        Effect.provide(threadsOn(blockedInstance, captured)),
        Effect.flip,
      );
      expect(error._tag).toBe("CreditSpendRefusedError");
      expect(error.message).toBe(REASON);
      expect(captured).toEqual([]);
    }).pipe(Effect.provide(gateLayer())),
  );

  it.effect("judges an explicit model selection, not the thread's instance", () =>
    Effect.gen(function* () {
      const captured: OrchestrationV2ServerCommand[] = [];
      yield* dispatchCommand({
        ...send("credit-send-switch"),
        modelSelection: { instanceId: openInstance, model: "claude" },
      }).pipe(Effect.provide(threadsOn(blockedInstance, captured)));
      expect(captured.map((command) => command.commandId)).toEqual(["credit-send-switch"]);
    }).pipe(Effect.provide(gateLayer())),
  );

  it.effect("refuses resuming a held queue on a blocked instance", () =>
    Effect.gen(function* () {
      const captured: OrchestrationV2ServerCommand[] = [];
      const error = yield* dispatchCommand({
        type: "queue.resume",
        commandId: CommandId.make("credit-resume"),
        threadId,
      }).pipe(Effect.provide(threadsOn(blockedInstance, captured)), Effect.flip);
      expect(error._tag).toBe("CreditSpendRefusedError");
      expect(captured).toEqual([]);
    }).pipe(Effect.provide(gateLayer())),
  );

  it.effect("lets a replay of an already accepted send reach its receipt", () =>
    Effect.gen(function* () {
      const captured: OrchestrationV2ServerCommand[] = [];
      yield* dispatchCommand(send("credit-replay")).pipe(
        Effect.provide(threadsOn(blockedInstance, captured)),
      );
      expect(captured.map((command) => command.commandId)).toEqual(["credit-replay"]);
    }).pipe(Effect.provide(gateLayer({ receiptExists: true }))),
  );

  it.effect("refuses launching a thread whose first message targets a blocked instance", () =>
    Effect.gen(function* () {
      const launches: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const launchInput = (instanceId: ProviderInstanceId, withMessage: boolean) =>
        ({
          commandId: CommandId.make(`credit-launch-${instanceId}-${withMessage}`),
          threadId,
          projectId: ProjectId.make("project-credit"),
          title: "New",
          modelSelection: { instanceId, model: "claude" },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          ...(withMessage ? { initialMessage: { text: "Go", attachments: [] } } : {}),
          createdBy: "user",
          creationSource: "web",
        }) satisfies ThreadLaunch.ThreadLaunchInput;
      const launchesLayer = Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) =>
          Effect.sync(() => {
            launches.push(input);
            return {} as ThreadLaunch.ThreadLaunchResult;
          }),
      });

      const refused = yield* launchThread(launchInput(blockedInstance, true)).pipe(
        Effect.provide(launchesLayer),
        Effect.flip,
      );
      expect(refused._tag).toBe("CreditSpendRefusedError");
      // An idle thread spends nothing, and another instance is unaffected.
      yield* launchThread(launchInput(blockedInstance, false)).pipe(Effect.provide(launchesLayer));
      yield* launchThread(launchInput(openInstance, true)).pipe(Effect.provide(launchesLayer));
      expect(launches.map((input) => input.modelSelection.instanceId)).toEqual([
        blockedInstance,
        openInstance,
      ]);
    }).pipe(Effect.provide(gateLayer())),
  );
});

it.effect("sends a guest message with the guest's files, never ones the client names", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const guestFile = {
      type: "image" as const,
      id: ChatAttachmentId.make(createAttachmentId("thread-guest")!),
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${guestFile.id}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const guestMessageId = GuestMessageId.make("guest-message:files");
    const captured: OrchestrationV2ServerCommand[] = [];
    const layerGuestShare = Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch: layerFailingDispatchHandler(captured),
      // FORK: the credit gate reads the shell for a send without a model selection.
      getThreadShell: () => Effect.succeed(null),
      // Only the share is read.
      getThreadSnapshotWindow: () =>
        Effect.succeed({
          projection: {
            thread: {
              guestShare: {
                messages: [{ id: guestMessageId, status: "pending", attachments: [guestFile] }],
              },
            },
          },
        } as unknown as Effect.Success<
          ReturnType<
            ThreadManagementService.ThreadManagementServiceShape["getThreadSnapshotWindow"]
          >
        >),
    });
    yield* dispatchCommand({
      type: "message.dispatch",
      commandId: CommandId.make("send-guest-message"),
      threadId: ThreadId.make("thread-guest"),
      messageId: MessageId.make("message-guest"),
      guestMessageId,
      text: "",
      attachments: [{ ...guestFile, id: ChatAttachmentId.make("thread-guest-owner-file") }],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    }).pipe(Effect.provide(layerGuestShare), Effect.result);
    const command = captured[0];
    if (command?.type !== "message.dispatch") throw new Error("Expected a message dispatch.");
    expect(command.attachments).toHaveLength(1);
    // The guest's file, which is already the thread's.
    expect(command.attachments).toEqual([guestFile]);
  }).pipe(Effect.provide(layerIntakeTest)),
);
