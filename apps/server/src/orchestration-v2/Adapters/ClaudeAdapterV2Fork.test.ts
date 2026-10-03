/**
 * FORK: tests for the Claude adapter behaviour the fork keeps on v2
 * (ClaudeAdapterV2Fork.ts and its call sites in ClaudeAdapterV2.ts). Kept out
 * of upstream's ClaudeAdapterV2.test.ts so its edits keep merging.
 */
import type {
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import { SubagentBackendLive } from "../../subagentBackend/SubagentBackend.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import {
  applyClaudeTaskToolResult,
  type ClaudeTaskState,
  claudeContextUsageSnapshot,
  claudeModelContextWindow,
  claudeQueryAutoCompactWindow,
  claudeResultProse,
  claudeResultTerminalStatus,
  subagentDispatchAppend,
} from "./ClaudeAdapterV2Fork.ts";

const NATIVE_SESSION = "fork-native-session";
const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const STYLED_PERCENT_SETTINGS = Schema.decodeSync(ClaudeSettings)({
  autoCompactWindow: "60%",
  outputStyle: "Concise",
});
const RUNTIME_POLICY = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function selection(model: string, options: ModelSelection["options"] = []): ModelSelection {
  return { instanceId: ProviderInstanceId.make("claudeAgent"), model, options };
}
const SONNET = selection("claude-sonnet-4-6");

function frame(value: unknown): SDKMessage {
  return value as SDKMessage;
}

function resultFrame(fields: Record<string, unknown>): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-0000000000aa",
    session_id: NATIVE_SESSION,
    ...fields,
  } as unknown as SDKResultMessage;
}

describe("Claude result classification (invariant 35)", () => {
  it("fails a success-tagged result with is_error and no hint", () => {
    assert.equal(
      claudeResultTerminalStatus(resultFrame({ is_error: true, result: "API Error: 500" })),
      "failed",
    );
    assert.equal(claudeResultTerminalStatus(resultFrame({})), "completed");
  });

  it("treats a user abort as interrupted even with is_error", () => {
    assert.equal(
      claudeResultTerminalStatus(
        resultFrame({ is_error: true, terminal_reason: "aborted_tools", result: "partial" }),
      ),
      "interrupted",
    );
  });

  it("lets a failed terminal reason outrank the cancel heuristic", () => {
    assert.equal(
      claudeResultTerminalStatus(
        resultFrame({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["request cancelled upstream"],
          terminal_reason: "model_error",
        }),
      ),
      "failed",
    );
  });

  it("ignores diagnostics when reading interrupt and cancel", () => {
    assert.equal(
      claudeResultTerminalStatus(
        resultFrame({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["[ede_diagnostic] interrupted stop_reason=tool_use", "boom"],
        }),
      ),
      "failed",
    );
    assert.equal(
      claudeResultTerminalStatus(
        resultFrame({
          subtype: "error_during_execution",
          is_error: false,
          errors: ["Request was aborted."],
        }),
      ),
      "interrupted",
    );
  });

  it("filters diagnostics per line and guards a non-string result", () => {
    assert.equal(
      claudeResultProse(
        resultFrame({ result: "API Error: 500\n  [EDE_DIAGNOSTIC] result_type=user\nretry later" }),
      ),
      "API Error: 500\nretry later",
    );
    assert.isUndefined(claudeResultProse(resultFrame({ result: "[ede_diagnostic] only" })));
    assert.isUndefined(claudeResultProse(resultFrame({ result: { nested: "object" } })));
  });
});

