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
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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
    assert.equal(claudeQueryAutoCompactWindow("300000", SONNET), 300_000);
    // Blank on a >= 1M window still arms compaction.
    assert.equal(claudeQueryAutoCompactWindow("", selection("claude-opus-4-8")), 1_000_000);
    // Unarmed models get their own window back.
    assert.equal(claudeQueryAutoCompactWindow("", selection("claude-haiku-4-5")), 200_000);
    // An armed sub-1M model is left to the CLI's own tuning.
    assert.isUndefined(claudeQueryAutoCompactWindow("", SONNET));
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
  readonly getContextUsage?: () => SDKControlGetContextUsageResponse;
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
              interrupt: Effect.void,
              close: Effect.void,
              ...(getContextUsage === undefined
                ? {}
                : { getContextUsage: Effect.sync(getContextUsage) }),
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
    const startTurn = Effect.gen(function* () {
      attempts += 1;
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
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
    return {
      events,
      terminals,
      startTurn,
      offer,
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
        yield* harness.startTurn;
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

        yield* harness.startTurn;
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
        yield* harness.startTurn;
        yield* harness.offer(result({ is_error: true, result: { unexpected: true } }));
        const failed = yield* Queue.take(harness.terminals);
        assert.equal(failed.status, "failed");
        if (failed.status !== "failed") return;
        // Classified from the result, not a torn-down query stream.
        assert.equal(failed.failure.class, "provider_error");
        yield* harness.startTurn;
        yield* harness.offer(result({ result: "still here" }));
        assert.equal((yield* Queue.take(harness.terminals)).status, "completed");
      }).pipe(provide),
    ),
  );

  it.effect("shows a refusal and a warning note, and nothing for other notices", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startTurn;
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
        yield* harness.startTurn;
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
          getContextUsage: () =>
            ({
              totalTokens: 541_000,
              maxTokens: 967_000,
              isAutoCompactEnabled: true,
              autoCompactThreshold: 967_000,
              autocompactSource: "settings",
            }) as unknown as SDKControlGetContextUsageResponse,
        });
        yield* harness.startTurn;
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
          yield* harness.startTurn;
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
});