describe("Claude context windows (invariants 12, 22)", () => {
  // Real slugs against the bundled catalog: the model is the subject here.
  it("uses the window the CLI runs at, not the catalog toggle alone", () => {
    assert.equal(claudeModelContextWindow(selection("claude-opus-4-8")), 1_000_000);
    assert.equal(claudeModelContextWindow(selection("claude-sonnet-5")), 1_000_000);
    assert.equal(claudeModelContextWindow(SONNET), 200_000);
    assert.equal(
      claudeModelContextWindow(
        selection("claude-opus-4-6", [{ id: "contextWindow", value: "200k" }]),
      ),
      200_000,
    );
  });

  it("resolves the auto-compact window the CLI is handed", () => {
    // A percentage resolves against the CLI's real 1M window.
    assert.equal(claudeQueryAutoCompactWindow("60%", selection("claude-opus-4-8")), 600_000);
    // claude-sonnet-5: the catalog says 200k, the CLI runs it at 1M.
    assert.equal(claudeQueryAutoCompactWindow("60%", selection("claude-sonnet-5")), 600_000);
    assert.equal(claudeQueryAutoCompactWindow("300000", SONNET), 300_000);
    // Blank on a 1M window the CLI holds no default for still arms compaction.
    assert.equal(
      claudeQueryAutoCompactWindow(
        "",
        selection("claude-opus-4-6", [{ id: "contextWindow", value: "1m" }]),
      ),
      1_000_000,
    );
    // Unarmed models (`"auto"` on 2.1.288) get their own window back.
    assert.equal(claudeQueryAutoCompactWindow("", selection("claude-haiku-4-5")), 200_000);
    assert.equal(claudeQueryAutoCompactWindow("", selection("claude-opus-4-5")), 200_000);
    // Every 1M model gets 1M, including those 2.1.288 arms itself, since an
    // older CLI on the user's PATH may not (sonnet-5: catalog 200k, CLI 1M).
    for (const model of [
      "claude-opus-5",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-sonnet-5",
    ]) {
      assert.equal(claudeQueryAutoCompactWindow("", selection(model)), 1_000_000, model);
    }
    assert.isUndefined(claudeQueryAutoCompactWindow("", selection("claude-sonnet-4-6")));
  });

  it("passes the auto-compact window and output style to the SDK", () => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: selection("claude-opus-4-8"),
      nativeThreadId: "native-fork-options",
      resume: false,
      cwd: "/workspace",
      settings: STYLED_PERCENT_SETTINGS,
    });
    assert.include(options.settings, { autoCompactWindow: 600_000, outputStyle: "Concise" });
    const unset = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: SONNET,
      nativeThreadId: "native-fork-options-unset",
      resume: false,
      cwd: "/workspace",
      settings: DEFAULT_CLAUDE_SETTINGS,
    });
    assert.notProperty(unset.settings ?? {}, "outputStyle");
    assert.notProperty(unset.settings ?? {}, "autoCompactWindow");
    // A blank setting on a 1M model still arms compaction.
    const oneM = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: selection("claude-opus-5"),
      nativeThreadId: "native-fork-options-one-m",
      resume: false,
      cwd: "/workspace",
      settings: DEFAULT_CLAUDE_SETTINGS,
    });
    assert.include(oneM.settings, { autoCompactWindow: 1_000_000 });
  });

  it("reads compaction facts off getContextUsage, against the model's window", () => {
    const snapshot = claudeContextUsageSnapshot(
      {
        totalTokens: 541_000,
        maxTokens: 600_000,
        isAutoCompactEnabled: true,
        autoCompactThreshold: 567_000,
        autocompactSource: "settings",
      } as unknown as SDKControlGetContextUsageResponse,
      1_000_000,
    );
    assert.deepEqual(snapshot, {
      usedTokens: 541_000,
      maxTokens: 1_000_000,
      compactsAutomatically: true,
      autoCompactThreshold: 567_000,
      autoCompactSource: "settings",
    });
  });
});

describe("Claude Task tools", () => {
  it("builds the list only from successful structured results", () => {
    const tasks = new Map<string, ClaudeTaskState>();
    assert.isFalse(
      applyClaudeTaskToolResult(tasks, { toolName: "TaskCreate", input: { subject: "A" } }, {}),
    );
    assert.isTrue(
      applyClaudeTaskToolResult(
        tasks,
        { toolName: "TaskCreate", input: { subject: "Write tests" } },
        { task: { id: "1", subject: "Write tests" } },
      ),
    );
    assert.isTrue(
      applyClaudeTaskToolResult(
        tasks,
        { toolName: "TaskUpdate", input: { taskId: "1", status: "in_progress" } },
        { success: true },
      ),
    );
    assert.isFalse(
      applyClaudeTaskToolResult(
        tasks,
        { toolName: "TaskUpdate", input: { taskId: "missing", status: "completed" } },
        { success: true },
      ),
    );
    assert.equal(tasks.get("1")?.status, "running");
  });
});

// ---------------------------------------------------------------------------
// Adapter-level arms
// ---------------------------------------------------------------------------

function makeTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attempt: string;
  readonly modelSelection?: ModelSelection;
}): ProviderAdapterV2TurnInput {
  const modelSelection = input.modelSelection ?? SONNET;
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project-${input.threadId}`),
      title: "Claude fork test",
      providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attempt}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make(input.attempt),
    rootNodeId: NodeId.make(`node-${input.attempt}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${input.attempt}`),
      text: "Go.",
      attachments: [],
    },
    modelSelection,
    runtimePolicy: RUNTIME_POLICY,
  };
}

const makeHarness = (options?: {
  readonly getContextUsage?: Effect.Effect<SDKControlGetContextUsageResponse>;
  readonly offerThreadCompaction?: boolean;
  readonly modelSelection?: ModelSelection;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-claude-v2-fork-",
    });
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const terminals =
      yield* Queue.unbounded<Extract<ProviderAdapterV2Event, { type: "turn.terminal" }>>();
    let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
    const interruptRequested = yield* Deferred.make<void>();
    const getContextUsage = options?.getContextUsage;
    const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CLAUDE_SETTINGS,
      environment: {},
      attachmentsDir,
      fileSystem,
      path: yield* Path.Path,
      idAllocator,
      ...(options?.offerThreadCompaction === undefined
        ? {}
        : { offerThreadCompaction: Effect.succeed(options.offerThreadCompaction) }),
      queryRunner: {
        allocateSessionId: Effect.succeed(NATIVE_SESSION),
        open: (input) =>
          Effect.sync(() => {
            openedOptions = input.options;
            return {
              messages: Stream.fromQueue(sdkMessages),
              offer: () => Effect.void,
              setModel: () => Effect.void,
              interrupt: Deferred.succeed(interruptRequested, undefined),
              close: Effect.void,
              ...(getContextUsage === undefined ? {} : { getContextUsage }),
            };
          }),
        forkSession: () => Effect.die("unused forkSession"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make("thread-claude-fork");
    const modelSelection = options?.modelSelection ?? SONNET;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-claude-fork"),
      modelSelection,
      runtimePolicy: RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection,
      runtimePolicy: RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapterV2Event> = [];
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.terminal") yield* Queue.offer(terminals, event);
        }),
      ),
      Effect.forkScoped,
    );
    let attempts = 0;
    // `current` is the provider thread as orchestration would pass it back.
    const startTurn = Effect.fnUntraced(function* (current = providerThread) {
      attempts += 1;
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread: current,
          now: yield* DateTime.now,
          attempt: `attempt-fork-${attempts}`,
          modelSelection,
        }),
      );
    });
    const offer = (...frames: ReadonlyArray<unknown>) =>
      Effect.forEach(frames, (value) => Queue.offer(sdkMessages, frame(value)), {
        discard: true,
      });
    const latestProviderThread = () =>
      events
        .flatMap((event) =>
          event.type === "provider_thread.updated" ? [event.providerThread] : [],
        )
        .at(-1);
    const runningProviderTurnIds = () =>
      events.flatMap((event) =>
        event.type === "provider_turn.updated" && event.providerTurn.status === "running"
          ? [event.providerTurn.id]
          : [],
      );
    const interrupt = (providerTurnId: ProviderTurnId) =>
      runtime.interruptTurn({ providerThread, providerTurnId });
    return {
      events,
      terminals,
      startTurn,
      offer,
      interrupt,
      interruptRequested,
      latestProviderThread,
      runningProviderTurnIds,
      getOpenedOptions: () => openedOptions,
    };
  });

const provide = Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer));

let uuidCounter = 0;
const nextUuid = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`;
const result = (fields: Record<string, unknown> = {}) =>
  resultFrame({ uuid: nextUuid(), ...fields });

describe("ClaudeAdapterV2 fork deltas", () => {
  it.effect("fails a success-tagged error turn and keeps the session for the next one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startTurn();
        yield* harness.offer(
          result({
            is_error: true,
            result: "API Error: 500 Internal server error\n[ede_diagnostic] stop_reason=n/a",
          }),
        );
        const failed = yield* Queue.take(harness.terminals);
        assert.equal(failed.status, "failed");
        if (failed.status !== "failed") return;
        assert.equal(failed.failure.message, "API Error: 500 Internal server error");

        yield* harness.startTurn();
        yield* harness.offer(result({ result: "recovered" }));
        const recovered = yield* Queue.take(harness.terminals);
        assert.equal(recovered.status, "completed");
      }).pipe(provide),
    ),
  );

  it.effect("survives a non-string result on a failed turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startTurn();
        yield* harness.offer(result({ is_error: true, result: { unexpected: true } }));
        const failed = yield* Queue.take(harness.terminals);
        assert.equal(failed.status, "failed");
        if (failed.status !== "failed") return;
        // Classified from the result, not a torn-down query stream.
        assert.equal(failed.failure.class, "provider_error");
        yield* harness.startTurn();
        yield* harness.offer(result({ result: "still here" }));
        assert.equal((yield* Queue.take(harness.terminals)).status, "completed");
      }).pipe(provide),
    ),
  );

  it.effect("shows a refusal and a warning note, and nothing for other notices", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startTurn();
        const system = (fields: Record<string, unknown>) => ({
          type: "system",
          uuid: nextUuid(),
          session_id: NATIVE_SESSION,
          ...fields,
        });
        yield* harness.offer(
          system({ subtype: "notification", key: "k", text: "Background ready", priority: "high" }),
          system({ subtype: "informational", content: "Transcript note", level: "info" }),
          system({ subtype: "informational", content: "Stop hook refused", level: "warning" }),
          system({
            subtype: "model_refusal_no_fallback",
            original_model: "claude-sonnet-4-6",
            request_id: null,
            content: "Claude declined.",
            api_refusal_explanation: "  The request was refused for safety.  ",
          }),
          result(),
        );
        yield* Queue.take(harness.terminals);
        const notices = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
            ? [event.turnItem.message]
            : [],
        );
        assert.deepEqual(notices, ["Stop hook refused", "The request was refused for safety."]);
      }).pipe(provide),
    ),
  );

  it.effect("projects Task tool results as a to-do list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startTurn();
        const toolUse = (id: string, name: string, input: unknown) => ({
          type: "assistant",
          message: {
            model: "claude-sonnet-4-6",
            id: `msg_${id}`,
            type: "message",
            role: "assistant",
            content: [{ type: "tool_use", id, name, input }],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          parent_tool_use_id: null,
          uuid: nextUuid(),
          session_id: NATIVE_SESSION,
        });
        const toolResult = (id: string, structured: unknown, isError = false) => ({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: isError }],
          },
          parent_tool_use_id: null,
          uuid: nextUuid(),
          session_id: NATIVE_SESSION,
          tool_use_result: structured,
        });
        yield* harness.offer(
          toolUse("toolu_create_a", "TaskCreate", { subject: "Write tests" }),
          toolResult("toolu_create_a", { task: { id: "1", subject: "Write tests" } }),
          toolUse("toolu_create_b", "TaskCreate", { subject: "Ship", blockedBy: ["1"] }),
          toolResult("toolu_create_b", { task: { id: "2", subject: "Ship" } }),
          toolUse("toolu_update_a", "TaskUpdate", { taskId: "1", status: "completed" }),
          toolResult("toolu_update_a", { success: true }),
          // A failed update changes nothing.
          toolUse("toolu_update_b", "TaskUpdate", { taskId: "2", status: "completed" }),
          toolResult("toolu_update_b", { success: false }, true),
          result(),
        );
        yield* Queue.take(harness.terminals);
        const lists = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "todo_list"
            ? [event.turnItem.steps.map((step) => `${step.text}:${step.status}`)]
            : [],
        );
        assert.deepEqual(lists.at(-1), ["Write tests:completed", "Ship (blocked by #1):pending"]);
        assert.equal(lists.length, 3);
      }).pipe(provide),
    ),
  );

  it.effect("records the CLI's compaction facts on the provider thread at turn end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          modelSelection: selection("claude-opus-4-8"),
          getContextUsage: Effect.succeed({
            totalTokens: 541_000,
            maxTokens: 967_000,
            isAutoCompactEnabled: true,
            autoCompactThreshold: 967_000,
            autocompactSource: "settings",
          } as unknown as SDKControlGetContextUsageResponse),
        });
        yield* harness.startTurn();
        yield* harness.offer(result());
        yield* Queue.take(harness.terminals);
        const usage = harness.events
          .flatMap((event) =>
            event.type === "provider_thread.updated" ? [event.providerThread.contextUsage] : [],
          )
          .at(-1);
        assert.deepEqual(usage, {
          usedTokens: 541_000,
          maxTokens: 1_000_000,
          compactsAutomatically: true,
          autoCompactThreshold: 967_000,
          autoCompactSource: "settings",
        });
      }).pipe(provide),
    ),
  );

  it.effect("answers the resume question without asking when compaction offers are off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const offer of [false, true]) {
          const harness = yield* makeHarness({ offerThreadCompaction: offer });
          yield* harness.startTurn();
          const onUserDialog = harness.getOpenedOptions()?.onUserDialog;
          assert.isDefined(onUserDialog);
          if (onUserDialog === undefined) return;
          const abort = new AbortController();
          const answer = onUserDialog(
            {
              dialogKind: "resume_return",
              payload: { sessionAgeMinutes: 120, estimatedTokens: 400_000 },
            } as never,
            { signal: abort.signal, requestId: `dialog-${offer}` } as never,
          );
          if (!offer) {
            assert.deepEqual(yield* Effect.promise(() => answer), {
              behavior: "completed",
              result: "continue",
            });
            continue;
          }
          // Offered: the question becomes a pending runtime request.
          for (let attempt = 0; attempt < 5000; attempt++) {
            if (harness.events.some((event) => event.type === "runtime_request.updated")) break;
            yield* Effect.yieldNow;
          }
          assert.isTrue(harness.events.some((event) => event.type === "runtime_request.updated"));
          abort.abort();
          yield* Effect.promise(() => answer.catch(() => undefined));
        }
      }).pipe(provide),
    ),
  );

  it.effect("ends the turn and keeps the last compaction facts when getContextUsage hangs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const asked = yield* Queue.unbounded<number>();
        let calls = 0;
        const harness = yield* makeHarness({
          modelSelection: selection("claude-opus-4-8"),
          getContextUsage: Effect.suspend(() => {
            calls += 1;
            return calls === 1
              ? Effect.succeed({
                  totalTokens: 100_000,
                  maxTokens: 1_000_000,
                  isAutoCompactEnabled: true,
                  autoCompactThreshold: 967_000,
                  autocompactSource: "model-default",
                } as unknown as SDKControlGetContextUsageResponse)
              : Queue.offer(asked, calls).pipe(Effect.andThen(Effect.never));
          }),
        });
        yield* harness.startTurn();
        yield* harness.offer(result());
        assert.equal((yield* Queue.take(harness.terminals)).status, "completed");
        const first = harness.latestProviderThread();
        assert.equal(first?.contextUsage?.usedTokens, 100_000);

        yield* harness.startTurn(first);
        yield* harness.offer(result());
        yield* Queue.take(asked);
        // The turn waits on the question, and no longer than its bound.
        assert.isTrue(Option.isNone(yield* Queue.poll(harness.terminals)));
        yield* TestClock.adjust("1 second");
        assert.equal((yield* Queue.take(harness.terminals)).status, "completed");
        assert.deepEqual(harness.latestProviderThread()?.contextUsage, first?.contextUsage);
      }).pipe(provide),
    ),
  );

  it.effect("does not ask getContextUsage after an interrupted turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const harness = yield* makeHarness({
          getContextUsage: Effect.sync(() => {
            calls += 1;
            return { totalTokens: 1 } as unknown as SDKControlGetContextUsageResponse;
          }),
        });
        // Control: a completed turn asks once.
        yield* harness.startTurn();
        yield* harness.offer(result());
        assert.equal((yield* Queue.take(harness.terminals)).status, "completed");
        assert.equal(calls, 1);

        yield* harness.startTurn(harness.latestProviderThread());
        for (let attempt = 0; attempt < 5000; attempt++) {
          if (new Set(harness.runningProviderTurnIds()).size === 2) break;
          yield* Effect.yieldNow;
        }
        const providerTurnId = [...new Set(harness.runningProviderTurnIds())][1];
        assert.isDefined(providerTurnId);
        if (providerTurnId === undefined) return;
        yield* harness.interrupt(providerTurnId).pipe(Effect.forkScoped);
        yield* Deferred.await(harness.interruptRequested);
        yield* harness.offer(
          result({
            subtype: "error_during_execution",
            is_error: true,
            errors: ["[ede_diagnostic] aborted"],
            terminal_reason: "aborted_streaming",
          }),
        );
        assert.equal((yield* Queue.take(harness.terminals)).status, "interrupted");
        assert.equal(calls, 1);
      }).pipe(provide),
    ),
  );

  it.effect("keeps diagnostics out of an error-subtype failure message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startTurn();
        yield* harness.offer(
          result({
            subtype: "error_during_execution",
            is_error: true,
            errors: ["[ede_diagnostic] stop_reason=n/a result_type=user"],
          }),
        );
        const failed = yield* Queue.take(harness.terminals);
        assert.equal(failed.status, "failed");
        if (failed.status !== "failed") return;
        assert.notInclude(failed.failure.message, "ede_diagnostic");
      }).pipe(provide),
    ),
  );

  it.effect("completes a successful turn whose result is not a string, with no fallback text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startTurn();
        yield* harness.offer(result({ result: ["not", "text"] }));
        assert.equal((yield* Queue.take(harness.terminals)).status, "completed");
        const assistantTexts = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
            ? [event.turnItem.text]
            : [],
        );
        assert.deepEqual(assistantTexts, []);
      }).pipe(provide),
    ),
  );

  // Upstream projects TodoWrite only for the main agent; Task tools match it.
  it.effect("ignores Task tool calls made by a subagent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startTurn();
        const toolUse = (id: string, name: string, input: unknown, parent: string | null) => ({
          type: "assistant",
          message: {
            model: "claude-sonnet-4-6",
            id: `msg_${id}`,
            type: "message",
            role: "assistant",
            content: [{ type: "tool_use", id, name, input }],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          parent_tool_use_id: parent,
          uuid: nextUuid(),
          session_id: NATIVE_SESSION,
        });
        const toolResult = (id: string, structured: unknown, parent: string | null) => ({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }],
          },
          parent_tool_use_id: parent,
          uuid: nextUuid(),
          session_id: NATIVE_SESSION,
          tool_use_result: structured,
        });
        yield* harness.offer(
          toolUse("toolu_agent", "Agent", { description: "Helper", prompt: "Help." }, null),
          {
            type: "system",
            subtype: "task_started",
            task_id: "task-helper",
            tool_use_id: "toolu_agent",
            description: "Helper",
            task_type: "local_agent",
            uuid: nextUuid(),
            session_id: NATIVE_SESSION,
          },
          toolUse("toolu_sub_create", "TaskCreate", { subject: "Subagent task" }, "toolu_agent"),
          toolResult(
            "toolu_sub_create",
            { task: { id: "9", subject: "Subagent task" } },
            "toolu_agent",
          ),
          toolUse("toolu_main_create", "TaskCreate", { subject: "Main task" }, null),
          toolResult("toolu_main_create", { task: { id: "1", subject: "Main task" } }, null),
          result(),
        );
        yield* Queue.take(harness.terminals);
        const lists = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "todo_list"
            ? [event.turnItem.steps.map((step) => step.text)]
            : [],
        );
        assert.deepEqual(lists, [["Main task"]]);
      }).pipe(provide),
    ),
  );
});

/** The fields of a thread flag file these tests read. */
const decodeThreadFlagFile = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      backend: Schema.String,
      binaryPath: Schema.NullOr(Schema.String),
      degraded: Schema.NullOr(Schema.String),
    }),
  ),
);

describe("ClaudeAdapterV2 subagent offload reaches the spawned process", () => {
  // The defect this feature shipped with once (2026-09-04): every flag file was right and
  // no subagent ever went to Cursor, because nothing told the AGENT. So this drives the
  // real chain — settings -> SubagentBackendLive's preparer -> the adapter's process spawn —
  // and asserts on the options the Claude SDK is asked to run with.
  const arm = (input: { readonly enabled: boolean; readonly mode: "on" | "off" }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        // `readBackendFile` reads `$HOME/.local/state/...`; never the real one.
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-sbt-home-" });
        const previousHome = process.env.HOME;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env.HOME = home;
          }),
          () =>
            Effect.sync(() => {
              process.env.HOME = previousHome;
            }),
        );
        const threadId = ThreadId.make("thread-claude-fork");
        const backendContext = yield* Layer.build(
          SubagentBackendLive.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                ServerConfig.layerTest("/tmp", { prefix: "t3-sbt-config-" }),
                serverSettingsLayerTest({
                  subagentBackendEnabled: input.enabled,
                  subagentBackendThreadModes: { [threadId]: input.mode },
                  providerInstances: {
                    [ProviderInstanceId.make("cursor")]: {
                      driver: ProviderDriverKind.make("cursor"),
                      enabled: true,
                      config: { binaryPath: "/bin/echo" },
                    },
                  },
                }),
              ),
            ),
          ),
        );
        const { subagentThreadsDir } = Context.get(backendContext, ServerConfig.ServerConfig);
        const harness = yield* makeHarness();
        yield* harness.startTurn();
        const opened = harness.getOpenedOptions();
        const statePath = opened?.env?.SUBAGENT_BACKEND_STATE;
        const append = (opened?.systemPrompt as { readonly append?: string } | undefined)?.append;
        const onDisk =
          statePath === undefined
            ? undefined
            : decodeThreadFlagFile(yield* fileSystem.readFileString(statePath));
        return { statePath, append: append ?? "", onDisk, subagentThreadsDir };
      }),
    ).pipe(provide);

  it.effect("a thread switched on runs with the wrapper's state file and the instruction", () =>
    Effect.gen(function* () {
      const on = yield* arm({ enabled: true, mode: "on" });
      assert.isString(on.statePath);
      assert.isTrue(on.statePath!.startsWith(`${on.subagentThreadsDir}/`));
      assert.equal(on.onDisk?.backend, "cursor");
      assert.equal(on.onDisk?.binaryPath, "/bin/echo");
      assert.include(on.append, "<subagent_dispatch>");
      assert.include(on.append, "~/bin/subagent-dispatch");
    }),
  );

  it.effect("a thread switched off, or the master switch off, gets no instruction", () =>
    Effect.gen(function* () {
      const off = yield* arm({ enabled: true, mode: "off" });
      assert.equal(off.onDisk?.backend, "default");
      assert.notInclude(off.append, "subagent_dispatch");
      const masterOff = yield* arm({ enabled: false, mode: "on" });
      assert.equal(masterOff.onDisk?.backend, "default");
      assert.include(masterOff.onDisk?.degraded, "switched off");
      assert.notInclude(masterOff.append, "subagent_dispatch");
    }),
  );

  it.effect("with no subagent backend running, the process env and prompt are untouched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startTurn();
        const opened = harness.getOpenedOptions();
        assert.isUndefined(opened?.env?.SUBAGENT_BACKEND_STATE);
        assert.notInclude(
          (opened?.systemPrompt as { readonly append?: string } | undefined)?.append ?? "",
          "subagent_dispatch",
        );
      }),
    ).pipe(provide),
  );
});

describe("subagentDispatchAppend", () => {
  it("enables only on an exact `cursor`", () => {
    assert.match(subagentDispatchAppend("cursor"), /subagent-dispatch/);
    for (const other of ["default", "", "Cursor", "cursor ", undefined]) {
      assert.equal(subagentDispatchAppend(other), "");
    }
  });
});
