import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionResult,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  ClaudeSettings,
  CLAUDE_OUTPUT_STYLES,
  MessageId,
  ProviderDriverKind,
  SUBAGENT_BACKEND_CURSOR,
  ProviderItemId,
  ProviderRuntimeEvent,
  type RuntimeMode,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OFF, writeThreadBackendFile } from "../../subagentBackend/SubagentBackend.ts";
import { threadBackendFileName } from "../../subagentBackend/ThreadBackendPath.ts";
import { subagentDispatchAppend } from "./ClaudeAdapter.ts";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../ClaudeModelCatalog.ts";
import {
  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
  SYNTHETIC_CLAUDE_THINKING_MODEL,
} from "../ClaudeModelCatalog.testFixtures.ts";
import { ProviderAdapterProcessError, ProviderAdapterValidationError } from "../Errors.ts";
import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import type { ClaudeScopedLimitNames } from "./claudeUsageLimits.ts";
import {
  makeClaudeAdapter,
  thinkingTokensDisplayBucket,
  type ClaudeAdapterLiveOptions,
} from "./ClaudeAdapter.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// Test-local service tag so the rest of the file can keep using `yield* ClaudeAdapter`.
class ClaudeAdapter extends Context.Service<ClaudeAdapter, ClaudeAdapterShape>()(
  "t3/provider/Layers/ClaudeAdapter.test/ClaudeAdapter",
) {}

class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;

  public readonly interruptCalls: Array<void> = [];
  public readonly stopTaskCalls: Array<string> = [];
  public readonly setModelCalls: Array<string | undefined> = [];
  public readonly setPermissionModeCalls: Array<string> = [];
  public readonly setMaxThinkingTokensCalls: Array<number | null> = [];
  public closeCalls = 0;
  public closeError: unknown | undefined;

  emit(message: SDKMessage): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  fail(cause: unknown): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(cause);
    }
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = undefined;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  // When set, `interrupt()` never resolves — modelling a subprocess wedged in a tool that never
  // sends the interrupt control-response.
  public hangInterrupt = false;

  readonly interrupt = async (): Promise<void> => {
    this.interruptCalls.push(undefined);
    if (this.hangInterrupt) {
      await new Promise<never>(() => {});
    }
  };

  readonly stopTask = async (taskId: string): Promise<void> => {
    this.stopTaskCalls.push(taskId);
  };

  // The turn-end context-usage control call. Left empty by default so existing
  // tests keep exercising the streaming path; push responses to drive the
  // compaction facts (threshold / source), which no other seam reports.
  //
  // A queue rather than a single settable field: turn completion runs on the
  // adapter's own fiber, so a test that assigns a new value straight after
  // emitting a result races it, and the FIRST turn silently reads the SECOND
  // turn's value. One entry is consumed per call, in order.
  public readonly contextUsageResponses: Array<Record<string, unknown> | undefined> = [];

  readonly getContextUsage = async (): Promise<SDKControlGetContextUsageResponse> =>
    (this.contextUsageResponses.length > 0
      ? this.contextUsageResponses.shift()
      : undefined) as SDKControlGetContextUsageResponse;

  readonly setModel = async (model?: string): Promise<void> => {
    this.setModelCalls.push(model);
  };

  readonly setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    this.setPermissionModeCalls.push(mode);
  };

  readonly setMaxThinkingTokens = async (maxThinkingTokens: number | null): Promise<void> => {
    this.setMaxThinkingTokensCalls.push(maxThinkingTokens);
  };

  readonly close = (): void => {
    this.closeCalls += 1;
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
    this.finish();
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (value) {
            return Promise.resolve({
              done: false,
              value,
            });
          }
        }
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
        });
      },
    };
  }
}

function makeHarness(config?: {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: ClaudeAdapterLiveOptions["nativeEventLogger"];
  readonly cwd?: string;
  readonly baseDir?: string;
  readonly claudeConfig?: Partial<ClaudeSettings>;
  readonly instanceId?: ProviderInstanceId;
  readonly pollAccountUsage?: ClaudeAdapterLiveOptions["pollAccountUsage"];
  readonly usagePollInterval?: ClaudeAdapterLiveOptions["usagePollInterval"];
  /**
   * Defaults to the synthetic catalog so transport tests stay independent of manifest
   * contents. Tests whose subject IS a real model rule - the fork's auto-compaction
   * windows, the `[1m]` API suffix - pass `BUNDLED_CLAUDE_MODEL_CATALOG`, because that
   * is the catalog the adapter resolves in production.
   */
  readonly modelCatalog?: ClaudeAdapterLiveOptions["modelCatalog"];
  readonly scopedLimitNames?: ClaudeAdapterLiveOptions["scopedLimitNames"];
  readonly environment?: ClaudeAdapterLiveOptions["environment"];
}) {
  const query = new FakeClaudeQuery();
  let createInput:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }
    | undefined;

  const adapterOptions: ClaudeAdapterLiveOptions = {
    ...(config?.environment ? { environment: config.environment } : {}),
    ...(config?.instanceId ? { instanceId: config.instanceId } : {}),
    ...(config?.scopedLimitNames ? { scopedLimitNames: config.scopedLimitNames } : {}),
    // FORK: the synthetic catalog is the DEFAULT, not the only choice (registry 22).
    modelCatalog: config?.modelCatalog ?? Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
    createQuery: (input) => {
      createInput = input;
      return query;
    },
    ...(config?.nativeEventLogger
      ? {
          nativeEventLogger: config.nativeEventLogger,
        }
      : {}),
    ...(config?.nativeEventLogPath
      ? {
          nativeEventLogPath: config.nativeEventLogPath,
        }
      : {}),
    ...(config?.pollAccountUsage ? { pollAccountUsage: config.pollAccountUsage } : {}),
    ...(config?.usagePollInterval ? { usagePollInterval: config.usagePollInterval } : {}),
  };

  return {
    layer: Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings(config?.claudeConfig ?? {});
        return yield* makeClaudeAdapter(claudeConfig, adapterOptions);
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(
          config?.cwd ?? "/tmp/claude-adapter-test",
          // A per-harness temp dir, NOT a shared "/tmp": that resolved every harness in this
          // file to one `/tmp/userdata/subagent-threads`, so a flag-file fixture written by
          // one test was visible to all 150 and survived between runs on the machine.
          config?.baseDir ?? { prefix: "claude-adapter-" },
        ),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    ),
    query,
    getLastCreateQueryInput: () => createInput,
  };
}

function makeDeterministicRandomService(seed = 0x1234_5678): {
  nextIntUnsafe: () => number;
  nextDoubleUnsafe: () => number;
} {
  let state = seed >>> 0;
  const nextIntUnsafe = (): number => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state;
  };

  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
}

async function readFirstPromptText(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<string | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  if (typeof next.value.message.content === "string") {
    return next.value.message.content;
  }
  const content = next.value.message.content[0];
  if (!content || content.type !== "text") {
    return undefined;
  }
  return content.text;
}

async function readFirstPromptMessage(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<SDKUserMessage | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  return next.value;
}

/** Drains the first `count` queued prompts so consecutive turns can be compared. */
async function readPromptMessages(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
  count: number,
): Promise<Array<SDKUserMessage>> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return [];
  }
  const messages: Array<SDKUserMessage> = [];
  while (messages.length < count) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    messages.push(next.value);
  }
  return messages;
}

const THREAD_ID = ThreadId.make("thread-claude-1");
const RESUME_THREAD_ID = ThreadId.make("thread-claude-resume");
const SYNTHETIC_SUBAGENT_MODEL = "claude-synthetic-subagent[expanded]";

describe("ClaudeAdapterLive", () => {
  it.effect("returns validation error for non-claude provider on startSession", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const result = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("codex"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "startSession",
          issue: "Expected provider 'claudeAgent' but received 'codex'.",
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("retains Claude session startup causes without exposing their messages", () => {
    const cause = new Error("credential material that must remain in the cause chain");
    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            throw cause;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest("/tmp/claude-adapter-test", { prefix: "claude-adapter-" }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const error = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ProviderAdapterProcessError);
      assert.equal(error.detail, "Failed to start Claude runtime session.");
      assert.strictEqual(error.cause, cause);
      assert.notMatch(error.message, /credential material/u);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("derives bypass permission mode from full-access runtime policy", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.deepEqual(createInput?.options.systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: buildRuntimeInstructions({ harness: "Claude Code" }),
      });
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("listSessions reports only live sessions, matching hasSession", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // A live session is reported by both, keeping the turn-start path's
      // "is there an active session?" check (listSessions) consistent with
      // hasSession's `!stopped` liveness contract.
      assert.equal(yield* adapter.hasSession(THREAD_ID), true);
      assert.equal((yield* adapter.listSessions()).length, 1);
      assert.equal((yield* adapter.listSessions())[0]?.threadId, THREAD_ID);

      // Once stopped, the session is live in neither view — so a follow-up turn
      // resumes a fresh session instead of reusing the dead one.
      yield* adapter.stopSession(THREAD_ID);
      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      assert.deepEqual(yield* adapter.listSessions(), []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("derives auto permission mode from auto runtime policy without skip flag", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "auto",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "auto");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("loads Claude filesystem settings sources for SDK sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, undefined);
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses bypass permissions for full-access claude sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes the configured auto-compaction window to Claude", () => {
    const harness = makeHarness({ claudeConfig: { autoCompactWindow: "300000" } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const options = harness.getLastCreateQueryInput()?.options;
      assert.deepEqual(options?.settings, { autoCompactWindow: 300000 });
      assert.deepEqual(options?.supportedDialogKinds, ["resume_return"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // `options.settings` is `string | Settings` on the SDK type, and only the
  // object form is ever built here. Narrowing once keeps each assertion to the
  // one field it is about.
  const querySettings = (settings: string | Record<string, unknown> | undefined) =>
    typeof settings === "object" && settings !== null ? settings : {};

  // Every style, not one of them. A single hardcoded name is satisfied by a spawn path
  // that forwards only that name and drops the other three.
  for (const style of CLAUDE_OUTPUT_STYLES) {
    it.effect(`passes the configured output style to Claude: ${style}`, () => {
      const harness = makeHarness({ claudeConfig: { outputStyle: style } });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const settings = querySettings(harness.getLastCreateQueryInput()?.options.settings);
        assert.equal(settings.outputStyle, style);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  }

  it.effect("omits the output style key entirely when no style is configured", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // Absence, not falsiness. An unconditional spread would send
      // `{ outputStyle: "" }`, which passes a falsy check while making the CLI
      // receive a `--settings` flag it would otherwise never be given.
      const settings = querySettings(harness.getLastCreateQueryInput()?.options.settings);
      assert.equal(Object.hasOwn(settings, "outputStyle"), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("defaults the auto-compaction window to the model's own window at 1M", () => {
    const harness = makeHarness({ modelCatalog: Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG) });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "contextWindow", value: "1m" }],
        ),
        runtimeMode: "full-access",
      });

      const settings = querySettings(harness.getLastCreateQueryInput()?.options.settings);
      assert.equal(settings.autoCompactWindow, 1_000_000);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("defaults the auto-compaction window for a 1M model with no window option", () => {
    const harness = makeHarness({ modelCatalog: Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG) });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        // claude-opus-4-8 exposes no contextWindow option and is sent WITHOUT
        // the [1m] suffix, so it reaches 1M through selectedClaudeContextWindow's
        // hardcoded switch rather than through a descriptor. It is also the
        // model behind most real threads, so a rule keyed on [1m] would miss it.
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-8",
        ),
        runtimeMode: "full-access",
      });

      const settings = querySettings(harness.getLastCreateQueryInput()?.options.settings);
      assert.equal(settings.autoCompactWindow, 1_000_000);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("leaves the auto-compaction window to Claude below 1M", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "contextWindow", value: "200k" }],
        ),
        runtimeMode: "full-access",
      });

      const settings = querySettings(harness.getLastCreateQueryInput()?.options.settings);
      assert.equal(Object.hasOwn(settings, "autoCompactWindow"), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("leaves the auto-compaction window to Claude when the window is unknown", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const settings = querySettings(harness.getLastCreateQueryInput()?.options.settings);
      assert.equal(Object.hasOwn(settings, "autoCompactWindow"), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("prefers a configured auto-compaction window over the 1M default", () => {
    const harness = makeHarness({ claudeConfig: { autoCompactWindow: "300000" } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "contextWindow", value: "1m" }],
        ),
        runtimeMode: "full-access",
      });

      const settings = querySettings(harness.getLastCreateQueryInput()?.options.settings);
      assert.equal(settings.autoCompactWindow, 300_000);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect.each([
    // Measured against Claude Code 2.1.247 by calling getContextUsage per
    // model. These four resolve their window as "auto", and the CLI then
    // refuses to auto-compact them at all, so t3code hands each its own window.
    { model: "claude-opus-5", expected: 1_000_000 },
    { model: "claude-fable-5", expected: 1_000_000 },
    { model: "claude-haiku-4-5", expected: 200_000 },
    { model: "claude-opus-4-5", expected: 200_000 },
  ])("arms auto-compaction on $model, which Claude Code leaves unarmed", ({ model, expected }) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), model),
        runtimeMode: "full-access",
      });

      const settings = querySettings(harness.getLastCreateQueryInput()?.options.settings);
      assert.equal(settings.autoCompactWindow, expected);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect.each([
    // The other half of the same measurement: Claude Code already arms these
    // from its own model-default tier. Supplying a window would make the
    // `settings` tier win and permanently displace Anthropic's remote tuning —
    // and for claude-sonnet-5, whose bespoke default is 1,000,000, reading our
    // Context Window toggle would have sent 200,000 and cut it by 5.8x.
    //
    // claude-opus-4-6 is pinned at its 200k selection deliberately: our catalog
    // defaults it to "1m", where the CLI leaves it unarmed and the >= 1M rule
    // supplies a window. Only the narrow selection reaches the model-default.
    { model: "claude-sonnet-5", options: [] },
    { model: "claude-sonnet-4-6", options: [] },
    { model: "claude-opus-4-6", options: [{ id: "contextWindow", value: "200k" }] },
  ])("leaves $model to Claude Code, which already arms it", ({ model, options }) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          model,
          options,
        ),
        runtimeMode: "full-access",
      });

      const settings = querySettings(harness.getLastCreateQueryInput()?.options.settings);
      assert.equal(Object.hasOwn(settings, "autoCompactWindow"), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("resolves a percentage against the CLI's window, not the toggle", () => {
    // claude-sonnet-5 is native_1m: it runs at 1,000,000 whatever our Context
    // Window toggle says, and that toggle defaults to "200k" for it. Resolving
    // against the toggle would ask for 120,000 on a 1M session.
    const harness = makeHarness({ claudeConfig: { autoCompactWindow: "60%" } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-5",
          [{ id: "contextWindow", value: "200k" }],
        ),
        runtimeMode: "full-access",
      });

      const settings = querySettings(harness.getLastCreateQueryInput()?.options.settings);
      assert.equal(settings.autoCompactWindow, 600_000);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("resolves a percentage auto-compaction window against the model", () => {
    const harness = makeHarness({
      claudeConfig: { autoCompactWindow: "60%" },
      modelCatalog: Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "contextWindow", value: "1m" }],
        ),
        runtimeMode: "full-access",
      });

      const settings = querySettings(harness.getLastCreateQueryInput()?.options.settings);
      assert.equal(settings.autoCompactWindow, 600_000);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to the 1M default when the configured window is unresolvable", () => {
    // The key guard on the percentage form. `Number("nonsense")` is NaN, and a
    // truthiness check on the raw string would treat this as "configured" and
    // send NO window — which on a >=1M model is classified "auto" and disables
    // compaction outright, the exact defect 946685ce0 fixed.
    const harness = makeHarness({
      claudeConfig: { autoCompactWindow: "nonsense" },
      modelCatalog: Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-8",
        ),
        runtimeMode: "full-access",
      });

      const settings = querySettings(harness.getLastCreateQueryInput()?.options.settings);
      assert.equal(settings.autoCompactWindow, 1_000_000);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude effort levels into query options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "max");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("runs Claude SDK sessions with the configured CLAUDE_CONFIG_DIR", () => {
    const harness = makeHarness({ claudeConfig: { homePath: "~/.claude-work" } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.env?.HOME, NodePath.join(NodeOS.homedir(), ".claude-work"));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it("offers the dispatch instruction only for an exact cursor backend", () => {
    // The gate is the resolved backend string, and `readThreadBackendFile` maps every
    // unreadable state - absent, malformed, empty - onto "default". Fragment match, not prose
    // equality: rewording the instruction must not fail this test.
    assert.match(subagentDispatchAppend("cursor"), /subagent-dispatch/);
    assert.equal(subagentDispatchAppend("default"), "");
    assert.equal(subagentDispatchAppend(""), "");
    assert.equal(subagentDispatchAppend("Cursor"), "");
    assert.equal(subagentDispatchAppend("cursor "), "");
  });

  it("names exit 3 as the only fallback signal", () => {
    // Regression guard for a wording bug that shipped twice in review: the wrapper `exec`s the
    // configured binary, so the binary's own exit code propagates (1 from a failed Cursor run,
    // 127 from a missing cursor-scratch). Any enumeration of "these codes mean you typed it
    // wrong" is therefore incorrect, and a generic "non-zero means offload is off" sends the
    // agent to a Claude subagent after its own mistake.
    const instruction = subagentDispatchAppend("cursor");
    assert.match(instruction, /Exit code 3 means/);
    assert.match(instruction, /Any other non-zero exit is not a fallback signal/);
    assert.notMatch(instruction, /\b6[456]\b/);
  });

  /**
   * Writes the fixture with the SAME function the server writes it with, so the test cannot
   * drift from production's on-disk format.
   */
  const writeFlagFile = (backend: "cursor" | "default") =>
    Effect.gen(function* () {
      const { subagentThreadsDir } = yield* ServerConfig;
      yield* writeThreadBackendFile(
        subagentThreadsDir,
        THREAD_ID,
        backend === "cursor"
          ? {
              ...OFF,
              backend: SUBAGENT_BACKEND_CURSOR,
              instanceId: "cursor",
              model: "auto",
              binaryPath: "/usr/bin/true",
            }
          : OFF,
      );
    });

  /** Each harness owns its base dir, so a fixture written here reaches no other test. */
  const appendForFlagFile = <E = never>(
    write?: Effect.Effect<void, E, FileSystem.FileSystem | Path.Path | ServerConfig>,
  ) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      if (write !== undefined) yield* write;
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      return harness.getLastCreateQueryInput()?.options.systemPrompt;
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  };

  /** Narrows the SDK's `string | string[] | preset` prompt to the preset's appended text. */
  const presetAppend = (systemPrompt: ClaudeQueryOptions["systemPrompt"]): string => {
    assert.ok(
      typeof systemPrompt === "object" &&
        systemPrompt !== null &&
        !Array.isArray(systemPrompt) &&
        systemPrompt.type === "preset",
      "expected a preset system prompt",
    );
    return systemPrompt.append ?? "";
  };

  it.effect("appends the dispatch instruction when the thread's flag file says cursor", () =>
    Effect.gen(function* () {
      const systemPrompt = yield* appendForFlagFile(writeFlagFile("cursor"));
      const append = presetAppend(systemPrompt);
      assert.match(append, /subagent-dispatch/);
      // The runtime block must survive alongside it, not be replaced by it.
      assert.match(append, /<runtime_info>/);
    }),
  );

  it.effect("appends nothing when the thread's flag file says default", () =>
    Effect.gen(function* () {
      const systemPrompt = yield* appendForFlagFile(writeFlagFile("default"));
      const append = presetAppend(systemPrompt);
      assert.notMatch(append, /subagent-dispatch/);
    }),
  );

  it.effect("appends nothing when the thread has no flag file at all", () =>
    Effect.gen(function* () {
      const systemPrompt = yield* appendForFlagFile();
      const append = presetAppend(systemPrompt);
      assert.notMatch(append, /subagent-dispatch/);
    }),
  );

  it.effect("points each session's SUBAGENT_BACKEND_STATE at its own thread flag file", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      const statePath = createInput?.options.env?.SUBAGENT_BACKEND_STATE;
      assert.ok(statePath, "env must carry SUBAGENT_BACKEND_STATE");
      assert.match(statePath, /\/subagent-threads\/[A-Za-z0-9_-]+\.json$/);
      assert.equal(NodePath.basename(statePath), threadBackendFileName(THREAD_ID));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude thinking toggle for models that support it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_THINKING_MODEL,
          [{ id: "thinking", value: false }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      // No auto-compact window rides along here: the thinking model carries no
      // contextWindowTokens, so there is no window to hand back. The models this
      // rule exists for (Haiku 4.5, Opus 4.5) are covered against the bundled
      // catalog in the auto-compaction tests above.
      assert.deepEqual(createInput?.options.settings, { alwaysThinkingEnabled: false });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores Claude thinking toggle for models without it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_STANDARD_MODEL,
          [{ id: "thinking", value: false }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      // The thinking toggle is dropped; the fork's auto-compact window is all that
      // remains, because this model's default window is the expanded 1M one.
      assert.deepEqual(createInput?.options.settings, { autoCompactWindow: 1_000_000 });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude fast mode into SDK settings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "fastMode", value: true }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      // This model's default window is the expanded 1M one, so the fork's
      // auto-compact window rides along - Claude Code will not compact a 1M
      // window on its own.
      assert.deepEqual(createInput?.options.settings, {
        fastMode: true,
        autoCompactWindow: 1_000_000,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores claude fast mode for models without it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_STANDARD_MODEL,
          [{ id: "fastMode", value: true }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      // Fast mode is dropped; the fork's auto-compact window is all that remains,
      // because this model's default window is the expanded 1M one.
      assert.deepEqual(createInput?.options.settings, { autoCompactWindow: 1_000_000 });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "keeps a configured custom alias opaque without disabling the canonical built-in",
    () => {
      const claudeConfig = { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] };
      const customHarness = makeHarness({ claudeConfig });
      const builtInHarness = makeHarness({ claudeConfig });
      const start = (harness: ReturnType<typeof makeHarness>, model: string) =>
        Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: ProviderDriverKind.make("claudeAgent"),
            modelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), model, [
              { id: "effort", value: "max" },
              { id: "fastMode", value: true },
              { id: "contextWindow", value: "expanded" },
            ]),
            runtimeMode: "full-access",
          });
          return harness.getLastCreateQueryInput()!.options;
        }).pipe(
          Effect.provideService(Random.Random, makeDeterministicRandomService()),
          Effect.provide(harness.layer),
        );
      const runCustomFlow = Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
            [
              { id: "effort", value: "max" },
              { id: "fastMode", value: true },
              { id: "contextWindow", value: "expanded" },
            ],
          ),
          runtimeMode: "full-access",
        });
        const options = customHarness.getLastCreateQueryInput()!.options;

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "use the built-in model",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            SYNTHETIC_CLAUDE_CAPABLE_MODEL,
            [{ id: "contextWindow", value: "expanded" }],
          ),
          attachments: [],
        });
        yield* Effect.promise(() => readFirstPromptText(customHarness.getLastCreateQueryInput()));
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "keep this prompt literal",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
            [{ id: "effort", value: "ultrathink" }],
          ),
          attachments: [],
        });
        // FORK: a turn sent while another is running QUEUES behind it instead of
        // going straight to the provider, so the alias is neither applied nor
        // prompted until the running turn completes. Upstream has no queue and
        // needs no result here; without one this read waits forever.
        customHarness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          result: "ok",
          stop_reason: "end_turn",
          session_id: "sdk-session-custom-alias",
        } as unknown as SDKMessage);
        const prompt = yield* Effect.promise(() =>
          readFirstPromptText(customHarness.getLastCreateQueryInput()),
        );
        return { options, prompt };
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(customHarness.layer),
      );

      return Effect.gen(function* () {
        const { options: customOptions, prompt: customPrompt } = yield* runCustomFlow;
        assert.equal(customOptions.model, SYNTHETIC_CLAUDE_COLLIDING_ALIAS);
        assert.equal(customOptions.effort, undefined);
        assert.equal(customOptions.settings, undefined);
        assert.deepEqual(customHarness.query.setModelCalls, [
          `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`,
          SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
        ]);
        assert.equal(customPrompt, "keep this prompt literal");

        const builtInOptions = yield* start(builtInHarness, SYNTHETIC_CLAUDE_CAPABLE_MODEL);
        assert.equal(builtInOptions.model, `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`);
        assert.equal(builtInOptions.effort, "max");
        // The fork's auto-compact window rides along on the expanded window.
        assert.deepEqual(builtInOptions.settings, {
          fastMode: true,
          autoCompactWindow: 1_000_000,
        });
      });
    },
  );

  it.effect("treats ultrathink as a prompt keyword instead of a session effort", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_STANDARD_MODEL,
          [{ id: "effort", value: "ultrathink" }],
        ),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Investigate the edge cases",
        attachments: [],
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_STANDARD_MODEL,
          [{ id: "effort", value: "ultrathink" }],
        ),
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "high");
      const promptText = yield* Effect.promise(() => readFirstPromptText(createInput));
      assert.equal(promptText, "Ultrathink:\nInvestigate the edge cases");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps compact commands intact when ultrathink is selected", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const modelSelection = createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        SYNTHETIC_CLAUDE_STANDARD_MODEL,
        [{ id: "effort", value: "ultrathink" }],
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "/compact",
        attachments: [],
        modelSelection,
      });

      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.equal(promptText, "/compact");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("embeds image attachments in Claude user messages", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-attachments-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-attachments",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          NodeFS.rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const attachment = {
        type: "image" as const,
        id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment)!);
      NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
      NodeFS.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "What's in this image?",
        attachments: [attachment],
      });

      const createInput = harness.getLastCreateQueryInput();
      const promptMessage = yield* Effect.promise(() => readFirstPromptMessage(createInput));
      assert.isDefined(promptMessage);
      assert.deepEqual(promptMessage?.message.content, [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        },
        {
          type: "text",
          text: "What's in this image?",
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // The Claude CLI reads a streamed user message as a slash-command invocation
  // only when the final content block is text. Leading with the text block sent
  // every image-carrying turn down the plain-prompt path, so `/skill args`
  // reached the agent unexpanded with no error anywhere.
  it.effect("puts the command text last so attachments do not suppress expansion", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-attachments-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-command-attachments",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          NodeFS.rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const imageAttachment = {
        type: "image" as const,
        id: "thread-claude-attachment-22345678-1234-1234-1234-123456789abc",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const fileAttachment = {
        type: "file" as const,
        id: "thread-claude-attachment-32345678-1234-1234-1234-123456789abc",
        name: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      };
      for (const attachment of [imageAttachment, fileAttachment]) {
        const attachmentPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment)!);
        NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
        NodeFS.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));
      }

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // FORK: a mid-turn send queues here instead of steering (docs/fork/README.md
      // §5), so each turn is completed before the next one is sent; otherwise the
      // prompt read below waits forever for messages still sitting in the queue.
      const completeTurn = (uuid: string) =>
        Effect.gen(function* () {
          harness.query.emit({
            type: "result",
            subtype: "success",
            is_error: false,
            errors: [],
            num_turns: 1,
            session_id: "sdk-session-1",
            uuid,
          } as unknown as SDKMessage);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
        });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "/flow-patterns hello",
        attachments: [],
      });
      yield* completeTurn("result-1");
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "/flow-patterns hello",
        attachments: [imageAttachment],
      });
      yield* completeTurn("result-2");
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "/flow-patterns hello",
        attachments: [fileAttachment],
      });

      const prompts = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 3),
      );
      const commandBlock = {
        type: "text" as const,
        text: "/flow-patterns hello",
      };

      assert.deepEqual(prompts[0]?.message.content, [commandBlock]);
      assert.deepEqual(prompts[1]?.message.content, [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        },
        commandBlock,
      ]);
      // Non-image attachments never become content blocks. Claude reaches them
      // through the path line ProviderService writes into the prompt, so the
      // text block stays last on its own.
      assert.deepEqual(prompts[2]?.message.content, [commandBlock]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("dispatches a $skill mention as a trailing slash command block", () => {
    // Claude Code only runs `/name` from the message's last text block, so a
    // chip picked mid-prompt is moved there and the surrounding prose kept.
    const homeDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-home-"));
    NodeFS.mkdirSync(NodePath.join(homeDir, "skills", "implement"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(homeDir, "skills", "implement", "SKILL.md"),
      "---\ndescription: Implement the tickets.\n---\n# Body\n",
    );
    const harness = makeHarness({ claudeConfig: { homePath: homeDir } });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(homeDir, { recursive: true, force: true })),
      );
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "ok, now $implement all the tickets\nstart with auth",
        attachments: [],
      });

      const promptMessage = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      assert.deepEqual(promptMessage?.message.content, [
        { type: "text", text: "ok, now" },
        { type: "text", text: "/implement all the tickets\nstart with auth" },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps the skill command block after image attachments", () => {
    // A command block followed by an image is not expanded by the CLI; the
    // image must come first.
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skill-image-"));
    const homeDir = NodePath.join(baseDir, "claude-home");
    NodeFS.mkdirSync(NodePath.join(homeDir, "skills", "review"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(homeDir, "skills", "review", "SKILL.md"),
      "---\ndescription: Review.\n---\n# Body\n",
    );
    const harness = makeHarness({ baseDir, claudeConfig: { homePath: homeDir } });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
      );
      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;
      const attachment = {
        type: "image" as const,
        id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment)!);
      NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
      NodeFS.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "$review this screenshot",
        attachments: [attachment],
      });

      const promptMessage = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      assert.isDefined(promptMessage);
      const blocks = promptMessage.message.content as Array<{ type: string; text?: string }>;
      assert.deepEqual(
        blocks.map((block) => (block.type === "text" ? block.text : block.type)),
        ["image", "/review this screenshot"],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("leaves a $ mention of an unknown or disabled skill as prose", () => {
    const homeDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-off-"));
    NodeFS.mkdirSync(NodePath.join(homeDir, "skills", "deploy"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(homeDir, "skills", "deploy", "SKILL.md"),
      "---\ndescription: Deploy.\n---\n# Body\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(homeDir, "settings.json"),
      JSON.stringify({ skillOverrides: { deploy: "off" } }),
    );
    const harness = makeHarness({ claudeConfig: { homePath: homeDir } });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(homeDir, { recursive: true, force: true })),
      );
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run $deploy and echo $HOME",
        attachments: [],
      });

      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.equal(promptText, "run $deploy and echo $HOME");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude stream/runtime messages to canonical provider runtime events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
        },
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-0",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-3",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: {
              command: "ls",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-4",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-1",
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          content: [{ type: "text", text: "Hi" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-1",
        uuid: "result-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.completed",
          "turn.completed",
        ],
      );

      const turnStarted = runtimeEvents[3];
      assert.equal(turnStarted?.type, "turn.started");
      if (turnStarted?.type === "turn.started") {
        assert.equal(String(turnStarted.turnId), String(turn.turnId));
      }

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Hi");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "command_execution");
      }

      const assistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      assert.equal(
        assistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          assistantCompletedIndex < toolStartedIndex,
        true,
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("places overage-included rate-limit events on the bucket the probe named", () => {
    const scopedLimitNames = Ref.makeUnsafe<ClaudeScopedLimitNames>({ overageIncluded: undefined });
    const harness = makeHarness({ scopedLimitNames });
    const rateLimitEvent = (utilization: number): SDKMessage =>
      ({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "seven_day_overage_included",
          utilization,
        },
        uuid: `rate-limit-${utilization}`,
        session_id: "sdk-session-1",
      }) as unknown as SDKMessage;
    const resultMessage = (uuid: string): SDKMessage =>
      ({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 1,
        session_id: "sdk-session-1",
        uuid,
      }) as unknown as SDKMessage;
    const limitsUpdates = (events: Iterable<ProviderRuntimeEvent>) =>
      Array.from(events).flatMap((event) =>
        event.type === "account.rate-limits.updated" ? [event.payload.limits] : [],
      );
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // Before any probe names the bucket the event has nowhere to land.
      // Collecting through the turn's completion proves the SDK message was
      // handled, not merely still queued.
      const firstTurnFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      harness.query.emit(rateLimitEvent(0.2));
      harness.query.emit(resultMessage("result-1"));
      assert.deepStrictEqual(limitsUpdates(yield* Fiber.join(firstTurnFiber)), []);

      // The status probe reads `get_usage` and records the model it saw.
      yield* Ref.set(scopedLimitNames, { overageIncluded: "Fable" });
      const secondTurnFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId: session.threadId, input: "again", attachments: [] });
      harness.query.emit(rateLimitEvent(0.4));
      harness.query.emit(resultMessage("result-2"));
      assert.deepStrictEqual(limitsUpdates(yield* Fiber.join(secondTurnFiber)), [
        {
          windows: [
            {
              id: "seven_day_fable",
              kind: "weekly",
              label: "Weekly · Fable",
              usedPercent: 40,
              windowDurationMins: 10_080,
            },
          ],
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not emit turn.completed for a result with no active turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Collect through session.exited so the window after the second result
      // is deterministically inside the collection: both results are queued
      // after sendTurn returns and drain in order on the one stream consumer.
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 1,
        session_id: "sdk-session-1",
        uuid: "result-real",
      } as unknown as SDKMessage);

      // Second result with no turn in flight — the shape the resume
      // handshake (system/init + result(num_turns: 0)) delivers, and the
      // same completeTurn branch every no-turnState result lands in. This
      // used to emit an untargeted turn.completed; it must emit nothing.
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        session_id: "sdk-session-1",
        uuid: "result-handshake",
      } as unknown as SDKMessage);

      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const completions = runtimeEvents.filter((event) => event.type === "turn.completed");
      // Exactly one completion — the real turn's, targeted at its turn id.
      // The buggy branch produced a second, untargeted one here.
      assert.equal(completions.length, 1);
      const completed = completions[0];
      if (completed?.type === "turn.completed") {
        assert.equal(String(completed.turnId), String(turn.turnId));
        assert.equal(completed.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("withdraws a queued turn, and refuses one that is not queued", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // First send opens the turn; the second and third queue behind it.
      yield* adapter.sendTurn({
        threadId: session.threadId,
        messageId: MessageId.make("message-running"),
        input: "running",
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        messageId: MessageId.make("message-queued-1"),
        input: "queued one",
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        messageId: MessageId.make("message-queued-2"),
        input: "queued two",
        attachments: [],
      });

      const withdrawnQueued = yield* adapter.withdrawQueuedTurn({
        threadId: session.threadId,
        messageId: MessageId.make("message-queued-1"),
      });
      // The running turn is not in the queue at all, so it cannot be taken back.
      const withdrawnRunning = yield* adapter.withdrawQueuedTurn({
        threadId: session.threadId,
        messageId: MessageId.make("message-running"),
      });
      // Withdrawing the same message twice must not report success twice.
      const withdrawnAgain = yield* adapter.withdrawQueuedTurn({
        threadId: session.threadId,
        messageId: MessageId.make("message-queued-1"),
      });

      assert.equal(withdrawnQueued, true);
      assert.equal(withdrawnRunning, false);
      assert.equal(withdrawnAgain, false);

      // The survivor drains when the running turn completes, and a drained turn
      // is no longer withdrawable — that boundary is the whole race this
      // guards, and it is observable without reaching into the queue.
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 1,
        session_id: "sdk-session-1",
        uuid: "result-real",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const withdrawnAfterDrain = yield* adapter.withdrawQueuedTurn({
        threadId: session.threadId,
        messageId: MessageId.make("message-queued-2"),
      });
      assert.equal(withdrawnAfterDrain, false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("refuses to withdraw a queued turn once it has drained", () => {
    // A turn that has left the queue is on its way to the provider, so
    // reporting it withdrawn would be a lie the user acts on.
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        messageId: MessageId.make("message-running"),
        input: "running",
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        messageId: MessageId.make("message-draining"),
        input: "drains next",
        attachments: [],
      });

      // Complete the running turn to start the drain, then try to withdraw the
      // entry it is mid-way through starting.
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 1,
        session_id: "sdk-session-1",
        uuid: "result-real",
      } as unknown as SDKMessage);

      // One yield is enough for the drain to complete in this harness, where
      // startTurnNow does no I/O.
      yield* Effect.yieldNow;
      const withdrawn = yield* adapter.withdrawQueuedTurn({
        threadId: session.threadId,
        messageId: MessageId.make("message-draining"),
      });

      assert.equal(withdrawn, false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // FORK: upstream's "steers a running turn instead of opening a new one on
  // mid-turn sendTurn" test lived here and is deliberately absent. The fork
  // replaced steering with FIFO queued follow-ups (see the queued-follow-up
  // tests below), so a mid-turn sendTurn opens its OWN turn. Restoring that
  // test asserts a behaviour this adapter no longer has, and it fails.
  it.effect("broadcasts account.usage.updated to active sessions on each poll tick", () => {
    const usageSnapshot = {
      fiveHour: { utilization: 45, resetsAt: "2026-06-04T19:30:00Z" },
      sevenDay: { utilization: 24, resetsAt: "2026-06-08T09:00:00Z" },
      extra: {
        isEnabled: true,
        usedCredits: 43540,
        monthlyLimit: 200000,
        utilization: 21.77,
        currency: "CAD",
      },
    };
    const harness = makeHarness({
      pollAccountUsage: Effect.succeed(usageSnapshot),
      usagePollInterval: Duration.seconds(60),
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const usageFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "account.usage.updated"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-5",
        },
        runtimeMode: "full-access",
      });

      // Advance past the poll interval so the poller fires for the live session.
      yield* TestClock.adjust(Duration.seconds(60));

      const usageEvent = Array.from(yield* Fiber.join(usageFiber))[0];
      assert.isDefined(usageEvent);
      assert.equal(usageEvent?.type, "account.usage.updated");
      assert.equal(usageEvent?.threadId, THREAD_ID);
      assert.deepStrictEqual(usageEvent?.payload, usageSnapshot);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("background tick skips pollAccountUsage when no sessions are active", () => {
    // RED test: without the sessions.size guard, the poller invokes pollAccountUsage
    // on every tick regardless of active sessions.  After the fix it must NOT call
    // pollAccountUsage when sessions.size === 0.
    return Effect.gen(function* () {
      const pollCallCount = yield* Ref.make(0);
      const harness = makeHarness({
        pollAccountUsage: Effect.gen(function* () {
          yield* Ref.update(pollCallCount, (n) => n + 1);
          return null; // null means "no data" — adapter ignores it
        }),
        usagePollInterval: Duration.seconds(60),
      });

      yield* Effect.gen(function* () {
        // Do NOT start any session — sessions.size stays 0.
        // Let the background poller fire several times.
        yield* TestClock.adjust(Duration.seconds(180));

        const count = yield* Ref.get(pollCallCount);
        // With the guard the poller must have called pollAccountUsage zero times.
        assert.equal(count, 0, "pollAccountUsage should not be called when no sessions are active");
      }).pipe(Effect.provide(harness.layer));
    });
  });

  it.effect("on-demand refreshAccountUsage still polls even when no sessions are active", () => {
    // The on-demand path (refreshAccountUsageNow) must ALWAYS call pollAccountUsage
    // regardless of sessions, so a freshly-started session can force a snapshot.
    return Effect.gen(function* () {
      const pollCallCount = yield* Ref.make(0);
      const usageSnapshot = {
        fiveHour: { utilization: 10, resetsAt: "2026-06-10T00:00:00Z" },
        sevenDay: { utilization: 5, resetsAt: "2026-06-15T00:00:00Z" },
        extra: null,
      };
      const harness = makeHarness({
        pollAccountUsage: Effect.gen(function* () {
          yield* Ref.update(pollCallCount, (n) => n + 1);
          return usageSnapshot;
        }),
        // Use a very long poll interval so the background tick never fires
        usagePollInterval: Duration.minutes(999),
      });

      yield* Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        // Explicitly invoke the on-demand refresh with no sessions active.
        yield* adapter.refreshAccountUsage();

        const count = yield* Ref.get(pollCallCount);
        assert.equal(
          count,
          1,
          "on-demand refreshAccountUsage must call pollAccountUsage unconditionally",
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  });

  it.effect("appendSessionNote puts a silent message on the prompt stream", () => {
    // `shouldQuery: false` is the whole mechanism: the SDK appends the message
    // to the transcript and does NOT run the model, so the agent reads it on
    // whatever turn comes next. Verified against Claude CLI 2.1.250 in three
    // conditions - mid-conversation, idle with no turn running (the only state
    // the caller fires in), and across a teardown and `--resume` - each time
    // producing zero assistant turns with the content still reaching the model.
    return Effect.gen(function* () {
      const harness = makeHarness();

      yield* Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-5",
          },
          runtimeMode: "full-access",
        });

        const accepted = yield* adapter.appendSessionNote({
          threadId: THREAD_ID,
          text: "Background task bash-1, launched by one of your subagents, completed.",
        });
        assert.equal(accepted, true);

        const message = yield* Effect.promise(() =>
          readFirstPromptMessage(harness.getLastCreateQueryInput()),
        );
        assert.equal(
          (message as { shouldQuery?: boolean } | undefined)?.shouldQuery,
          false,
          "without shouldQuery:false the note starts a turn, which is the cost being removed",
        );
        const content = message?.message.content;
        assert.equal(
          typeof content === "string" ? content : (content?.[0] as { text?: string })?.text,
          "Background task bash-1, launched by one of your subagents, completed.",
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  });

  it.effect("appendSessionNote refuses when the thread has no live session", () => {
    // The caller's answer to "no" is to start a real turn, so this must be a
    // plain false rather than a failure or a silently-swallowed note.
    return Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const accepted = yield* adapter.appendSessionNote({
          threadId: ThreadId.make("thread-never-started"),
          text: "note",
        });
        assert.equal(accepted, false);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  });

  it.effect("on-demand refreshAccountUsage emits for a thread with no live session", () => {
    // The reported bug: the refresh fanned out over live sessions only, so a
    // press on an idle thread polled the provider and then updated nothing,
    // while the RPC still answered ok. Measured on a developer machine, EVERY
    // Cursor session and 451 of 458 Claude sessions were `stopped`, so "no
    // live session" is the ordinary case rather than the edge.
    return Effect.gen(function* () {
      const usageSnapshot = {
        fiveHour: { utilization: 11, resetsAt: "2026-06-10T00:00:00Z" },
        sevenDay: { utilization: 6, resetsAt: "2026-06-15T00:00:00Z" },
        extra: null,
      };
      const harness = makeHarness({
        pollAccountUsage: Effect.succeed(usageSnapshot),
        usagePollInterval: Duration.minutes(999),
      });
      const idleThreadId = ThreadId.make("thread-with-no-session");

      yield* Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const usageFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "account.usage.updated"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );

        const emitted = yield* adapter.refreshAccountUsage(idleThreadId);
        // Asserted BEFORE joining the fiber, deliberately. A regression here
        // emits nothing, and a test that reaches for the event first would
        // report the whole thing as a 120s timeout instead of `expected 0 to
        // equal 1` - a red run either way, but only one of them says why.
        assert.equal(emitted, 1);

        const usageEvent = Array.from(yield* Fiber.join(usageFiber))[0];
        assert.equal(usageEvent?.threadId, idleThreadId);
        assert.deepStrictEqual(usageEvent?.payload, usageSnapshot);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  });

  it.effect("starting a session with an empty cache forks a prompt on-demand poll", () => {
    // RED-without-fix: with the gated background tick, a session starting while
    // the usage cache is empty must trigger an on-demand poll at start (not wait
    // up to a full poll interval). The poll interval here is huge so the only
    // way pollAccountUsage runs is the session-start fork.
    return Effect.gen(function* () {
      const pollCallCount = yield* Ref.make(0);
      const usageSnapshot = {
        fiveHour: { utilization: 12, resetsAt: "2026-06-10T00:00:00Z" },
        sevenDay: { utilization: 6, resetsAt: "2026-06-15T00:00:00Z" },
        extra: null,
      };
      const harness = makeHarness({
        pollAccountUsage: Effect.gen(function* () {
          yield* Ref.update(pollCallCount, (n) => n + 1);
          return usageSnapshot;
        }),
        usagePollInterval: Duration.minutes(999),
      });

      yield* Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        // Let the background poller run its first (idle, sessions.size === 0)
        // iteration and settle into its long sleep BEFORE any session exists —
        // mirroring a server that has been idle. It must not have polled yet.
        yield* TestClock.adjust(Duration.seconds(1));
        assert.equal(yield* Ref.get(pollCallCount), 0, "idle poller must not poll");

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-5",
          },
          runtimeMode: "full-access",
        });

        // Let the session-start fork run; far under the poll interval so the
        // background tick cannot be the cause of any poll.
        yield* TestClock.adjust(Duration.seconds(1));

        const count = yield* Ref.get(pollCallCount);
        assert.equal(
          count,
          1,
          "a session starting with an empty usage cache must fork exactly one on-demand poll",
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  });

  it.effect("maps Claude reasoning deltas, streamed tool inputs, and tool results", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-thinking",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Let",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-grep-1",
            name: "Grep",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-input-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"pattern":"foo","path":"src"}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-tool-streams",
        uuid: "user-tool-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-grep-1",
              content: "src/example.ts:1:foo",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-tool-streams",
        uuid: "result-tool-streams",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.started",
          "item.updated",
          "item.updated",
          "item.completed",
          "turn.completed",
        ],
      );

      const reasoningDelta = runtimeEvents.find(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      assert.equal(reasoningDelta?.type, "content.delta");
      if (reasoningDelta?.type === "content.delta") {
        assert.equal(reasoningDelta.payload.delta, "Let");
        assert.equal(String(reasoningDelta.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "dynamic_tool_call");
      }

      const toolInputUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { input?: { pattern?: string; path?: string } } | undefined)?.input
            ?.pattern === "foo",
      );
      assert.equal(toolInputUpdated?.type, "item.updated");
      if (toolInputUpdated?.type === "item.updated") {
        assert.deepEqual(toolInputUpdated.payload.data, {
          toolName: "Grep",
          input: {
            pattern: "foo",
            path: "src",
          },
        });
      }

      const toolResultUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { result?: { tool_use_id?: string } } | undefined)?.result
            ?.tool_use_id === "tool-grep-1",
      );
      assert.equal(toolResultUpdated?.type, "item.updated");
      if (toolResultUpdated?.type === "item.updated") {
        assert.equal(
          (
            toolResultUpdated.payload.data as {
              result?: { content?: string };
            }
          ).result?.content,
          "src/example.ts:1:foo",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies only streamed Read image inputs as image views", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "inspect both files",
        attachments: [],
      });

      const imagePath = `/workspace/${"nested folder/".repeat(16)}reference image.webp`;
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-read-image",
        uuid: "read-image-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-read-image",
            name: "Read",
            input: {},
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-read-image",
        uuid: "read-image-input",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: encodeUnknownJsonString({ file_path: imagePath }),
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-read-image",
        uuid: "read-image-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-read-image",
              content: "Image Size: 1280x720.",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-read-image",
        uuid: "read-text-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-read-text",
            name: "Read",
            input: { file_path: "/workspace/src/index.ts" },
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-read-image",
        uuid: "read-text-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-read-text",
              content: "export {};",
            },
          ],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-read-image",
        uuid: "read-image-turn-result",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const imageEvents = runtimeEvents.filter(
        (
          event,
        ): event is Extract<
          ProviderRuntimeEvent,
          { type: "item.started" | "item.updated" | "item.completed" }
        > =>
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          String(event.itemId) === "tool-read-image",
      );
      assert.deepEqual(
        imageEvents.map((event) => [event.type, event.payload.itemType]),
        [
          ["item.started", "dynamic_tool_call"],
          ["item.updated", "image_view"],
          ["item.updated", "image_view"],
          ["item.completed", "image_view"],
        ],
      );
      for (const event of imageEvents.slice(1)) {
        assert.equal(event.payload.detail, imagePath);
        assert.equal(
          (event.payload.data as { input?: { file_path?: string } } | undefined)?.input?.file_path,
          imagePath,
        );
      }

      const textEvents = runtimeEvents.filter(
        (
          event,
        ): event is Extract<
          ProviderRuntimeEvent,
          { type: "item.started" | "item.updated" | "item.completed" }
        > =>
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          String(event.itemId) === "tool-read-text",
      );
      assert.deepEqual(
        textEvents.map((event) => event.payload.itemType),
        ["dynamic_tool_call", "dynamic_tool_call", "dynamic_tool_call"],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to a default plan step label for blank TodoWrite content", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-todo-1",
            name: "TodoWrite",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-input",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json:
              '{"todos":[{"content":"   ","status":"in_progress"},{"content":"Ship it","status":"completed"}]}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-todo-plan",
        uuid: "result-todo-plan",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const planUpdated = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      assert.equal(planUpdated?.type, "turn.plan.updated");
      if (planUpdated?.type === "turn.plan.updated") {
        assert.equal(String(planUpdated.turnId), String(turn.turnId));
        assert.deepEqual(planUpdated.payload.plan, [
          { step: "Task", status: "inProgress" },
          { step: "Ship it", status: "completed" },
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("accumulates turn.plan.updated from TaskCreate/TaskUpdate tool results", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const emitTaskToolCycle = (input: {
        index: number;
        toolUseId: string;
        toolName: "TaskCreate" | "TaskUpdate";
        inputJson: string;
        resultText: string;
        toolUseResult?: unknown;
      }) => {
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-task-plan",
          uuid: `stream-task-start-${input.index}`,
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: input.index,
            content_block: {
              type: "tool_use",
              id: input.toolUseId,
              name: input.toolName,
              input: {},
            },
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-task-plan",
          uuid: `stream-task-input-${input.index}`,
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: input.index,
            delta: {
              type: "input_json_delta",
              partial_json: input.inputJson,
            },
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-task-plan",
          uuid: `stream-task-stop-${input.index}`,
          parent_tool_use_id: null,
          event: {
            type: "content_block_stop",
            index: input.index,
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "user",
          session_id: "sdk-session-task-plan",
          uuid: `user-task-result-${input.index}`,
          parent_tool_use_id: null,
          ...(input.toolUseResult !== undefined ? { tool_use_result: input.toolUseResult } : {}),
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: input.toolUseId,
                content: input.resultText,
              },
            ],
          },
        } as unknown as SDKMessage);
      };

      emitTaskToolCycle({
        index: 1,
        toolUseId: "tool-task-create-1",
        toolName: "TaskCreate",
        inputJson: '{"subject":"Inspect repository","description":"Look around"}',
        resultText: "Task #1 created successfully: Inspect repository",
        toolUseResult: { task: { id: "1", subject: "Inspect repository" } },
      });
      emitTaskToolCycle({
        index: 2,
        toolUseId: "tool-task-create-2",
        toolName: "TaskCreate",
        inputJson: '{"subject":"Report findings","description":"Write it up"}',
        resultText: "Task #2 created successfully: Report findings",
        toolUseResult: { task: { id: "2", subject: "Report findings" } },
      });
      emitTaskToolCycle({
        index: 3,
        toolUseId: "tool-task-update-1",
        toolName: "TaskUpdate",
        inputJson: '{"taskId":"1","status":"in_progress"}',
        resultText: "Updated task #1 status",
        toolUseResult: {
          success: true,
          taskId: "1",
          updatedFields: ["status"],
          statusChange: { from: "pending", to: "in_progress" },
        },
      });
      emitTaskToolCycle({
        index: 4,
        toolUseId: "tool-task-update-2",
        toolName: "TaskUpdate",
        inputJson: '{"taskId":"2","status":"deleted"}',
        resultText: "Updated task #2 deleted",
        toolUseResult: {
          success: true,
          taskId: "2",
          updatedFields: ["status"],
          statusChange: { from: "pending", to: "deleted" },
        },
      });
      // Failed update: not an is_error result, must not mutate the plan.
      emitTaskToolCycle({
        index: 5,
        toolUseId: "tool-task-update-3",
        toolName: "TaskUpdate",
        inputJson: '{"taskId":"99","status":"completed"}',
        resultText: "Task #99 not found",
        toolUseResult: { success: false, taskId: "99", updatedFields: [], error: "not found" },
      });
      // No-op update: nothing changed, must not re-emit the plan.
      emitTaskToolCycle({
        index: 6,
        toolUseId: "tool-task-update-4",
        toolName: "TaskUpdate",
        inputJson: '{"taskId":"1","status":"in_progress"}',
        resultText: "Updated task #1 status",
        toolUseResult: {
          success: true,
          taskId: "1",
          updatedFields: ["status"],
          statusChange: { from: "in_progress", to: "in_progress" },
        },
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-task-plan",
        uuid: "result-task-plan",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const planUpdates = runtimeEvents.filter((event) => event.type === "turn.plan.updated");
      assert.deepEqual(
        planUpdates.map((event) => (event.type === "turn.plan.updated" ? event.payload.plan : [])),
        [
          [{ step: "Inspect repository", status: "pending" }],
          [
            { step: "Inspect repository", status: "pending" },
            { step: "Report findings", status: "pending" },
          ],
          [
            { step: "Inspect repository", status: "inProgress" },
            { step: "Report findings", status: "pending" },
          ],
        ],
      );
      for (const planUpdate of planUpdates) {
        if (planUpdate.type === "turn.plan.updated") {
          assert.equal(String(planUpdate.turnId), String(turn.turnId));
        }
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("applies structured task results and reseeds the plan from TaskList", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const emitToolUse = (input: {
        index: number;
        toolUseId: string;
        toolName: string;
        inputJson: string;
      }) => {
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-task-coalesce",
          uuid: `stream-start-${input.index}`,
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: input.index,
            content_block: {
              type: "tool_use",
              id: input.toolUseId,
              name: input.toolName,
              input: {},
            },
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-task-coalesce",
          uuid: `stream-input-${input.index}`,
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: input.index,
            delta: {
              type: "input_json_delta",
              partial_json: input.inputJson,
            },
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-task-coalesce",
          uuid: `stream-stop-${input.index}`,
          parent_tool_use_id: null,
          event: {
            type: "content_block_stop",
            index: input.index,
          },
        } as unknown as SDKMessage);
      };

      // Subjects come from the structured result, so a create whose streamed
      // input JSON never parsed still lands in the plan.
      emitToolUse({
        index: 1,
        toolUseId: "tool-create-a",
        toolName: "TaskCreate",
        inputJson: '{"subject":"Plan the work","description":"d"}',
      });
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-task-coalesce",
        uuid: "user-task-result-a",
        parent_tool_use_id: null,
        tool_use_result: { task: { id: "1", subject: "Plan the work" } },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-create-a",
              content: "Task #1 created successfully: Plan the work",
            },
          ],
        },
      } as unknown as SDKMessage);
      emitToolUse({
        index: 2,
        toolUseId: "tool-create-b",
        toolName: "TaskCreate",
        inputJson: '{"subject":',
      });
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-task-coalesce",
        uuid: "user-task-result-b",
        parent_tool_use_id: null,
        tool_use_result: { task: { id: "2", subject: "Execute the work" } },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-create-b",
              content: "Task #2 created successfully: Execute the work",
            },
          ],
        },
      } as unknown as SDKMessage);

      // TaskList result reseeds the whole plan: renumbered ids, a status the
      // session never saw, a task recovered from a prior session.
      emitToolUse({
        index: 3,
        toolUseId: "tool-list-1",
        toolName: "TaskList",
        inputJson: "{}",
      });
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-task-coalesce",
        uuid: "user-task-list-result",
        parent_tool_use_id: null,
        tool_use_result: {
          tasks: [
            { id: "1", subject: "Plan the work", status: "completed", blockedBy: [] },
            { id: "2", subject: "Execute the work", status: "in_progress", blockedBy: ["1"] },
            { id: "5", subject: "Recovered after restart", status: "pending", blockedBy: [] },
          ],
        },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-list-1",
              content:
                "#1 [completed] Plan the work\n#2 [in_progress] Execute the work [blocked by #1]\n#5 [pending] Recovered after restart",
            },
          ],
        },
      } as unknown as SDKMessage);

      // Missing structured result keeps the current plan (no wipe, no emit).
      emitToolUse({
        index: 4,
        toolUseId: "tool-list-2",
        toolName: "TaskList",
        inputJson: "{}",
      });
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-task-coalesce",
        uuid: "user-task-list-garbage",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-list-2",
              content: "Tasks: everything is fine",
            },
          ],
        },
      } as unknown as SDKMessage);

      // Empty TaskList result: no non-empty roster to reseed from, so the plan
      // is left as-is and no further plan update is emitted.
      emitToolUse({
        index: 5,
        toolUseId: "tool-list-3",
        toolName: "TaskList",
        inputJson: "{}",
      });
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-task-coalesce",
        uuid: "user-task-list-empty",
        parent_tool_use_id: null,
        tool_use_result: { tasks: [] },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-list-3",
              content: "No tasks found",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-task-coalesce",
        uuid: "result-task-coalesce",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const planUpdates = runtimeEvents.filter((event) => event.type === "turn.plan.updated");
      assert.deepEqual(
        planUpdates.map((event) => (event.type === "turn.plan.updated" ? event.payload.plan : [])),
        [
          [{ step: "Plan the work", status: "pending" }],
          [
            { step: "Plan the work", status: "pending" },
            { step: "Execute the work", status: "pending" },
          ],
          [
            { step: "Plan the work", status: "completed" },
            { step: "Execute the work (blocked by #1)", status: "inProgress" },
            { step: "Recovered after restart", status: "pending" },
          ],
        ],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Claude Task tool invocations as collaboration agent work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task",
        uuid: "stream-task-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-1",
            name: "Task",
            input: {
              description: "Review the database layer",
              prompt: "Audit the SQL changes",
              subagent_type: "code-reviewer",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-agent-1",
        description: "Review the database layer",
        task_type: "local_agent",
        tool_use_id: "tool-task-1",
        uuid: "task-agent-1-uuid",
        session_id: "sdk-session-task",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-task",
        uuid: "assistant-task-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-task-1",
          content: [{ type: "text", text: "Delegated" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
          output_tokens: 20,
        },
        session_id: "sdk-session-task",
        uuid: "result-task-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "collab_agent_tool_call");
        assert.equal(toolStarted.payload.title, "Subagent task");
      }
      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.tokenUsage?.hasSubagents, true);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats user-aborted Claude results as interrupted without a runtime error", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        errors: ["Error: Request was aborted."],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 12,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 1,
          output_tokens: 4,
        },
        session_id: "sdk-session-abort",
        uuid: "result-abort",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "thread.token-usage.updated",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Error: Request was aborted.");
        assert.equal(turnCompleted.payload.stopReason, "tool_use");
        assert.deepEqual(turnCompleted.payload.tokenUsage, {
          usageStatus: "partial",
          usageScope: "main_agent",
          inputTokens: 16,
          cachedInputTokens: 3,
          cacheCreationTokens: 1,
          outputTokens: 4,
          hasSubagents: false,
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "treats a Stop-aborted mid-tool-use result as interrupted without surfacing the ede_diagnostic",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        // No runtime.error must be emitted, so the stream still closes at 6 events.
        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        // Reproduces the exact CLI payload when the user hits Stop mid tool_use:
        // is_error=true, terminal_reason=aborted_streaming, and an internal-only
        // diagnostic as the sole error entry.
        harness.query.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "aborted_streaming",
          errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
          stop_reason: "tool_use",
          session_id: "sdk-session-stop",
          uuid: "result-stop",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepEqual(
          runtimeEvents.map((event) => event.type),
          [
            "session.started",
            "session.configured",
            "session.state.changed",
            "turn.started",
            "thread.started",
            "turn.completed",
          ],
        );
        assert.equal(
          runtimeEvents.some((event) => event.type === "runtime.error"),
          false,
        );

        const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
        assert.equal(turnCompleted?.type, "turn.completed");
        if (turnCompleted?.type === "turn.completed") {
          assert.equal(String(turnCompleted.turnId), String(turn.turnId));
          assert.equal(turnCompleted.payload.state, "interrupted");
          // The diagnostic is the only error, so nothing user-facing is persisted.
          assert.equal(turnCompleted.payload.errorMessage, undefined);
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("filters ede_diagnostic noise from a genuine failed result's error message", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // A genuine failure emits a runtime.error too, so expect 7 events.
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [
          "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
          "Error: model overloaded",
        ],
        stop_reason: null,
        session_id: "sdk-session-fail",
        uuid: "result-fail",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      const runtimeError = runtimeEvents.find((event) => event.type === "runtime.error");
      assert.equal(runtimeError?.type, "runtime.error");
      if (runtimeError?.type === "runtime.error") {
        assert.equal(runtimeError.payload.message, "Error: model overloaded");
        assert.equal(runtimeError.payload.class, "provider_error");
      }

      const turnCompleted = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "failed");
        assert.equal(turnCompleted.payload.errorMessage, "Error: model overloaded");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // The CLI reports a provider HTTP failure as subtype:"success" with is_error:true and the
  // message in `result` — `subtype` names the payload shape, not the outcome. Reading `subtype`
  // recorded these as clean completions, which users experienced as a frozen thread. Measured
  // across 720 retained result payloads: 5 real failures (400 GPU-OOM, 500, OAuth expiry, and
  // two 429 session-limit) all reported success. No fixture paired subtype:"success" with
  // is_error:true before these — the untested quadrant was the production one.
  const successShapedErrorResult = (overrides: Record<string, unknown>) =>
    ({
      type: "result",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      stop_reason: "stop_sequence",
      session_id: "sdk-session-api-error",
      uuid: "result-api-error",
      ...overrides,
    }) as unknown as SDKMessage;

  it.effect(
    "reports a provider api_error result as a failed turn carrying the provider text",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        // A genuine failure emits runtime.error as well, so 7 events.
        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          attachments: [],
        });

        harness.query.emit(
          successShapedErrorResult({
            api_error_status: 400,
            result:
              "API Error: 400 Prompt (121404 tokens) requires ~46098MB GPU memory but only ~45536MB available.",
          }),
        );

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        const runtimeError = runtimeEvents.find((event) => event.type === "runtime.error");
        assert.equal(runtimeError?.type, "runtime.error");
        if (runtimeError?.type === "runtime.error") {
          assert.equal(
            runtimeError.payload.message,
            "API Error: 400 Prompt (121404 tokens) requires ~46098MB GPU memory but only ~45536MB available.",
          );
        }

        const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
        assert.equal(turnCompleted?.type, "turn.completed");
        if (turnCompleted?.type === "turn.completed") {
          assert.equal(String(turnCompleted.turnId), String(turn.turnId));
          assert.equal(turnCompleted.payload.state, "failed");
          assert.equal(
            turnCompleted.payload.errorMessage,
            "API Error: 400 Prompt (121404 tokens) requires ~46098MB GPU memory but only ~45536MB available.",
          );
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  // A user Stop also sets is_error on a success-shaped payload, but there `result` holds the
  // partial assistant reply. Classifying that as a failure would put the model's own prose in
  // an error banner. Guards isAbortedResult winning over the new failure branch.
  it.effect("keeps a success-shaped aborted result interrupted, with no error message", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      // Interrupted emits no runtime.error, so the stream closes at 6.
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      harness.query.emit(
        successShapedErrorResult({
          terminal_reason: "aborted_streaming",
          result: "Sure — I'll start by reading the config file and then",
        }),
      );

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(
        runtimeEvents.some((event) => event.type === "runtime.error"),
        false,
      );
      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, undefined);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // 706 of 720 retained payloads are this shape. Also pins the truthiness check: an absent
  // is_error must complete, so `!result.is_error` cannot be swapped for `=== false`.
  it.effect("still completes a success result whose is_error flag is absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      harness.query.emit({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: "All done.",
        session_id: "sdk-session-no-flag",
        uuid: "result-no-flag",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(
        runtimeEvents.some((event) => event.type === "runtime.error"),
        false,
      );
      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "completed");
        assert.equal(turnCompleted.payload.errorMessage, undefined);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // 35 of 720 payloads ship a blank `result`. Without the trim an implementer emits "   " into
  // a field typed TrimmedNonEmptyString, and the turn still has to complete.
  it.effect("falls back to a generic message when a failed result's text is blank", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      harness.query.emit(successShapedErrorResult({ result: "   " }));

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const runtimeError = runtimeEvents.find((event) => event.type === "runtime.error");
      assert.equal(runtimeError?.type, "runtime.error");
      if (runtimeError?.type === "runtime.error") {
        assert.equal(runtimeError.payload.message, "Claude turn failed.");
      }
      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "failed");
        assert.equal(turnCompleted.payload.errorMessage, undefined);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // The CLI runs ahead of the typed SDK — it already emits a terminal_reason the union does not
  // declare. Reading `result` unguarded turns a non-string into a thrown defect, which
  // Effect.mapError does not catch, tearing down the whole session: worse than the bug.
  it.effect("survives a failed result whose text is not a string", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      harness.query.emit(successShapedErrorResult({ result: { message: "not a string" } }));

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const runtimeError = runtimeEvents.find((event) => event.type === "runtime.error");
      assert.equal(runtimeError?.type, "runtime.error");
      if (runtimeError?.type === "runtime.error") {
        assert.equal(runtimeError.payload.message, "Claude turn failed.");
      }
      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "failed");
        assert.equal(turnCompleted.payload.errorMessage, undefined);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // The diagnostic can sit on any line of an api_error payload, so the filter runs per line.
  // A whole-blob prefix test leaks it from line 2 and discards a real message from line 1.
  it.effect("strips an ede_diagnostic line from anywhere in a failed result's text", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      harness.query.emit(
        successShapedErrorResult({
          api_error_status: 429,
          result:
            "You've hit your session limit\n[ede_diagnostic] result_type=user stop_reason=tool_use",
        }),
      );

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "failed");
        assert.equal(turnCompleted.payload.errorMessage, "You've hit your session limit");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // A runtime.error with no turnId is applied unconditionally by the ingestion lifecycle guard,
  // so emitting one for a result that has no turn in flight stomps whatever turn IS running:
  // the session flips to error and the composer un-busies mid-turn. completeTurn already
  // dropped its untargeted turn.completed for this reason; the error emit must match.
  it.effect("emits no runtime.error for a failed result with no active turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      // Closes the real turn, so the next result lands with no turnState.
      harness.query.emit({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { post_tokens: 40 },
        session_id: "sdk-session-compacted-usage",
        uuid: "compact-boundary-post-usage",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 1,
        session_id: "sdk-session-orphan",
        uuid: "result-real",
      } as unknown as SDKMessage);

      // The resume-handshake shape, but carrying a provider api_error. Nothing may be emitted:
      // there is no turn to attribute it to.
      harness.query.emit(
        successShapedErrorResult({
          num_turns: 0,
          api_error_status: 500,
          result: "API Error: 500 fetch failed",
          uuid: "result-orphan",
        }),
      );

      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.filter((event) => event.type === "runtime.error"),
        [],
      );
      const completions = runtimeEvents.filter((event) => event.type === "turn.completed");
      assert.equal(completions.length, 1);
      const completed = completions[0];
      if (completed?.type === "turn.completed") {
        assert.equal(String(completed.turnId), String(turn.turnId));
        assert.equal(completed.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("fails a turn when the result carries a give-up terminal_reason", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      // The CLI stamps subtype success with an empty error list when it
      // gives up after exhausting API retries; the terminal_reason is the
      // only structured failure signal.
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        errors: [],
        stop_reason: null,
        terminal_reason: "api_error",
        session_id: "sdk-session-api-error",
        uuid: "result-api-error",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "runtime.error",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "failed");
        assert.equal(
          turnCompleted.payload.errorMessage,
          "Claude gave up after repeated API errors.",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  const AUTH_FAILURE_ASSISTANT = {
    type: "assistant",
    session_id: "sdk-session-auth",
    uuid: "assistant-auth",
    parent_tool_use_id: null,
    error: "authentication_failed",
    is_api_error_message: true,
    message: {
      id: "assistant-message-auth",
      model: "<synthetic>",
      content: [{ type: "text", text: "Not logged in \u00b7 Please run /login" }],
    },
  } as unknown as SDKMessage;

  const completedTurn = (runtimeEvents: ReadonlyArray<ProviderRuntimeEvent>) => {
    const event = runtimeEvents[runtimeEvents.length - 1];
    assert.equal(event?.type, "turn.completed");
    assert(event?.type === "turn.completed");
    return event.payload;
  };

  it.effect.each([
    {
      name: "an api_error terminal reason",
      result: { subtype: "success", is_error: false, terminal_reason: "api_error", errors: [] },
      state: "failed",
      errorMessage: /claude auth login/,
    },
    {
      name: "an is_error success with no terminal reason",
      result: { subtype: "success", is_error: true, errors: [] },
      state: "failed",
      errorMessage: /claude auth login/,
    },
    // Every other outcome names its own cause, and the latch must not speak over it.
    {
      name: "a terminal reason of its own",
      result: {
        subtype: "success",
        is_error: false,
        terminal_reason: "prompt_too_long",
        errors: [],
      },
      state: "failed",
      errorMessage: /prompt exceeds the model's context window/,
    },
    {
      name: "a listed tool failure",
      result: {
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Tool execution failed: EACCES"],
      },
      state: "failed",
      errorMessage: /EACCES/,
    },
    {
      name: "a user interrupt",
      result: {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_tools",
        errors: [],
      },
      state: "interrupted",
      errorMessage: undefined,
    },
    {
      name: "a cancellation",
      result: { subtype: "error_during_execution", is_error: true, errors: ["cancelled"] },
      state: "cancelled",
      errorMessage: /cancelled/,
    },
  ])(
    "reports the real cause when an expired login is followed by $name",
    ({ result, state, errorMessage }) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });

        harness.query.emit(AUTH_FAILURE_ASSISTANT);
        harness.query.emit({
          type: "result",
          ...result,
          session_id: "sdk-session-auth",
          uuid: "result-auth",
        } as unknown as SDKMessage);

        const payload = completedTurn(Array.from(yield* Fiber.join(runtimeEventsFiber)));
        assert.equal(payload.state, state);
        if (errorMessage === undefined) {
          assert.equal(payload.errorMessage, undefined);
        } else {
          assert.match(payload.errorMessage ?? "", errorMessage);
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("fails a usage-limited turn with the limit it parked on", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });

      const nowMs = yield* Clock.currentTimeMillis;
      harness.query.emit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: Math.floor(nowMs / 1000) + 2 * 60 * 60,
        },
        session_id: "sdk-session-limit",
        uuid: "rate-limit-rejected",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        terminal_reason: "api_error",
        errors: [],
        session_id: "sdk-session-limit",
        uuid: "result-limit",
      } as unknown as SDKMessage);

      const payload = completedTurn(Array.from(yield* Fiber.join(runtimeEventsFiber)));
      assert.equal(payload.state, "failed");
      assert.equal(
        payload.errorMessage,
        "Claude usage limit reached. Send the message again once the limit resets.",
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  const usageLimitMessage =
    "Claude usage limit reached. Send the message again once the limit resets.";
  const genericApiErrorMessage = "Claude gave up after repeated API errors.";
  const rateLimitAssistant = {
    type: "assistant",
    session_id: "sdk-session-limit",
    uuid: "assistant-limit",
    parent_tool_use_id: null,
    error: "rate_limit",
    message: {
      id: "assistant-message-limit",
      model: "<synthetic>",
      content: [{ type: "text", text: "You've hit your session limit" }],
    },
  };
  const rateLimitResult = {
    type: "result",
    subtype: "success",
    is_error: true,
    terminal_reason: "api_error",
    session_id: "sdk-session-limit",
    uuid: "result-limit",
  };

  it.effect.each([
    {
      name: "an assistant-only rate limit",
      messages: [rateLimitAssistant],
      expected: usageLimitMessage,
    },
    {
      name: "a normal parent response after a rate limit",
      messages: [rateLimitAssistant, { ...rateLimitAssistant, error: undefined }],
      expected: genericApiErrorMessage,
    },
    {
      name: "a server error after a rate limit",
      messages: [rateLimitAssistant, { ...rateLimitAssistant, error: "server_error" }],
      expected: genericApiErrorMessage,
    },
    {
      name: "a subagent rate limit",
      messages: [{ ...rateLimitAssistant, parent_tool_use_id: "nested-tool" }],
      expected: genericApiErrorMessage,
    },
    {
      name: "a subagent response after a parent rate limit",
      messages: [
        rateLimitAssistant,
        { ...rateLimitAssistant, error: undefined, parent_tool_use_id: "nested-tool" },
      ],
      expected: usageLimitMessage,
    },
  ])("classifies the terminal API failure after $name", ({ messages, expected }) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      for (const [index, message] of messages.entries()) {
        harness.query.emit({ ...message, uuid: `assistant-${index}` } as unknown as SDKMessage);
      }
      harness.query.emit(rateLimitResult as unknown as SDKMessage);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const errors = events.filter((event) => event.type === "runtime.error");
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.payload.message, expected);
      assert.equal(completedTurn(events).state, "failed");
      assert.equal(completedTurn(events).errorMessage, expected);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("names repeated usage limits without carrying them into a later turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      for (const [index, expected] of [
        usageLimitMessage,
        usageLimitMessage,
        genericApiErrorMessage,
      ].entries()) {
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({ threadId: session.threadId, input: "again", attachments: [] });
        if (index === 0) {
          harness.query.emit({
            type: "rate_limit_event",
            rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
            session_id: "sdk-session-limit",
            uuid: "limit-rejected",
          } as unknown as SDKMessage);
        }
        if (index < 2) {
          harness.query.emit({
            ...rateLimitAssistant,
            uuid: `assistant-limit-${index}`,
          } as unknown as SDKMessage);
        }
        harness.query.emit({
          ...rateLimitResult,
          uuid: `result-limit-${index}`,
        } as unknown as SDKMessage);
        const payload = completedTurn(Array.from(yield* Fiber.join(eventsFiber)));
        assert.equal(payload.state, "failed");
        assert.equal(payload.errorMessage, expected);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect.each([
    {
      name: "listed error with api_error",
      evidence: "auth",
      result: {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "api_error",
        errors: ["Tool execution failed: EACCES"],
      },
      expected: /EACCES/,
      expectedState: "failed",
    },
    {
      name: "overload with api_error",
      evidence: "auth",
      result: {
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 529,
        errors: [],
      },
      expected: /overloaded \(529\)/,
      expectedState: "failed",
    },
    {
      name: "listed error on an is_error success",
      evidence: "auth",
      result: {
        subtype: "success",
        is_error: true,
        errors: ["Tool execution failed: EACCES"],
      },
      expected: /EACCES/,
      expectedState: "failed",
    },
    {
      name: "recovered same window",
      evidence: "recovered",
      result: { subtype: "success", is_error: false, terminal_reason: "api_error", errors: [] },
      expected: /repeated API errors/,
      expectedState: "failed",
    },
    {
      name: "nested assistant does not poison parent",
      evidence: "nested-auth",
      result: { subtype: "success", is_error: false, terminal_reason: "api_error", errors: [] },
      expected: /repeated API errors/,
      expectedState: "failed",
    },
    {
      name: "assistant rate limit followed by overload",
      evidence: "assistant-rate-limit",
      result: {
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 529,
        errors: [],
      },
      expected: /overloaded \(529\)/,
      expectedState: "failed",
    },
    {
      name: "assistant rate limit followed by a listed error",
      evidence: "assistant-rate-limit",
      result: {
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        errors: ["Tool execution failed: EACCES"],
      },
      expected: /EACCES/,
      expectedState: "failed",
    },
    {
      name: "assistant rate limit followed by an interrupt",
      evidence: "assistant-rate-limit",
      result: {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_tools",
        errors: [],
      },
      expected: undefined,
      expectedState: "interrupted",
    },
    ...[
      "recovered-missing-reset",
      "recovered-next-reset",
      "recovered-warning",
      "two-windows-recovered",
    ].map((evidence) => ({
      name: evidence,
      evidence,
      result: { subtype: "success", is_error: false, terminal_reason: "api_error", errors: [] },
      expected: /repeated API errors/,
      expectedState: "failed",
    })),
    ...["two-windows-one-recovered", "rejected-again"].map((evidence) => ({
      name: evidence,
      evidence,
      result: { subtype: "success", is_error: false, terminal_reason: "api_error", errors: [] },
      expected: /usage limit reached/,
      expectedState: "failed",
    })),
    {
      name: "successful turn stays successful",
      evidence: "recovered",
      result: { subtype: "success", is_error: false, errors: [] },
      expected: undefined,
      expectedState: "completed",
    },
  ])(
    "preserves terminal failure evidence after $name",
    ({ evidence, result, expected, expectedState }) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "synthetic hello",
          attachments: [],
        });
        if (evidence === "assistant-rate-limit") {
          harness.query.emit(rateLimitAssistant as unknown as SDKMessage);
        } else if (evidence === "auth" || evidence === "nested-auth") {
          harness.query.emit({
            type: "assistant",
            session_id: "sdk-audit",
            uuid: "audit-auth",
            parent_tool_use_id: evidence === "nested-auth" ? "synthetic-parent-tool" : null,
            error: "authentication_failed",
            is_api_error_message: true,
            message: {
              id: "audit-message",
              model: "synthetic-audit-model",
              content: [{ type: "text", text: "Not logged in. Please run /login" }],
            },
          } as unknown as SDKMessage);
        } else {
          const nowMs = yield* Clock.currentTimeMillis;
          const resetsAt = Math.floor(nowMs / 1000) + 7200;
          harness.query.emit({
            type: "rate_limit_event",
            rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt },
            session_id: "sdk-audit",
            uuid: "audit-limit-rejected",
          } as unknown as SDKMessage);
          if (evidence.startsWith("two-windows")) {
            harness.query.emit({
              type: "rate_limit_event",
              rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt },
              session_id: "sdk-audit",
              uuid: "audit-weekly-rejected",
            } as unknown as SDKMessage);
          }
          harness.query.emit({
            type: "rate_limit_event",
            rate_limit_info: {
              status: evidence === "recovered-warning" ? "allowed_warning" : "allowed",
              rateLimitType: "five_hour",
              ...(evidence === "recovered-missing-reset"
                ? {}
                : {
                    resetsAt: evidence === "recovered-next-reset" ? resetsAt + 18000 : resetsAt,
                  }),
            },
            session_id: "sdk-audit",
            uuid: "audit-limit-allowed",
          } as unknown as SDKMessage);
          if (evidence === "two-windows-recovered" || evidence === "rejected-again") {
            harness.query.emit({
              type: "rate_limit_event",
              rate_limit_info: {
                status: evidence === "rejected-again" ? "rejected" : "allowed",
                rateLimitType: evidence === "rejected-again" ? "five_hour" : "seven_day",
                resetsAt,
              },
              session_id: "sdk-audit",
              uuid: "audit-final-quota-update",
            } as unknown as SDKMessage);
          }
        }
        harness.query.emit({
          type: "result",
          ...result,
          session_id: "sdk-audit",
          uuid: "audit-result",
        } as unknown as SDKMessage);
        const events = Array.from(yield* Fiber.join(eventsFiber));
        const complete = events.at(-1);
        assert(complete?.type === "turn.completed");
        assert.equal(complete.payload.state, expectedState);
        if (expected) assert.match(complete.payload.errorMessage ?? "", expected);
        else assert.equal(complete.payload.errorMessage, undefined);
        if (evidence === "rejected-again")
          assert.equal(events.filter((event) => event.type === "runtime.warning").length, 1);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  // Upstream drives these rows off `homePath`, which its `makeClaudeEnvironment` maps straight
  // onto CLAUDE_CONFIG_DIR. The fork splits the two settings and scrubs an inherited config dir
  // when its own is blank (registry invariant 35 / `ClaudeHome.test.ts`), so the rows drive
  // `configDirPath` instead. What is being pinned is unchanged: the auth-failure message must
  // name the SAME config dir and cwd the query was actually spawned with, quoted as literals.
  it.effect.each([
    { configDirPath: "./synthetic config's $literal", inherited: undefined },
    { configDirPath: " /synthetic/path with edge spaces ", inherited: "/inherited/elsewhere" },
    { configDirPath: "", inherited: "/inherited/elsewhere" },
  ])(
    "reports the same Claude config and cwd used by the spawned query ($configDirPath, $inherited)",
    ({ configDirPath, inherited }) => {
      const harness = makeHarness({
        claudeConfig: { homePath: "", configDirPath },
        environment: { ...process.env, CLAUDE_CONFIG_DIR: inherited },
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const cwd = NodePath.resolve("/tmp/synthetic-audit-project");
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
          cwd,
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "synthetic",
          attachments: [],
        });
        harness.query.emit(AUTH_FAILURE_ASSISTANT);
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          terminal_reason: "api_error",
          errors: [],
          session_id: "sdk-session-auth",
          uuid: "result-auth",
        } as unknown as SDKMessage);
        const events = Array.from(yield* Fiber.join(eventsFiber));
        const completed = events.at(-1);
        assert(completed?.type === "turn.completed");
        const actualQuery = harness.getLastCreateQueryInput();
        assert(actualQuery !== undefined);
        const configured = configDirPath.trim();
        const expectedConfigDir = configured.length > 0 ? NodePath.resolve(configured) : undefined;
        assert.equal(actualQuery.options.env?.CLAUDE_CONFIG_DIR, expectedConfigDir);
        assert.equal(actualQuery.options.cwd, cwd);
        if (expectedConfigDir === undefined) {
          // Blank config dir: the inherited one was scrubbed, so there is no config dir to
          // report and the message must not invent the one it did not use.
          assert(!completed.payload.errorMessage?.includes("CLAUDE_CONFIG_DIR"));
        } else {
          assert(
            completed.payload.errorMessage?.includes(
              `CLAUDE_CONFIG_DIR set to ${encodeUnknownJsonString(expectedConfigDir)}`,
            ),
          );
          assert(completed.payload.errorMessage?.includes(`from ${encodeUnknownJsonString(cwd)}`));
        }
        assert(!completed.payload.errorMessage?.includes("CLAUDE_CONFIG_DIR="));
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("fails a turn for every dead-turn terminal_reason", () => {
    const reasons = [
      "blocking_limit",
      "rapid_refill_breaker",
      "prompt_too_long",
      "image_error",
      "model_error",
      "malformed_tool_use_exhausted",
      "budget_exhausted",
      "structured_output_retry_exhausted",
      "tool_deferred_unavailable",
      "turn_setup_failed",
    ];
    // One harness per reason: the fake query settles a single turn.
    const runDeadTurn = (reason: string) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const completionFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "",
          errors: [],
          stop_reason: null,
          terminal_reason: reason,
          session_id: "sdk-session-dead-turn",
          uuid: `result-${reason}`,
        } as unknown as SDKMessage);
        const completed = yield* Fiber.join(completionFiber);
        assert.equal(completed._tag, "Some");
        if (completed._tag === "Some" && completed.value.type === "turn.completed") {
          assert.equal(completed.value.payload.state, "failed", reason);
          assert.ok(completed.value.payload.errorMessage, `${reason} carries an error message`);
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    };
    return Effect.forEach(reasons, runDeadTurn, { discard: true });
  });

  it.effect.each(["success", "error_during_execution"] as const)(
    "preserves %s behavior for an unknown runtime terminal reason",
    (subtype) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const completionFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
        // An installed CLI can send a terminal reason newer than the bundled SDK.
        harness.query.emit({
          type: "result",
          subtype,
          is_error: subtype !== "success",
          result: "",
          errors: subtype === "success" ? [] : ["Provider error detail"],
          stop_reason: null,
          terminal_reason: "future_terminal_reason",
          session_id: "sdk-session-future-reason",
          uuid: "result-future-reason",
        } as unknown as SDKMessage);
        const completed = yield* Fiber.join(completionFiber);
        assert.equal(completed._tag, "Some");
        if (completed._tag === "Some" && completed.value.type === "turn.completed") {
          assert.equal(
            completed.value.payload.state,
            subtype === "success" ? "completed" : "failed",
          );
          assert.equal(
            completed.value.payload.errorMessage,
            subtype === "success" ? undefined : "Provider error detail",
          );
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("fails a turn when a success result reports a 529 overload", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 529,
        result: "",
        errors: [],
        stop_reason: null,
        session_id: "sdk-session-overload",
        uuid: "result-overload",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "failed");
        assert.equal(
          turnCompleted.payload.errorMessage,
          "Claude API is overloaded (529). Try again shortly.",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats omitted Claude cache counters as zero contributions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "uncached turn",
        attachments: [],
      });
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        duration_api_ms: 90,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-uncached-usage",
        usage: {
          input_tokens: 42,
          output_tokens: 9,
        },
      } as unknown as SDKMessage);

      const completed = yield* Fiber.join(completedFiber);
      assert.equal(completed._tag, "Some");
      if (completed._tag === "Some" && completed.value.type === "turn.completed") {
        assert.deepEqual(completed.value.payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 42,
          outputTokens: 9,
          hasSubagents: false,
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses per-turn result usage across consecutive Claude turns", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const firstTurnSettled = yield* Deferred.make<void>();
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.tap((event) =>
          event.type === "session.state.changed" && event.payload.reason === "api_retry:1/2"
            ? Deferred.succeed(firstTurnSettled, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "first turn",
        attachments: [],
      });
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        duration_api_ms: 90,
        num_turns: 1,
        result: "first",
        stop_reason: "end_turn",
        session_id: "sdk-session-consecutive-usage",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
          output_tokens: 10,
        },
        modelUsage: {
          "claude-opus-4-6": {
            inputTokens: 10_000,
            outputTokens: 1_000,
            cacheReadInputTokens: 2_000,
            cacheCreationInputTokens: 500,
            webSearchRequests: 0,
            costUSD: 1,
            contextWindow: 200_000,
            maxOutputTokens: 64_000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 2,
        retry_delay_ms: 1,
        error_status: 502,
        error: { type: "api_error" },
        session_id: "sdk-session-consecutive-usage",
        uuid: "consecutive-usage-barrier",
      } as unknown as SDKMessage);
      yield* Deferred.await(firstTurnSettled);

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "second turn",
        attachments: [],
      });
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 80,
        duration_api_ms: 70,
        num_turns: 2,
        result: "second",
        stop_reason: "end_turn",
        session_id: "sdk-session-consecutive-usage",
        usage: {
          input_tokens: 30,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 3,
          output_tokens: 7,
        },
        modelUsage: {
          "claude-opus-4-6": {
            inputTokens: 20_000,
            outputTokens: 2_000,
            cacheReadInputTokens: 4_000,
            cacheCreationInputTokens: 1_000,
            webSearchRequests: 0,
            costUSD: 2,
            contextWindow: 200_000,
            maxOutputTokens: 64_000,
          },
        },
      } as unknown as SDKMessage);

      const completed = Array.from(yield* Fiber.join(completedFiber));
      assert.equal(completed[0]?.type, "turn.completed");
      assert.equal(completed[1]?.type, "turn.completed");
      if (completed[0]?.type === "turn.completed" && completed[1]?.type === "turn.completed") {
        assert.deepEqual(completed[0].payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 125,
          cachedInputTokens: 20,
          cacheCreationTokens: 5,
          outputTokens: 10,
          hasSubagents: false,
        });
        assert.deepEqual(completed[1].payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 35,
          cachedInputTokens: 2,
          cacheCreationTokens: 3,
          outputTokens: 7,
          hasSubagents: false,
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // Reclassifying api_error as a failure moved these payloads out of the "completed" branch that
  // drains the queue and into the one that discarded it — so a 429 session limit silently ate the
  // messages the user had stacked behind it, and left the reactor holding turnIds that sendTurn
  // had already returned but no turn.started would ever follow. Only a deliberate stop drops the
  // queue; the sibling test above covers that side.
  it.effect("starts a queued follow-up turn after the active turn fails", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const eventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "session.exited",
      ).pipe(Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const firstTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      // Queued behind the running turn.
      const queuedTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello again",
        attachments: [],
      });

      harness.query.emit(
        successShapedErrorResult({
          api_error_status: 429,
          result: "API Error: 429 You've hit your session limit · resets 5:40pm",
        }),
      );
      harness.query.finish();

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const startedTurnIds = events
        .filter((event) => event.type === "turn.started")
        .map((event) => (event.type === "turn.started" ? String(event.turnId) : null));

      // Both turns ran: the failure surfaced, and the stacked message was not swallowed.
      assert.deepEqual(startedTurnIds, [String(firstTurn.turnId), String(queuedTurn.turnId)]);
      const failed = events.find(
        (event) =>
          event.type === "turn.completed" && String(event.turnId) === String(firstTurn.turnId),
      );
      assert.equal(failed?.type, "turn.completed");
      if (failed?.type === "turn.completed") {
        assert.equal(failed.payload.state, "failed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("a subagent snapshot that beats task_started still wins over the seed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type.startsWith("task.")),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "spawn an agent",
        attachments: [],
      });

      // The subagent streams its first assistant snapshot before the task is
      // registered, so there is no agent to refine yet.
      harness.query.emit({
        type: "assistant",
        parent_tool_use_id: "toolu_agent_early",
        message: {
          model: SYNTHETIC_SUBAGENT_MODEL,
          content: [],
        },
        uuid: "early-snapshot-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-early",
        description: "Agent E",
        task_type: "local_agent",
        tool_use_id: "toolu_agent_early",
        uuid: "task-early-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-early",
        description: "Agent E",
        usage: { total_tokens: 100, tool_uses: 1, duration_ms: 10 },
        uuid: "task-early-progress-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      const taskEvents = Array.from(yield* Fiber.join(taskEventsFiber));
      const started = taskEvents[0];
      assert.equal(started?.type, "task.started");
      if (started?.type === "task.started") {
        assert.equal(started.payload.model, SYNTHETIC_SUBAGENT_MODEL);
        assert.equal(started.payload.effort, "max");
      }
      const progress = taskEvents[1];
      assert.equal(progress?.type, "task.progress");
      if (progress?.type === "task.progress") {
        assert.equal(progress.payload.model, SYNTHETIC_SUBAGENT_MODEL);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("closes the session when the Claude stream aborts after a turn starts", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("All fibers interrupted without error"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "turn.completed",
          "session.exited",
        ],
      );

      const turnCompleted = runtimeEvents[4];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Claude runtime interrupted.");
        assert.deepEqual(turnCompleted.payload.tokenUsage, {
          usageStatus: "unavailable",
          usageScope: "main_agent",
          hasSubagents: false,
        });
      }

      const sessionExited = runtimeEvents[5];
      assert.equal(sessionExited?.type, "session.exited");

      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("bounds a cooperative interrupt whose control-response never arrives", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const drain = yield* Stream.runForEach(adapter.streamEvents, () => Effect.void).pipe(
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      // The subprocess is wedged: it will never answer the interrupt control request.
      harness.query.hangInterrupt = true;

      // Pre-fix this awaits forever (and, running on the single reactor worker, blocks every later
      // command). Post-fix it is bounded — fork it, advance past the grace, and it must complete.
      const interruptFiber = yield* adapter
        .interruptTurn(THREAD_ID, undefined)
        .pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(9));
      // Joins only if interruptTurn returned; pre-fix this hangs (test times out).
      yield* Fiber.join(interruptFiber);
      assert.equal(harness.query.interruptCalls.length, 1);

      yield* Fiber.interrupt(drain);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stops promptly while the stream fiber is parked on a wedged subprocess", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const drain = yield* Stream.runForEach(adapter.streamEvents, () => Effect.void).pipe(
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      // sendTurn forks the SDK-stream fiber. With no emit/fail/finish, the fake's async iterator
      // parks on a never-resolving `.next()` — exactly the live wedge (a subprocess stuck in a
      // hung Bash tool). Pre-fix, stopSession's `Fiber.interrupt(streamFiber)` ran BEFORE
      // `query.close()` and deadlocked here; post-fix close() runs first and settles the iterator.
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
      yield* Effect.yieldNow;

      // The bound: if stopSession can't return, this times out and the test fails.
      yield* adapter.stopSession(THREAD_ID).pipe(Effect.timeout("4 seconds"));

      // It used the SDK's own teardown (close → SIGKILL), not the cooperative interrupt.
      assert.equal(harness.query.closeCalls, 1);
      assert.equal(harness.query.interruptCalls.length, 0);
      assert.equal(yield* adapter.hasSession(THREAD_ID), false);

      yield* Fiber.interrupt(drain);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // FORK: the three tests below were retargeted from `interruptTurn` to `stopSession`. Upstream
  // #5891 collapsed the two into one hard kill; this fork keeps interruptTurn cooperative (rung 1
  // of the Stop ladder, see ChatView.logic.ts nextStopAction) and reaches the same teardown via
  // stopSession (rung 2). What they assert — live tasks settled to `stopped`, the query closed, a
  // close failure leaving the session usable, a replacement session surviving slow cleanup — is
  // stopSession's behaviour here, so each subject still applies. See docs/fork/README.md.
  it.effect("stopSession settles live tasks and closes the provider session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Wait for the three task.* runtime events to prove the lifecycle
      // handlers processed the emissions (no wall-clock sleeps under the
      // test clock).
      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type.startsWith("task.")),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "spawn agents",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-live",
        description: "Agent A",
        task_type: "local_agent",
        uuid: "task-live-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-settled",
        description: "Agent B",
        task_type: "local_agent",
        uuid: "task-settled-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-settled",
        status: "completed",
        output_file: "/tmp/task-settled.jsonl",
        summary: "done",
        uuid: "task-settled-done-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      yield* Fiber.join(taskEventsFiber);

      const stoppedTaskEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.stopSession(session.threadId);

      // Closing the session is the hard stop because SDK interrupt can leave
      // resumed background work alive.
      assert.equal(harness.query.closeCalls, 1);

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);

      const stoppedTaskEvents = Array.from(yield* Fiber.join(stoppedTaskEventFiber));
      assert.equal(stoppedTaskEvents.length, 1);
      const stoppedTaskEvent = stoppedTaskEvents[0];
      assert.equal(stoppedTaskEvent?.type, "task.completed");
      if (stoppedTaskEvent?.type === "task.completed") {
        assert.equal(String(stoppedTaskEvent.payload.taskId), "task-live");
        assert.equal(stoppedTaskEvent.payload.status, "stopped");
        assert.equal(stoppedTaskEvent.payload.taskType, "local_agent");
        assert.equal(stoppedTaskEvent.payload.title, "Agent A");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // FORK: upstream #8610 asserts `getContextUsage` is never called. This adapter still
  // calls it -- it is the only source of the compaction facts the Vitals gauge renders --
  // so the call-count assertion is dropped and the stub is not installed. What survives is
  // the behaviour the test is really about: with no context-usage answer, the emitted usage
  // comes from the LATEST ASSISTANT FRAME, not the cumulative result total.
  it.effect("completes with the latest assistant frame usage, not the result total", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-result-usage",
        uuid: "assistant-result-usage-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-result-usage-1",
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 80,
            output_tokens: 20,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-result-usage",
        uuid: "assistant-result-usage-2",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-result-usage-2",
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 180,
            output_tokens: 20,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-result-usage",
        uuid: "assistant-result-usage-3",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-result-usage-3",
          role: "assistant",
          content: [],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage",
        usage: {
          input_tokens: 400,
          output_tokens: 50,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.findLast(
        (event) => event.type === "thread.token-usage.updated",
      );
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload.usage, {
          usedTokens: 200,
          lastUsedTokens: 200,
          totalProcessedTokens: 450,
          inputTokens: 180,
          outputTokens: 20,
          maxTokens: 200000,
        });
      }
      assert.equal(
        runtimeEvents.find((event) => event.type === "turn.completed")?.type,
        "turn.completed",
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves compacted usage when completion follows an older assistant frame", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-compacted-usage",
        uuid: "assistant-compacted-usage",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-compacted-usage",
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 180,
            output_tokens: 20,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          pre_tokens: 200,
          post_tokens: 40,
        },
        session_id: "sdk-session-compacted-usage",
        uuid: "compact-boundary-usage",
      } as unknown as SDKMessage);
      // A second boundary with no `pre_tokens` (upstream #9293): it must not
      // announce a before-figure it was never given.
      harness.query.emit({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { post_tokens: 40 },
        session_id: "sdk-session-compacted-usage",
        uuid: "compact-boundary-post-usage",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 2,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-compacted-usage",
        usage: {
          input_tokens: 400,
          output_tokens: 50,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const compactionEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "thread.state.changed" }> =>
          event.type === "thread.state.changed" && event.payload.state === "compacted",
      );
      // FORK: upstream asserts 200 on the first (its PRE-compact figure) and
      // `undefined` on the second. Here `compactBoundaryTokenUsageSnapshot` resets
      // the meter to `post_tokens` whether or not the boundary carried
      // `pre_tokens`, for the same reason the usage assertion below diverges, so
      // both boundaries announce the post-compact figure.
      assert.equal(compactionEvents[0]?.payload.beforeTokens, 40);
      assert.equal(compactionEvents[0]?.payload.afterTokens, 40);
      assert.equal(compactionEvents[1]?.payload.beforeTokens, 40);
      assert.equal(compactionEvents[1]?.payload.afterTokens, 40);
      const finalUsageEvent = runtimeEvents.findLast(
        (event) => event.type === "thread.token-usage.updated",
      );
      assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
      if (finalUsageEvent?.type === "thread.token-usage.updated") {
        // FORK: upstream expects `lastUsedTokens: 200`, the PRE-compact figure.
        // `compactBoundaryTokenUsageSnapshot` here deliberately resets it to
        // `post_tokens` -- carrying the pre-compact value forward would leave the
        // Vitals meter pinned at the old usage and defeat the reset the compaction
        // exists to show. The subject of the test, that the post-compact
        // `usedTokens` survives a completion carrying an older assistant frame,
        // is unchanged.
        assert.deepEqual(finalUsageEvent.payload.usage, {
          usedTokens: 40,
          lastUsedTokens: 40,
          totalProcessedTokens: 450,
          maxTokens: 200000,
        });
      }
      assert.equal(
        runtimeEvents.find((event) => event.type === "turn.completed")?.type,
        "turn.completed",
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps the session available when process close fails", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      harness.query.closeError = new Error("close failed");

      const result = yield* adapter.stopSession(session.threadId).pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderAdapterProcessError");
      }
      assert.equal(harness.query.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(session.threadId), true);
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stopAll attempts every session when one process close fails", () => {
    const queries: FakeClaudeQuery[] = [];
    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            const query = new FakeClaudeQuery();
            queries.push(query);
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest("/tmp/claude-adapter-test", { prefix: "claude-adapter-" }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const firstQuery = queries[0];
      if (!firstQuery) {
        return;
      }
      firstQuery.closeError = new Error("close failed");

      const result = yield* adapter.stopAll().pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(queries[0]?.closeCalls, 1);
      assert.equal(queries[1]?.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(THREAD_ID), true);
      assert.equal(yield* adapter.hasSession(RESUME_THREAD_ID), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("keeps a resumed replacement session during slow stop cleanup", () => {
    const queries: FakeClaudeQuery[] = [];
    let signalUsageStarted: () => void = () => undefined;
    const usageStarted = new Promise<void>((resolve) => {
      signalUsageStarted = resolve;
    });
    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            const query = new FakeClaudeQuery();
            if (queries.length === 0) {
              Object.assign(query, {
                getContextUsage: async () => {
                  signalUsageStarted();
                  return await new Promise<never>(() => undefined);
                },
              });
            }
            queries.push(query);
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest("/tmp/claude-adapter-test", { prefix: "claude-adapter-" }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      const firstSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: firstSession.threadId,
        input: "hello",
        attachments: [],
      });

      const stopFiber = yield* adapter.stopSession(firstSession.threadId).pipe(Effect.forkChild);
      yield* Effect.promise(() => usageStarted);
      assert.equal(queries[0]?.closeCalls, 1);

      const replacement = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        resumeCursor: firstSession.resumeCursor,
      });
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(stopFiber);

      const activeSessions = yield* adapter.listSessions();
      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(queries.length, 2);
      assert.equal(queries[1]?.closeCalls, 0);
      assert.equal(activeSessions.length, 1);
      assert.deepEqual(activeSessions[0]?.resumeCursor, replacement.resumeCursor);
      assert.deepEqual(
        runtimeEvents
          .filter((event) => event.type.startsWith("session."))
          .map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "session.started",
          "session.configured",
          "session.state.changed",
        ],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("keeps Claude stream failure events structural", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("credential material that must stay in the cause chain"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();

      const runtimeError = runtimeEvents.find((event) => event.type === "runtime.error");
      assert.equal(runtimeError?.type, "runtime.error");
      if (runtimeError?.type === "runtime.error") {
        assert.equal(runtimeError.payload.message, "Claude runtime stream failed.");
        assert.deepEqual(runtimeError.payload.detail, {
          failureCount: 1,
          failureTags: ["ProviderAdapterProcessError"],
        });
      }

      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "failed");
        assert.equal(completed.payload.errorMessage, "Claude runtime stream failed.");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("closes the previous session before replacing an existing thread session", () => {
    const queries: FakeClaudeQuery[] = [];
    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            const query = new FakeClaudeQuery();
            queries.push(query);
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest("/tmp/claude-adapter-test", { prefix: "claude-adapter-" }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const firstSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const secondSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        resumeCursor: firstSession.resumeCursor,
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const activeSessions = yield* adapter.listSessions();

      assert.equal(queries.length, 2);
      assert.equal(queries[0]?.closeCalls, 1);
      assert.equal(queries[1]?.closeCalls, 0);
      assert.equal(yield* adapter.hasSession(THREAD_ID), true);
      assert.equal(activeSessions.length, 1);
      assert.deepEqual(activeSessions[0]?.resumeCursor, secondSession.resumeCursor);
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "session.started",
          "session.configured",
          "session.state.changed",
        ],
      );
      assert.equal(
        runtimeEvents.some((event) => event.type === "session.exited"),
        false,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("stopSession does not throw into the SDK prompt consumer", () => {
    // The SDK consumes user messages via `for await (... of prompt)`.
    // Stopping a session must end that loop cleanly — not throw an error.
    //
    // FakeClaudeQuery.close() masks this by resolving pending iterators
    // before the shutdown propagates. Override it to match real SDK behavior
    // where close() does not resolve the prompt consumer.
    const query = new FakeClaudeQuery();
    (query as { close: () => void }).close = () => {
      query.closeCalls += 1;
    };

    let promptConsumerError: unknown = undefined;

    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: (input) => {
            // Simulate the SDK consuming the prompt iterable
            (async () => {
              try {
                for await (const _message of input.prompt) {
                  /* SDK processes user messages */
                }
              } catch (error) {
                promptConsumerError = error;
              }
            })();
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest("/tmp/claude-adapter-test", { prefix: "claude-adapter-" }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.runForEach(
        adapter.streamEvents,
        () => Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(THREAD_ID);

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;

      runtimeEventsFiber.interruptUnsafe();

      assert.equal(
        promptConsumerError,
        undefined,
        `Prompt consumer should not receive a thrown error on session stop, ` +
          `but got: "${promptConsumerError instanceof Error ? promptConsumerError.message : String(promptConsumerError)}"`,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("forwards Claude task progress summaries for subagent updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-subagent-1",
        description: "Running background teammate",
        summary: "Code reviewer checked the migration edge cases.",
        usage: {
          total_tokens: 123,
          tool_uses: 4,
          duration_ms: 987,
        },
        session_id: "sdk-session-task-summary",
        uuid: "task-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.equal(
          progressEvent.payload.summary,
          "Code reviewer checked the migration edge cases.",
        );
        assert.equal(progressEvent.payload.description, "Running background teammate");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("consumes undeclared and UX-internal system subtypes without warning rows", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "session.state.changed" && event.payload.reason === "api_retry:3/10",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // Undeclared wire-only roster snapshot + every typed UX-internal
      // subtype and top-level type consumed silently: none may surface as
      // unknown-subtype warnings.
      for (const message of [
        {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "t1", task_type: "local_agent", description: "Say hi" }],
          session_id: "session",
          uuid: "roster",
        },
        {
          type: "system",
          subtype: "task_updated",
          task_id: "t1",
          patch: { status: "running" },
          session_id: "session",
          uuid: "tu",
        },
        { type: "system", subtype: "commands_changed", session_id: "session", uuid: "cc" },
        { type: "system", subtype: "local_command_output", session_id: "session", uuid: "lco" },
        { type: "system", subtype: "plugin_install", session_id: "session", uuid: "pi" },
        { type: "system", subtype: "memory_recall", session_id: "session", uuid: "mr" },
        { type: "system", subtype: "elicitation_complete", session_id: "session", uuid: "ec" },
        {
          type: "system",
          subtype: "control_request_progress",
          request_id: "ctrl-1",
          status: "started",
          session_id: "session",
          uuid: "crp",
        },
        {
          type: "system",
          subtype: "worker_shutting_down",
          reason: "host_exit",
          session_id: "session",
          uuid: "wsd",
        },
        {
          type: "system",
          subtype: "informational",
          content: "Loaded 3 skills",
          level: "notice",
          session_id: "session",
          uuid: "info",
        },
        { type: "prompt_suggestion", suggestion: "try this", session_id: "session", uuid: "ps" },
        {
          type: "conversation_reset",
          new_conversation_id: "conv-2",
          session_id: "session",
          uuid: "cr",
        },
        {
          type: "system",
          subtype: "notification",
          key: "context",
          text: "low priority note",
          priority: "low",
          session_id: "session",
          uuid: "notif",
        },
      ]) {
        harness.query.emit(message as unknown as SDKMessage);
      }
      // Safety model-fallback notices DO surface as a warning row.
      harness.query.emit({
        type: "system",
        subtype: "model_refusal_fallback",
        trigger: "refusal",
        direction: "retry",
        original_model: "claude-fable-5",
        fallback_model: "claude-opus-4-8",
        request_id: "req_test",
        api_refusal_category: "cyber",
        api_refusal_explanation: null,
        content: "Safeguards flagged this message. Switched to Opus 4.8.",
        session_id: "session",
        uuid: "mrf",
      } as unknown as SDKMessage);
      // FORK: notifications surface as dedicated runtime.notification events,
      // never as warning rows, regardless of priority.
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "limit",
        text: "context window nearly full",
        priority: "high",
        session_id: "session",
        uuid: "notif-high",
      } as unknown as SDKMessage);
      // Warning-level informational notes and refusals without a fallback
      // model surface as warning rows too.
      harness.query.emit({
        type: "system",
        subtype: "informational",
        content: "Stop hook prevented continuation",
        level: "warning",
        prevent_continuation: true,
        session_id: "session",
        uuid: "info-warn",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "model_refusal_no_fallback",
        original_model: "claude-opus-5",
        request_id: null,
        api_refusal_explanation: "The request was declined by the API.",
        content: "Model refused",
        session_id: "session",
        uuid: "mrnf",
      } as unknown as SDKMessage);
      // session_state_changed maps to the matching session states.
      for (const [state, uuid] of [
        ["running", "ssc-run"],
        ["requires_action", "ssc-req"],
        ["idle", "ssc-idle"],
      ]) {
        harness.query.emit({
          type: "system",
          subtype: "session_state_changed",
          state,
          session_id: "session",
          uuid,
        } as unknown as SDKMessage);
      }
      // api_retry maps to a session heartbeat, not a warning row.
      harness.query.emit({
        type: "system",
        subtype: "api_retry",
        attempt: 3,
        max_retries: 10,
        retry_delay_ms: 1000,
        error_status: 502,
        error: { type: "api_error" },
        session_id: "session",
        uuid: "retry",
      } as unknown as SDKMessage);
      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      const warnings = runtimeEvents.filter((event) => event.type === "runtime.warning");
      // Exactly three warnings: the fallback notice, the warning-level
      // informational note, and the refusal. The high-priority notification is
      // not among them - notifications route to runtime.notification instead.
      assert.deepEqual(
        warnings.map((event) => event.payload.message),
        [
          "Safeguards flagged this message. Switched to Opus 4.8.",
          "Stop hook prevented continuation",
          "The request was declined by the API.",
        ],
      );
      const notifications = runtimeEvents.filter((event) => event.type === "runtime.notification");
      assert.equal(notifications.length, 2);
      const sessionStates = runtimeEvents
        .filter((event) => event.type === "session.state.changed")
        .map((event) =>
          event.type === "session.state.changed"
            ? `${event.payload.state}:${event.payload.reason ?? ""}`
            : "",
        )
        .filter(
          (entry) => entry.startsWith("running:session_state") || entry.includes("session_state"),
        );
      assert.deepEqual(sessionStates, [
        "running:session_state:running",
        "waiting:session_state:requires_action",
        "ready:session_state:idle",
      ]);
      const heartbeat = runtimeEvents.find(
        (event) =>
          event.type === "session.state.changed" &&
          typeof event.payload.reason === "string" &&
          event.payload.reason.startsWith("api_retry:"),
      );
      assert.equal(heartbeat?.type, "session.state.changed");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  const observeUsageLimitEvents = (adapter: ClaudeAdapterShape, query: FakeClaudeQuery) =>
    Effect.gen(function* () {
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      let receipt: Deferred.Deferred<void> | undefined;
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (
            receipt &&
            event.type === "session.state.changed" &&
            event.payload.reason === "api_retry:1/1"
          ) {
            yield* Deferred.succeed(receipt, undefined);
          }
        }),
      ).pipe(Effect.forkChild);
      const drainSdkMessages = Effect.gen(function* () {
        receipt = yield* Deferred.make<void>();
        // The heartbeat follows queued SDK messages without adding a warning.
        query.emit({
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 1,
          retry_delay_ms: 0,
          error_status: 429,
          error: { type: "rate_limit_error" },
          session_id: "sdk-session-limit",
          uuid: "usage-limit-drain",
        } as unknown as SDKMessage);
        yield* Deferred.await(receipt);
      });
      return { runtimeEvents, runtimeEventsFiber, drainSdkMessages };
    });

  it.effect("surfaces a rejected Claude usage limit once per turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      // resetsAt is epoch seconds, so the window reopens 4h 1m30s out.
      const nowMs = yield* Clock.currentTimeMillis;
      const rateLimitInfo = {
        status: "rejected",
        rateLimitType: "five_hour",
        utilization: 1,
        resetsAt: Math.floor(nowMs / 1000) + 4 * 60 * 60 + 90,
      };
      const rejected = {
        type: "rate_limit_event",
        rate_limit_info: rateLimitInfo,
        session_id: "sdk-session-limit",
        uuid: "rate-limit-rejected",
      };
      // Sibling fields drift while the window is parked, so the same rendered
      // line can arrive more than once inside one turn.
      harness.query.emit(rejected as unknown as SDKMessage);
      yield* drainSdkMessages;
      // The repeat lands minutes later, so the remaining wait has visibly
      // shrunk. Deduping on the rendered row would let that drift through.
      yield* TestClock.adjust("5 minutes");
      harness.query.emit(rejected as unknown as SDKMessage);
      yield* drainSdkMessages;

      const usageLimitRows = () =>
        runtimeEvents
          .filter((event) => event.type === "runtime.warning")
          .map((event) => (event.type === "runtime.warning" ? event.payload.message : ""));
      assert.equal(usageLimitRows().length, 1);
      // A wait, not a wall clock: the server renders this row but clients read
      // it from other timezones. Reading resetsAt as milliseconds would put the
      // window minutes out instead of hours, so the hour also pins the scale.
      assert.match(
        usageLimitRows()[0] ?? "",
        /^Claude usage limit reached\. This turn is paused until the 5-hour limit resets in 4h( \d{1,2}m)?\.$/,
      );
      // The exact instant still rides along for clients that want to render it.
      assert.deepEqual(
        runtimeEvents.find((event) => event.type === "runtime.warning")?.payload.detail,
        rateLimitInfo,
      );
      // The raw telemetry event still flows for every copy.
      assert.equal(
        runtimeEvents.filter((event) => event.type === "account.rate-limits.updated").length,
        2,
      );

      // Same window, drifting siblings: still the one pause.
      harness.query.emit({
        ...rejected,
        rate_limit_info: { ...rateLimitInfo, utilization: 0.99 },
        uuid: "rate-limit-rejected-drift",
      } as unknown as SDKMessage);
      yield* drainSdkMessages;
      assert.equal(usageLimitRows().length, 1);

      // Retrying inside the same window renders the identical line. Staying
      // quiet there would put the new turn right back to a silent spin.
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-limit",
        uuid: "result-limit",
      } as unknown as SDKMessage);
      yield* drainSdkMessages;
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "retry", attachments: [] });
      harness.query.emit(rejected as unknown as SDKMessage);
      yield* drainSdkMessages;

      assert.equal(usageLimitRows().length, 2);

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps allowed and malformed Claude rate-limit events out of the work log", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      // A turn is in flight, so silence here is the status filter doing its job
      // rather than the between-turns guard.
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      for (const rateLimitInfo of [
        { status: "allowed", rateLimitType: "five_hour", utilization: 0.4 },
        { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9 },
        // Undeclared shape from an older/newer CLI must not take the session down.
        undefined,
      ]) {
        harness.query.emit({
          type: "rate_limit_event",
          ...(rateLimitInfo ? { rate_limit_info: rateLimitInfo } : {}),
          session_id: "sdk-session-limit-ok",
          uuid: `rate-limit-${rateLimitInfo?.status ?? "malformed"}`,
        } as unknown as SDKMessage);
      }
      yield* drainSdkMessages;

      assert.deepEqual(
        runtimeEvents.filter((event) => event.type === "runtime.warning"),
        [],
      );
      assert.equal(
        runtimeEvents.filter((event) => event.type === "account.rate-limits.updated").length,
        2,
      );

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stays quiet when no turn is parked by the Claude limit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const nowMs = yield* Clock.currentTimeMillis;
      const resetsAt = Math.floor(nowMs / 1000) + 60 * 60;
      // The stream stays live between turns, so a reject can land with nothing
      // to pause; claiming "this turn is paused" there would be a lie.
      harness.query.emit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          utilization: 1,
          resetsAt,
        },
        session_id: "sdk-session-idle",
        uuid: "rate-limit-idle",
      } as unknown as SDKMessage);
      yield* drainSdkMessages;

      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
      // Provisioned overage carries the request even though the base window
      // rejected it, so the turn keeps running and needs no row.
      for (const overage of [
        { overageStatus: "allowed" },
        { overageStatus: "allowed_warning" },
        { isUsingOverage: true },
        { overageInUse: true },
      ]) {
        harness.query.emit({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "five_hour",
            resetsAt,
            utilization: 1,
            ...overage,
          },
          session_id: "sdk-session-idle",
          uuid: "rate-limit-overage",
        } as unknown as SDKMessage);
      }
      yield* drainSdkMessages;

      assert.deepEqual(
        runtimeEvents.filter((event) => event.type === "runtime.warning"),
        [],
      );
      // Idle and overage-covered events still reach the account telemetry stream.
      assert.equal(
        runtimeEvents.filter((event) => event.type === "account.rate-limits.updated").length,
        5,
      );

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("still surfaces the pause when overage is exhausted too", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      const nowMs = yield* Clock.currentTimeMillis;
      const resetsAt = Math.floor(nowMs / 1000) + 60 * 60;
      // The overage-exhausted / out-of-credits shape: the base window and the
      // overage it would have spent both reject, with neither isUsingOverage
      // nor overageInUse set to say anything is still covered. Nothing is
      // carrying the turn here, so staying quiet would be the silent spin
      // this row exists to prevent.
      harness.query.emit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt,
          overageStatus: "rejected",
        },
        session_id: "sdk-session-dual-reject",
        uuid: "rate-limit-dual-reject",
      } as unknown as SDKMessage);
      yield* drainSdkMessages;

      assert.equal(runtimeEvents.filter((event) => event.type === "runtime.warning").length, 1);

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps one row per window when two Claude limits interleave", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      const nowMs = yield* Clock.currentTimeMillis;
      const nowSeconds = Math.floor(nowMs / 1000);
      const rejection = (rateLimitType: string, resetsAt: number, uuid: string) => ({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType, resetsAt },
        session_id: "sdk-session-interleaved",
        uuid,
      });

      // One turn can park on more than one window; each deserves its own row,
      // and a later repeat of an earlier window deserves none.
      for (const message of [
        rejection("five_hour", nowSeconds + 2 * 60 * 60, "limit-five-hour"),
        rejection("seven_day", nowSeconds + 48 * 60 * 60, "limit-seven-day"),
        rejection("five_hour", nowSeconds + 2 * 60 * 60, "limit-five-hour-repeat"),
      ]) {
        harness.query.emit(message as unknown as SDKMessage);
        yield* drainSdkMessages;
      }

      assert.deepEqual(
        runtimeEvents
          .filter((event) => event.type === "runtime.warning")
          .map((event) => (event.type === "runtime.warning" ? event.payload.message : ""))
          .map((message) => message.replace(/ in \d+h( \d{1,2}m)?/, "")),
        [
          "Claude usage limit reached. This turn is paused until the 5-hour limit resets.",
          "Claude usage limit reached. This turn is paused until the 7-day limit resets.",
        ],
      );

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("re-announces a Claude limit for a synthetic turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      const nowMs = yield* Clock.currentTimeMillis;
      const rejected = {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: Math.floor(nowMs / 1000) + 2 * 60 * 60,
        },
        session_id: "sdk-session-synthetic",
        uuid: "rate-limit-synthetic",
      };
      harness.query.emit(rejected as unknown as SDKMessage);
      yield* drainSdkMessages;

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-synthetic",
        uuid: "result-synthetic",
      } as unknown as SDKMessage);
      yield* drainSdkMessages;

      // A background agent answering between prompts auto-starts a synthetic
      // turn, which parks on the same window and needs its own row.
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-synthetic",
        uuid: "assistant-synthetic",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-synthetic",
          content: [{ type: "text", text: "Following up" }],
        },
      } as unknown as SDKMessage);
      yield* drainSdkMessages;
      harness.query.emit({ ...rejected, uuid: "rate-limit-synthetic-2" } as unknown as SDKMessage);
      yield* drainSdkMessages;

      assert.equal(runtimeEvents.filter((event) => event.type === "runtime.warning").length, 2);

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("drops an unusable Claude reset time, not the row or the session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      for (const [rateLimitType, resetsAt] of [
        ["five_hour", undefined],
        // Implausibly far out once scaled to milliseconds: no credible wait.
        ["seven_day", 1e20],
      ] as const) {
        harness.query.emit({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType, resetsAt },
          session_id: "sdk-session-limit-unusable",
          uuid: `rate-limit-${rateLimitType}`,
        } as unknown as SDKMessage);
      }
      yield* drainSdkMessages;

      assert.deepEqual(
        runtimeEvents
          .filter((event) => event.type === "runtime.warning")
          .map((event) => (event.type === "runtime.warning" ? event.payload.message : "")),
        [
          "Claude usage limit reached. This turn is paused until the 5-hour limit resets.",
          "Claude usage limit reached. This turn is paused until the 7-day limit resets.",
        ],
      );
      // A throw inside the telemetry handler would tear the session down.
      assert.deepEqual(
        runtimeEvents
          .filter((event) => event.type === "session.exited" || event.type === "runtime.error")
          .map((event) => event.type),
        [],
      );
      // Still live enough to take the next turn.
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "still here", attachments: [] });

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("warns for unmapped Claude limits and names the probed model bucket", () => {
    const scopedLimitNames = Ref.makeUnsafe<ClaudeScopedLimitNames>({ overageIncluded: undefined });
    const harness = makeHarness({ scopedLimitNames });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      for (const rateLimitType of ["seven_day_overage_included", "future_window"]) {
        harness.query.emit({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType },
          session_id: "sdk-session-unmapped-limit",
          uuid: `rejected-${rateLimitType}`,
        } as unknown as SDKMessage);
      }
      yield* drainSdkMessages;
      assert.deepEqual(
        runtimeEvents.filter((event) => event.type === "account.rate-limits.updated"),
        [],
      );

      yield* Ref.set(scopedLimitNames, { overageIncluded: "Model A" });
      const nowMs = yield* Clock.currentTimeMillis;
      harness.query.emit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "seven_day_overage_included",
          utilization: 1,
          resetsAt: Math.floor(nowMs / 1000) + 3600,
        },
        session_id: "sdk-session-unmapped-limit",
        uuid: "rejected-probed-bucket",
      } as unknown as SDKMessage);
      yield* drainSdkMessages;
      assert.deepEqual(
        runtimeEvents
          .filter((event) => event.type === "runtime.warning")
          .map((event) => event.payload.message),
        [
          "Claude usage limit reached. This turn is paused until the 7-day model limit resets.",
          "Claude usage limit reached. This turn is paused until the limit resets.",
          "Claude usage limit reached. This turn is paused until the 7-day Model A limit resets in 1h.",
        ],
      );
      assert.equal(
        runtimeEvents.filter((event) => event.type === "account.rate-limits.updated").length,
        1,
      );
      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // FORK: retargeted from runtime.warning to runtime.notification. Upstream's
  // adapter folds a high-priority CLI notification into a runtime.warning; this
  // fork surfaces it as its own richer `runtime.notification` event (key, text,
  // priority, timeoutMs). The notifications here are only sentinels bracketing
  // the command_lifecycle messages, so the test's real subject — that
  // command_lifecycle produces NO runtime event (#6606) — is unchanged, and its
  // guard against the fix regressing still holds. Left as runtime.warning it
  // simply times out after 120s against this adapter.
  it.effect("consumes Claude command lifecycle notifications silently", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const sessionId = "6e81554e-5cff-4b37-8a39-f3a9051ac234";

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const readyMessage = "command lifecycle test ready";
      const readyFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "runtime.notification" && event.payload.text === readyMessage,
      ).pipe(Stream.runDrain, Effect.forkChild);
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "command-lifecycle-ready",
        text: readyMessage,
        priority: "high",
        session_id: sessionId,
        uuid: "command-lifecycle-ready",
      } as unknown as SDKMessage);
      yield* Fiber.join(readyFiber);

      const processedMessage = "command lifecycle messages processed";
      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "runtime.notification" && event.payload.text === processedMessage,
      ).pipe(Stream.runCollect, Effect.forkChild);
      for (const [state, uuid] of [
        ["started", "command-started"],
        ["completed", "command-completed"],
      ]) {
        harness.query.emit({
          type: "command_lifecycle",
          command_uuid: "4cd8e8a3-df7a-425d-b6c9-4053abc0b8fd",
          state,
          session_id: sessionId,
          uuid,
        } as unknown as SDKMessage);
      }
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "command-lifecycle-processed",
        text: processedMessage,
        priority: "high",
        session_id: sessionId,
        uuid: "command-lifecycle-processed",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["runtime.notification"],
      );
      const warning = runtimeEvents[0];
      assert.equal(warning?.type, "runtime.notification");
      if (warning?.type === "runtime.notification") {
        assert.equal(warning.payload.text, processedMessage);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not drive the context window meter from subagent task progress", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Subagent task `total_tokens` is the subagent's own cumulative usage, not
      // the main thread's context window occupancy, so it must NOT emit a
      // thread.token-usage.updated event (doing so previously pinned the meter).
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-usage-1",
        description: "Thinking through the patch",
        usage: {
          total_tokens: 321,
          tool_uses: 2,
          duration_ms: 654,
        },
        session_id: "sdk-session-task-usage",
        uuid: "task-usage-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(usageEvent, undefined);
      assert.equal(progressEvent?.type, "task.progress");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits Claude context window on result completion usage snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage",
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 2715,
          cache_read_input_tokens: 21144,
          output_tokens: 679,
        },
        modelUsage: {
          [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 24542,
            lastUsedTokens: 24542,
            inputTokens: 23863,
            outputTokens: 679,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("clamps oversized Claude usage to the reported context window", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage-clamped",
        usage: {
          total_tokens: 535000,
        },
        modelUsage: {
          [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 200000,
            lastUsedTokens: 200000,
            totalProcessedTokens: 535000,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("reports the model's window as the denominator, not the compaction budget", () => {
    // The reported bug. `getContextUsage().maxTokens` is what Claude Code
    // COMPACTS against — `min(modelWindow, configuredWindow)` — so a 600k
    // budget on a 1M model made the meter read "541k / 600k, 90%" in red on a
    // thread that was 54% full.
    const harness = makeHarness({ modelCatalog: Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG) });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      harness.query.contextUsageResponses.push({
        totalTokens: 541_000,
        maxTokens: 600_000,
        isAutoCompactEnabled: true,
        autoCompactThreshold: 567_000,
        autocompactSource: "settings",
      });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-8",
        ),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-window-vs-budget",
        usage: { total_tokens: 541_000 },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.equal(usageEvent.payload.usage?.maxTokens, 1_000_000);
        assert.equal(usageEvent.payload.usage?.usedTokens, 541_000);
        // The budget survives as the threshold, which is what the marker uses.
        assert.equal(usageEvent.payload.usage?.autoCompactThreshold, 567_000);
        assert.equal(usageEvent.payload.usage?.autoCompactSource, "settings");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("drops compaction facts that describe a different window", () => {
    // A threshold is an absolute token count derived from one window. Carrying
    // it across a model switch draws the marker for the wrong model — the panel
    // would read "compacts at 189k" with the marker at 19% while the real
    // threshold is 567k. Reachable without a switch too: the context-usage call
    // has a one-second timeout, so any slow turn end falls through here.
    const harness = makeHarness({ modelCatalog: Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG) });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      harness.query.contextUsageResponses.push({
        totalTokens: 150_000,
        maxTokens: 200_000,
        isAutoCompactEnabled: true,
        autoCompactThreshold: 167_000,
        autocompactSource: "settings",
      });

      // Self-terminating rather than a fixed count: two turns emit a different
      // number of events than one, and a count that guesses too high hangs the
      // test rather than failing it.
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "thread.token-usage.updated" &&
            event.payload.usage?.maxTokens === 1_000_000,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "contextWindow", value: "200k" }],
        ),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "one", attachments: [] });
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-switch",
        usage: { total_tokens: 150_000 },
      } as unknown as SDKMessage);

      // Switch to the 1M model. The queue is empty now, so the context-usage
      // call goes silent and the cached facts are the only ones available.
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "two",
        attachments: [],
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-8",
        ),
      });
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-switch",
        usage: { total_tokens: 160_000 },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvents = runtimeEvents.filter(
        (event) => event.type === "thread.token-usage.updated",
      );
      const last = usageEvents.at(-1);
      assert.equal(last?.type, "thread.token-usage.updated");
      if (last?.type === "thread.token-usage.updated") {
        assert.equal(last.payload.usage?.maxTokens, 1_000_000);
        assert.equal(last.payload.usage?.autoCompactThreshold, undefined);
        assert.equal(last.payload.usage?.autoCompactSource, undefined);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("drops a stale threshold when the window moves without a model switch", () => {
    // The narrow path the model-switch clear does NOT cover: the context-usage
    // call has a one-second timeout, so a slow turn end leaves the previous
    // turn's compaction facts cached while `modelUsage` moves the window under
    // them. Rendering those facts against the new denominator puts the marker
    // at the wrong place — "compacts at 167k" on a 1M window.
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      harness.query.contextUsageResponses.push({
        totalTokens: 150_000,
        maxTokens: 200_000,
        isAutoCompactEnabled: true,
        autoCompactThreshold: 167_000,
        autocompactSource: "settings",
      });

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "thread.token-usage.updated" &&
            event.payload.usage?.maxTokens === 1_000_000,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "one", attachments: [] });
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-stale-threshold",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 150_000 },
        modelUsage: { "model-a": { contextWindow: 200000, maxOutputTokens: 64000 } },
      } as unknown as SDKMessage);

      // Second turn: the queue is empty, so the control call goes silent (the
      // timeout), and the window widens. Same session, same selection —
      // nothing clears the cached facts.
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "two", attachments: [] });
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-stale-threshold",
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 160_000 },
        modelUsage: { "model-b": { contextWindow: 1000000, maxOutputTokens: 64000 } },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const last = runtimeEvents
        .filter((event) => event.type === "thread.token-usage.updated")
        .at(-1);
      assert.equal(last?.type, "thread.token-usage.updated");
      if (last?.type === "thread.token-usage.updated") {
        assert.equal(last.payload.usage?.maxTokens, 1_000_000);
        assert.equal(last.payload.usage?.autoCompactThreshold, undefined);
        assert.equal(last.payload.usage?.autoCompactSource, undefined);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps the running model's window when a subagent used a wider one", () => {
    // The defect this replaced a `Math.max` to fix. `modelUsage` is cumulative
    // for the whole session and keyed by model, so a 200k thread that spawns
    // one 1M subagent used to latch 1M for good — and the meter then read 19%
    // on a thread 9,000 tokens from its ceiling, silently.
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "contextWindow", value: "200k" }],
        ),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-subagent-window",
        usage: { total_tokens: 190000 },
        modelUsage: {
          "claude-opus-4-6": { contextWindow: 200000, maxOutputTokens: 64000 },
          // A subagent's model, which the session has now "touched" forever.
          "claude-opus-4-8": { contextWindow: 1000000, maxOutputTokens: 64000 },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.equal(usageEvent.payload.usage?.maxTokens, 200_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "clamps the result total to the context window even after subagent task progress",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "task-usage-clamped",
          description: "Thinking through the patch",
          usage: {
            total_tokens: 190000,
          },
          session_id: "sdk-session-task-usage-clamped",
          uuid: "task-usage-progress-clamped",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1234,
          duration_api_ms: 1200,
          num_turns: 1,
          result: "done",
          stop_reason: "end_turn",
          session_id: "sdk-session-result-usage-clamped-after-progress",
          usage: {
            total_tokens: 535000,
          },
          modelUsage: {
            [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: {
              contextWindow: 200000,
              maxOutputTokens: 64000,
            },
          },
        } as unknown as SDKMessage);
        harness.query.finish();

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        const usageEvents = runtimeEvents.filter(
          (event) => event.type === "thread.token-usage.updated",
        );
        const finalUsageEvent = usageEvents.at(-1);
        assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
        if (finalUsageEvent?.type === "thread.token-usage.updated") {
          assert.deepEqual(finalUsageEvent.payload, {
            usage: {
              usedTokens: 200000,
              lastUsedTokens: 200000,
              totalProcessedTokens: 535000,
              maxTokens: 200000,
            },
          });
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("emits point-in-time context usage from a main-thread assistant message", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Collect until the assistant's point-in-time usage event (the last event
      // we produce) so the test does not depend on an exact upstream count.
      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) =>
          event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 58908,
      ).pipe(Stream.runCollect, Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      // First, a result establishes the known context window (1M).
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: "ok",
        stop_reason: "end_turn",
        session_id: "sdk-session-assistant-usage",
        usage: { input_tokens: 10, output_tokens: 5 },
        modelUsage: { "claude-opus-4-8": { contextWindow: 1000000, maxOutputTokens: 64000 } },
      } as unknown as SDKMessage);

      // A subsequent main-thread assistant message carries this single request's
      // usage. Its prompt is ~58k of context (mostly cache reads), which is the
      // true point-in-time occupancy — far below the cumulative totals a long
      // multi-tool turn would sum to.
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-assistant-usage",
        uuid: "assistant-main-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-main-1",
          content: [{ type: "text", text: "Working on it" }],
          usage: {
            input_tokens: 1200,
            cache_creation_input_tokens: 5000,
            cache_read_input_tokens: 52000,
            output_tokens: 708,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const fromAssistant = runtimeEvents.find(
        (event) =>
          event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 58908,
      );
      assert.equal(fromAssistant?.type, "thread.token-usage.updated");
      if (fromAssistant?.type === "thread.token-usage.updated") {
        assert.deepEqual(fromAssistant.payload.usage, {
          usedTokens: 58908,
          lastUsedTokens: 58908,
          inputTokens: 58200,
          outputTokens: 708,
          maxTokens: 1000000,
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores subagent assistant messages for the context window meter", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Collect until the MAIN-thread assistant's usage event, which is the last
      // thing we produce. Deliberately not a fixed event count: this test used to
      // take exactly 6 events, and when upstream's subagent observability work
      // started routing subagent content to the Agents surface instead of the
      // parent timeline, the subagent message stopped producing events at all and
      // the take(6) hung until the 120s test timeout. A barrier on an event we
      // actually cause is stable against upstream changing what else it emits.
      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) =>
          event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 58908,
      ).pipe(Stream.runCollect, Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      // Establish the known context window (1M).
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: "ok",
        stop_reason: "end_turn",
        session_id: "sdk-session-subagent",
        usage: { input_tokens: 10, output_tokens: 5 },
        modelUsage: { "claude-opus-4-8": { contextWindow: 1000000, maxOutputTokens: 64000 } },
      } as unknown as SDKMessage);

      // A SUBAGENT assistant message with deliberately huge usage. Identified by
      // parent_tool_use_id: its tokens belong to the subagent's own context, not
      // this thread's, and must never reach the meter.
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-subagent",
        uuid: "assistant-subagent-1",
        parent_tool_use_id: "tool-task-1",
        subagent_type: "code-reviewer",
        message: {
          id: "assistant-message-subagent-1",
          content: [{ type: "text", text: "subagent output" }],
          usage: {
            input_tokens: 999999,
            cache_read_input_tokens: 999999,
            output_tokens: 999999,
          },
        },
      } as unknown as SDKMessage);

      // Then a MAIN-thread message with modest, real usage.
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-subagent",
        uuid: "assistant-main-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-main-1",
          content: [{ type: "text", text: "Working on it" }],
          usage: {
            input_tokens: 1200,
            cache_creation_input_tokens: 5000,
            cache_read_input_tokens: 52000,
            output_tokens: 708,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvents = runtimeEvents.filter(
        (event) => event.type === "thread.token-usage.updated",
      );

      // The main-thread message's usage lands...
      const main = usageEvents.find(
        (event) =>
          event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 58908,
      );
      assert.equal(main?.type, "thread.token-usage.updated");

      // ...and NOTHING carries the subagent's inflated numbers. Asserted on the
      // values rather than on "no events at all", so the test still fails if the
      // subagent's tokens reach the meter, and cannot pass merely because the
      // adapter went silent.
      for (const event of usageEvents) {
        if (event.type !== "thread.token-usage.updated") continue;
        assert.ok(
          event.payload.usage.usedTokens < 999999,
          `subagent tokens reached the context meter: ${event.payload.usage.usedTokens}`,
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("resets the context window meter after a compact boundary", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Collect until the compacted state-change event (emitted right after the
      // reset usage event in the compact_boundary handler), so the test does not
      // depend on an exact upstream event count.
      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "thread.state.changed",
      ).pipe(Stream.runCollect, Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      // Establish the context window (1M) via a result.
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: "ok",
        stop_reason: "end_turn",
        session_id: "sdk-session-compact",
        usage: { input_tokens: 900000, output_tokens: 1000 },
        modelUsage: { "claude-opus-4-8": { contextWindow: 1000000, maxOutputTokens: 64000 } },
      } as unknown as SDKMessage);

      // The compaction shrinks the context to post_tokens; the meter must reset.
      harness.query.emit({
        type: "system",
        subtype: "compact_boundary",
        session_id: "sdk-session-compact",
        uuid: "compact-1",
        compact_metadata: {
          trigger: "manual",
          pre_tokens: 901000,
          post_tokens: 42000,
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const resetEvent = runtimeEvents.find(
        (event) =>
          event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 42000,
      );
      assert.equal(resetEvent?.type, "thread.token-usage.updated");
      if (resetEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(resetEvent.payload.usage, {
          usedTokens: 42000,
          lastUsedTokens: 42000,
          maxTokens: 1000000,
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "emits completion only after turn result when assistant frames arrive before deltas",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-early-assistant",
          uuid: "assistant-early",
          parent_tool_use_id: null,
          message: {
            id: "assistant-message-early",
            content: [
              { type: "tool_use", id: "tool-early", name: "Read", input: { path: "a.ts" } },
            ],
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-early-assistant",
          uuid: "stream-early",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "Late text",
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-early-assistant",
          uuid: "result-early",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepEqual(
          runtimeEvents.map((event) => event.type),
          [
            "session.started",
            "session.configured",
            "session.state.changed",
            "turn.started",
            "thread.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );

        const deltaIndex = runtimeEvents.findIndex((event) => event.type === "content.delta");
        const completedIndex = runtimeEvents.findIndex((event) => event.type === "item.completed");
        assert.equal(deltaIndex >= 0 && completedIndex >= 0 && deltaIndex < completedIndex, true);

        const deltaEvent = runtimeEvents[deltaIndex];
        assert.equal(deltaEvent?.type, "content.delta");
        if (deltaEvent?.type === "content.delta") {
          assert.equal(deltaEvent.payload.delta, "Late text");
          assert.equal(String(deltaEvent.turnId), String(turn.turnId));
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("creates a fresh assistant message when Claude reuses a text block index", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Second",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-reused-text-index",
        uuid: "result-reused-text-index",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "content.delta",
          "item.completed",
        ],
      );

      const assistantDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantDeltas.length, 2);
      if (assistantDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantDeltas;
      assert.equal(firstAssistantDelta?.type, "content.delta");
      assert.equal(secondAssistantDelta?.type, "content.delta");
      if (
        firstAssistantDelta?.type !== "content.delta" ||
        secondAssistantDelta?.type !== "content.delta"
      ) {
        return;
      }
      assert.equal(firstAssistantDelta.payload.delta, "First");
      assert.equal(secondAssistantDelta.payload.delta, "Second");
      assert.notEqual(firstAssistantDelta.itemId, secondAssistantDelta.itemId);

      const assistantCompletions = runtimeEvents.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.equal(assistantCompletions.length, 2);
      assert.equal(String(assistantCompletions[0]?.itemId), String(firstAssistantDelta.itemId));
      assert.equal(String(assistantCompletions[1]?.itemId), String(secondAssistantDelta.itemId));
      assert.notEqual(
        String(assistantCompletions[0]?.itemId),
        String(assistantCompletions[1]?.itemId),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to assistant payload text when stream deltas are absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-fallback-text",
        uuid: "assistant-fallback",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-fallback",
          content: [{ type: "text", text: "Fallback hello" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-fallback-text",
        uuid: "result-fallback",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Fallback hello");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("segments Claude assistant text blocks around tool calls", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-interleaved-1",
            name: "Grep",
            input: {
              pattern: "assistant",
              path: "src",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-interleaved",
        uuid: "user-tool-result-interleaved",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-interleaved-1",
              content: "src/example.ts:1:assistant",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 2,
          delta: {
            type: "text_delta",
            text: "Second message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 2,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-interleaved",
        uuid: "result-interleaved",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.updated",
          "item.completed",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const assistantTextDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantTextDeltas.length, 2);
      if (assistantTextDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantTextDeltas;
      if (!firstAssistantDelta || !secondAssistantDelta) {
        return;
      }
      assert.notEqual(String(firstAssistantDelta.itemId), String(secondAssistantDelta.itemId));

      const firstAssistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          String(event.itemId) === String(firstAssistantDelta.itemId),
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      const secondAssistantDeltaIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "content.delta" &&
          event.payload.streamKind === "assistant_text" &&
          String(event.itemId) === String(secondAssistantDelta.itemId),
      );

      assert.equal(
        firstAssistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          secondAssistantDeltaIndex >= 0 &&
          firstAssistantCompletedIndex < toolStartedIndex &&
          toolStartedIndex < secondAssistantDeltaIndex,
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not fabricate provider thread ids before first SDK session_id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      assert.equal(session.threadId, THREAD_ID);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(turn.threadId, THREAD_ID);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-thread-real",
        uuid: "stream-thread-real",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-thread-real",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-thread-real",
        uuid: "result-thread-real",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
        ],
      );

      const sessionStarted = runtimeEvents[0];
      assert.equal(sessionStarted?.type, "session.started");
      if (sessionStarted?.type === "session.started") {
        assert.equal(sessionStarted.threadId, THREAD_ID);
      }

      const threadStarted = runtimeEvents[4];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.equal(threadStarted.threadId, THREAD_ID);
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: "sdk-thread-real",
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("bridges approval request/response lifecycle through canUseTool", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "approve this",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-approval-1",
        uuid: "stream-approval-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-approval-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "Bash",
        { command: "pwd" },
        {
          signal: new AbortController().signal,
          requestId: "request-1",
          suggestions: [
            {
              type: "setMode",
              mode: "default",
              destination: "session",
            },
          ],
          toolUseID: "tool-use-1",
        },
      );

      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some") {
        return;
      }
      assert.equal(requested.value.type, "request.opened");
      if (requested.value.type !== "request.opened") {
        return;
      }
      assert.deepEqual(requested.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-use-1"),
      });
      const runtimeRequestId = requested.value.requestId;
      assert.equal(typeof runtimeRequestId, "string");
      if (runtimeRequestId === undefined) {
        return;
      }

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(runtimeRequestId),
        "accept",
      );

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag !== "Some") {
        return;
      }
      assert.equal(resolved.value.type, "request.resolved");
      if (resolved.value.type !== "request.resolved") {
        return;
      }
      assert.equal(resolved.value.requestId, requested.value.requestId);
      assert.equal(resolved.value.payload.decision, "accept");
      assert.deepEqual(resolved.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-use-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("acceptForSession returns session-scoped permission updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "approve this for the session",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const respondToNextRequest = Effect.gen(function* () {
        const requested = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(requested._tag, "Some");
        if (requested._tag !== "Some" || requested.value.type !== "request.opened") {
          return;
        }
        const runtimeRequestId = requested.value.requestId;
        assert.equal(typeof runtimeRequestId, "string");
        if (runtimeRequestId === undefined) {
          return;
        }
        yield* adapter.respondToRequest(
          session.threadId,
          ApprovalRequestId.make(runtimeRequestId),
          "acceptForSession",
        );
        yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);
      });

      // MCP tools frequently arrive with no usable suggestion (Claude Code
      // sends an empty array); the decision must still stick for the session.
      const mcpPermissionPromise = canUseTool(
        "mcp__linear__create_issue",
        { title: "hello" },
        {
          signal: new AbortController().signal,
          requestId: "request-2",
          suggestions: [],
          toolUseID: "tool-use-mcp-1",
        },
      );
      yield* respondToNextRequest;
      const mcpPermission = (yield* Effect.promise(() => mcpPermissionPromise)) as PermissionResult;
      assert.equal(mcpPermission.behavior, "allow");
      if (mcpPermission.behavior !== "allow") {
        return;
      }
      assert.deepEqual(mcpPermission.updatedPermissions, [
        {
          type: "addRules",
          rules: [{ toolName: "mcp__linear__create_issue" }],
          behavior: "allow",
          destination: "session",
        },
      ]);

      // Received suggestions are reused but rescoped to the session —
      // echoing "localSettings" would persist a session-only choice to disk.
      const bashPermissionPromise = canUseTool(
        "Bash",
        { command: "git status" },
        {
          signal: new AbortController().signal,
          requestId: "request-3",
          suggestions: [
            {
              type: "addRules",
              rules: [{ toolName: "Bash", ruleContent: "git status" }],
              behavior: "allow",
              destination: "localSettings",
            },
          ],
          toolUseID: "tool-use-bash-1",
        },
      );
      yield* respondToNextRequest;
      const bashPermission = (yield* Effect.promise(
        () => bashPermissionPromise,
      )) as PermissionResult;
      assert.equal(bashPermission.behavior, "allow");
      if (bashPermission.behavior !== "allow") {
        return;
      }
      assert.deepEqual(bashPermission.updatedPermissions, [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "git status" }],
          behavior: "allow",
          destination: "session",
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Agent tools and read-only Claude tools correctly for approvals", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const agentPermissionPromise = canUseTool(
        "Agent",
        {},
        {
          signal: new AbortController().signal,
          requestId: "request-4",
          toolUseID: "tool-agent-1",
        },
      );

      const agentRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(agentRequested._tag, "Some");
      if (agentRequested._tag !== "Some" || agentRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(agentRequested.value.payload.requestType, "dynamic_tool_call");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(String(agentRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => agentPermissionPromise);

      const grepPermissionPromise = canUseTool(
        "Grep",
        { pattern: "foo", path: "src" },
        {
          signal: new AbortController().signal,
          requestId: "request-5",
          toolUseID: "tool-grep-approval-1",
        },
      );

      const grepRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(grepRequested._tag, "Some");
      if (grepRequested._tag !== "Some" || grepRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(grepRequested.value.payload.requestType, "file_read_approval");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(String(grepRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => grepPermissionPromise);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes Claude resume ids without pinning a stale assistant checkpoint", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: "resume-thread-1",
          resume: "550e8400-e29b-41d4-a716-446655440000",
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, RESUME_THREAD_ID);
      assert.deepEqual(session.resumeCursor, {
        threadId: RESUME_THREAD_ID,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        resumeSessionAt: "assistant-99",
        turnCount: 3,
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.resume, "550e8400-e29b-41d4-a716-446655440000");
      assert.equal(createInput?.options.sessionId, undefined);
      assert.equal(createInput?.options.resumeSessionAt, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves durable resume ids across Claude resume hooks", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const durableSessionId = "550e8400-e29b-41d4-a716-446655440000";
      const transientHookSessionId = "7368d0c7-40a3-4d8a-bcc1-ac80c49f2719";

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: durableSessionId,
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "hook_started",
        hook_id: "resume-hook-1",
        hook_name: "SessionStart:resume",
        hook_event: "SessionStart",
        session_id: transientHookSessionId,
        uuid: "resume-hook-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "hook_response",
        hook_id: "resume-hook-1",
        hook_name: "SessionStart:resume",
        hook_event: "SessionStart",
        output: "",
        stdout: "",
        stderr: "",
        outcome: "success",
        session_id: transientHookSessionId,
        uuid: "resume-hook-response",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        claude_code_version: "test",
        cwd: "/tmp/claude-adapter-test",
        tools: [],
        mcp_servers: [],
        model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
        permissionMode: "bypassPermissions",
        slash_commands: [],
        output_style: "default",
        skills: [],
        plugins: [],
        session_id: durableSessionId,
        uuid: "resume-init",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const threadStartedEvents = runtimeEvents.filter((event) => event.type === "thread.started");
      assert.equal(threadStartedEvents.length, 1);
      const threadStarted = threadStartedEvents[0];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: durableSessionId,
        });
      }

      const activeSessions = yield* adapter.listSessions();
      const resumeCursor = activeSessions[0]?.resumeCursor as
        | {
            readonly resume?: string;
          }
        | undefined;
      assert.equal(resumeCursor?.resume, durableSessionId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses an app-generated Claude session id for fresh sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      const sessionResumeCursor = session.resumeCursor as {
        threadId?: string;
        resume?: string;
        turnCount?: number;
      };
      assert.equal(sessionResumeCursor.threadId, THREAD_ID);
      assert.equal(typeof sessionResumeCursor.resume, "string");
      assert.equal(sessionResumeCursor.turnCount, 0);
      assert.match(
        sessionResumeCursor.resume ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(createInput?.options.resume, undefined);
      assert.equal(createInput?.options.sessionId, sessionResumeCursor.resume);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "supports rollbackThread by trimming in-memory turns and preserving earlier turns",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const firstTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "first",
          attachments: [],
        });

        const firstCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-rollback",
          uuid: "result-first",
        } as unknown as SDKMessage);

        const firstCompleted = yield* Fiber.join(firstCompletedFiber);
        assert.equal(firstCompleted._tag, "Some");
        if (firstCompleted._tag === "Some" && firstCompleted.value.type === "turn.completed") {
          assert.equal(String(firstCompleted.value.turnId), String(firstTurn.turnId));
        }

        const secondTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "second",
          attachments: [],
        });

        const secondCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-rollback",
          uuid: "result-second",
        } as unknown as SDKMessage);

        const secondCompleted = yield* Fiber.join(secondCompletedFiber);
        assert.equal(secondCompleted._tag, "Some");
        if (secondCompleted._tag === "Some" && secondCompleted.value.type === "turn.completed") {
          assert.equal(String(secondCompleted.value.turnId), String(secondTurn.turnId));
        }

        const threadBeforeRollback = yield* adapter.readThread(session.threadId);
        assert.equal(threadBeforeRollback.turns.length, 2);

        const rolledBack = yield* adapter.rollbackThread(session.threadId, 1);
        assert.equal(rolledBack.turns.length, 1);
        assert.equal(rolledBack.turns[0]?.id, firstTurn.turnId);

        const threadAfterRollback = yield* adapter.readThread(session.threadId);
        assert.equal(threadAfterRollback.turns.length, 1);
        assert.equal(threadAfterRollback.turns[0]?.id, firstTurn.turnId);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("updates model on sendTurn when model override is provided", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: SYNTHETIC_CLAUDE_CAPABLE_MODEL,
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, [
        `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`,
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("updates model on sendTurn for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("claude_openrouter");
    const harness = makeHarness({ instanceId: customInstanceId });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          instanceId: customInstanceId,
          model: "openai/gpt-5.5",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["openai/gpt-5.5"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "does not re-set the Claude model when the session already uses the same effective API model",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const modelSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: SYNTHETIC_CLAUDE_CAPABLE_MODEL,
        };

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection,
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          modelSelection,
          attachments: [],
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello again",
          modelSelection,
          attachments: [],
        });

        assert.deepEqual(harness.query.setModelCalls, []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "re-sets the Claude model when a queued follow-up turn uses a different effective API model",
    () => {
      const harness = makeHarness({ modelCatalog: Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG) });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        // Subscribe before emitting so the collector never misses an event.
        const eventsFiber = yield* Stream.takeUntil(
          adapter.streamEvents,
          (event) => event.type === "session.exited",
        ).pipe(Stream.runCollect, Effect.forkChild);

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-opus-4-6",
            [{ id: "contextWindow", value: "1m" }],
          ),
          attachments: [],
        });

        // Sent while the first turn is still running: this queues behind it and
        // must not change the model until it actually starts. It selects a
        // different effective context window (200k vs the first turn's 1m) so
        // its resolved API model id genuinely differs and the queued-turn drain
        // must re-apply setModel.
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello again",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-opus-4-6",
            [{ id: "contextWindow", value: "200k" }],
          ),
          attachments: [],
        });

        // Only the active turn's model has been applied; the queued turn's is
        // deferred until it actually starts.
        assert.deepEqual(harness.query.setModelCalls, ["claude-opus-4-6[1m]"]);

        const makeResult = (sessionId: string) =>
          ({
            type: "result",
            subtype: "success",
            is_error: false,
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            result: "ok",
            stop_reason: "end_turn",
            session_id: sessionId,
          }) as unknown as SDKMessage;

        // Completing the first turn drains the queued follow-up, which starts
        // and re-applies its (different) effective model. Completing the second
        // and finishing the stream lets the collector terminate.
        harness.query.emit(makeResult("sdk-session-model-reset-1"));
        harness.query.emit(makeResult("sdk-session-model-reset-2"));
        harness.query.finish();

        const events = Array.from(yield* Fiber.join(eventsFiber));
        const startedCount = events.filter((event) => event.type === "turn.started").length;

        assert.equal(startedCount, 2);
        assert.deepEqual(harness.query.setModelCalls, ["claude-opus-4-6[1m]", "claude-opus-4-6"]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("drops queued follow-up turns when the active turn is interrupted", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const eventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "session.exited",
      ).pipe(Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const firstTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      // Queued behind the running turn.
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello again",
        attachments: [],
      });

      // Interrupting the active turn must discard the queued follow-up: a
      // deliberate stop should not silently fire the stacked message. Finishing
      // the stream afterwards proves no second turn ever started.
      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming",
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: "interrupted",
        session_id: "sdk-session-interrupt-drop",
      } as unknown as SDKMessage);
      harness.query.finish();

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const startedTurnIds = events
        .filter((event) => event.type === "turn.started")
        .map((event) => (event.type === "turn.started" ? event.turnId : null));
      const completed = events.find((event) => event.type === "turn.completed");

      // Exactly one turn started (the interrupted one); the queued turn never ran.
      assert.deepEqual(startedTurnIds, [firstTurn.turnId]);
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.turnId, firstTurn.turnId);
        assert.equal(completed.payload.state, "interrupted");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("drains multiple queued follow-up turns in FIFO order", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const eventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "session.exited",
      ).pipe(Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // First turn starts immediately; the next two queue behind it.
      const first = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "first",
        attachments: [],
      });
      const second = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "second",
        attachments: [],
      });
      const third = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "third",
        attachments: [],
      });

      const makeResult = (sessionId: string) =>
        ({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          result: "ok",
          stop_reason: "end_turn",
          session_id: sessionId,
        }) as unknown as SDKMessage;

      // Each completion drains exactly one queued turn, in order.
      harness.query.emit(makeResult("sdk-fifo-1"));
      harness.query.emit(makeResult("sdk-fifo-2"));
      harness.query.emit(makeResult("sdk-fifo-3"));
      harness.query.finish();

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const startedTurnIds = events
        .filter((event) => event.type === "turn.started")
        .map((event) => (event.type === "turn.started" ? event.turnId : null));

      assert.deepEqual(startedTurnIds, [first.turnId, second.turnId, third.turnId]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sets plan permission mode on sendTurn when interactionMode is plan", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this for me",
        interactionMode: "plan",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect.each<{ runtimeMode: RuntimeMode; expectedBase: PermissionMode }>([
    { runtimeMode: "full-access", expectedBase: "bypassPermissions" },
    { runtimeMode: "approval-required", expectedBase: "default" },
    { runtimeMode: "auto-accept-edits", expectedBase: "acceptEdits" },
  ])(
    "restores $expectedBase permission mode after plan turn ($runtimeMode)",
    ({ runtimeMode, expectedBase }) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode,
        });

        // First turn in plan mode
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
        });

        // Complete the turn so we can send another
        const turnCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: `sdk-session-${runtimeMode}`,
          uuid: `result-${runtimeMode}`,
        } as unknown as SDKMessage);

        yield* Fiber.join(turnCompletedFiber);

        // Second turn back to default
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "now do it",
          interactionMode: "default",
          attachments: [],
        });

        assert.deepEqual(harness.query.setPermissionModeCalls, ["plan", expectedBase]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("does not call setPermissionMode when interactionMode is absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("captures ExitPlanMode as a proposed plan and denies auto-exit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "ExitPlanMode",
        {
          plan: "# Ship it\n\n- one\n- two",
          allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
        },
        {
          signal: new AbortController().signal,
          requestId: "request-6",
          toolUseID: "tool-exit-1",
        },
      );

      const proposedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Ship it\n\n- one\n- two");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-exit-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "deny");
      const deniedResult = permissionResult as PermissionResult & {
        message?: string;
      };
      assert.equal(deniedResult.message?.includes("captured your proposed plan"), true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("extracts proposed plans from assistant ExitPlanMode snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const proposedEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.proposed.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-exit-plan",
        uuid: "assistant-exit-plan",
        parent_tool_use_id: null,
        message: {
          model: SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          id: "msg-exit-plan",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-exit-2",
              name: "ExitPlanMode",
              input: {
                plan: "# Final plan\n\n- capture it",
              },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: {},
        },
      } as unknown as SDKMessage);

      const proposedEvent = yield* Fiber.join(proposedEventFiber);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Final plan\n\n- capture it");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-exit-2"),
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("routes Claude resume compaction through the shared user-input UI", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: { resume: "550e8400-e29b-41d4-a716-446655440000" },
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const onUserDialog = harness.getLastCreateQueryInput()?.options.onUserDialog;
      assert.equal(typeof onUserDialog, "function");
      if (!onUserDialog) return;

      const dialogPromise = onUserDialog(
        {
          dialogKind: "resume_return",
          payload: { sessionAgeMinutes: 145, estimatedTokens: 275123 },
        },
        { signal: new AbortController().signal, requestId: "request-dialog" },
      );

      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some" || requested.value.type !== "user-input.requested") return;
      const question = requested.value.payload.questions[0];
      assert.equal(question?.header, "Resume session");
      assert.match(question?.question ?? "", /2h 25m/);
      assert.match(question?.question ?? "", /275,123 tokens/);
      assert.deepEqual(
        question?.options.map((option) => option.label),
        ["Compact and continue", "Keep full history", "Don't ask again"],
      );
      if (!question || !requested.value.requestId) return;

      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.make(requested.value.requestId),
        { [question.id]: "Compact and continue" },
      );

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag === "Some") assert.equal(resolved.value.type, "user-input.resolved");
      assert.deepEqual(yield* Effect.promise(() => dialogPromise), {
        behavior: "completed",
        result: "compact",
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("handles AskUserQuestion via user-input.requested/resolved lifecycle", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Start session in approval-required mode so canUseTool fires.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      // Drain the session startup events (started, configured, state.changed).
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "question turn",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-user-input-1",
        uuid: "stream-user-input-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-user-input-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      // Simulate Claude calling AskUserQuestion with structured questions.
      const askInput = {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [
              { label: "React", description: "React.js" },
              { label: "Vue", description: "Vue.js" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        requestId: "request-7",
        toolUseID: "tool-ask-1",
      });

      // The adapter should emit a user-input.requested event.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some") {
        return;
      }
      assert.equal(requestedEvent.value.type, "user-input.requested");
      if (requestedEvent.value.type !== "user-input.requested") {
        return;
      }
      const requestId = requestedEvent.value.requestId;
      assert.equal(typeof requestId, "string");
      assert.equal(requestedEvent.value.payload.questions.length, 1);
      assert.equal(requestedEvent.value.payload.questions[0]?.question, "Which framework?");
      // Regression for #2388: `id` must equal the full question text so the
      // UI's draft-answer key matches what the SDK looks up downstream.
      assert.equal(requestedEvent.value.payload.questions[0]?.id, "Which framework?");
      assert.deepEqual(requestedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-ask-1"),
      });

      // Respond with the user's answers.
      yield* adapter.respondToUserInput(session.threadId, ApprovalRequestId.make(requestId!), {
        "Which framework?": "React",
      });

      // The adapter should emit a user-input.resolved event.
      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some") {
        return;
      }
      assert.equal(resolvedEvent.value.type, "user-input.resolved");
      if (resolvedEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {
        "Which framework?": "React",
      });
      assert.deepEqual(resolvedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-ask-1"),
      });

      // The canUseTool promise should resolve with the answers in SDK format.
      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Which framework?": "React" });
      // Original questions should be passed through.
      assert.deepEqual(updatedInput.questions, askInput.questions);

      // Compatibility check for #2388: the answers shape we hand to the SDK
      // must produce a non-empty rendered tool_result on BOTH SDK iteration
      // patterns we have seen, so we don't regress the issue and we don't
      // break users still on the older Claude CLI.
      const sdkAnswers = updatedInput.answers as Record<string, unknown>;
      const sdkQuestions = updatedInput.questions as ReadonlyArray<{
        readonly question: string;
      }>;

      // Claude CLI 2.1.119 — key-agnostic Object.entries iteration. Any key
      // works here, but it must at least round-trip into a non-empty string.
      const v119Rendered = Object.entries(sdkAnswers)
        .map(([key, value]) => `"${key}"="${String(value)}"`)
        .join(", ");
      assert.equal(v119Rendered, '"Which framework?"="React"');

      // Claude CLI 2.1.121 — lookup by full question text. This is the path
      // that regressed in #2388 when the answers were keyed by `header`.
      const v121Rendered = sdkQuestions
        .map(({ question }) => {
          const answer = sdkAnswers[question];
          return answer === undefined ? null : `"${question}"="${String(answer)}"`;
        })
        .filter((entry): entry is string => entry !== null)
        .join(", ");
      assert.notEqual(v121Rendered, "", "Expected non-empty SDK 2.1.121 tool_result (#2388)");
      assert.equal(v121Rendered, '"Which framework?"="React"');
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("routes AskUserQuestion through user-input flow even in full-access mode", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // In full-access mode, regular tools are auto-approved.
      // AskUserQuestion should still go through the user-input flow.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const askInput = {
        questions: [
          {
            question: "Deploy to which env?",
            header: "Env",
            options: [
              { label: "Staging", description: "Staging environment" },
              { label: "Production", description: "Production environment" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        requestId: "request-8",
        toolUseID: "tool-ask-2",
      });

      // Should still get user-input.requested even in full-access mode.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      const requestId = requestedEvent.value.requestId;

      yield* adapter.respondToUserInput(session.threadId, ApprovalRequestId.make(requestId!), {
        "Deploy to which env?": "Staging",
      });

      // Drain the resolved event.
      yield* Stream.runHead(adapter.streamEvents);

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Deploy to which env?": "Staging" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("denies AskUserQuestion when the waiting turn is aborted", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const controller = new AbortController();
      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: controller.signal,
          requestId: "request-9",
          toolUseID: "tool-ask-abort",
        },
      );

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      assert.equal(requestedEvent.value.threadId, session.threadId);

      controller.abort();

      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {});

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("denies AskUserQuestion when the signal aborted before the listener registered", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      // Abort before the call so the adapter's listener registration can
      // never observe the abort event, only the recheck can.
      const controller = new AbortController();
      controller.abort();
      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: controller.signal,
          requestId: "request-10",
          toolUseID: "tool-ask-pre-aborted",
        },
      );

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["user-input.requested", "user-input.resolved"],
      );
      const resolvedEvent = runtimeEvents[1];
      if (resolvedEvent?.type === "user-input.resolved") {
        assert.deepEqual(resolvedEvent.payload.answers, {});
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stopping a session settles pending user-input waits", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: new AbortController().signal,
          requestId: "request-stop",
          toolUseID: "tool-ask-stop",
        },
      );

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }

      // The session dies while the question is still on screen.
      yield* adapter.stopSession(THREAD_ID);

      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {});

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("writes provider-native observability records when enabled", () => {
    const nativeEvents: Array<{
      event?: {
        provider?: string;
        method?: string;
        threadId?: string;
        turnId?: string;
      };
    }> = [];
    const nativeThreadIds: Array<string | null> = [];
    const harness = makeHarness({
      nativeEventLogger: {
        filePath: "memory://claude-native-events",
        write: (event, threadId) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-native-log",
        uuid: "stream-native-log",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-native-log",
        uuid: "result-native-log",
      } as unknown as SDKMessage);

      const turnCompleted = yield* Fiber.join(turnCompletedFiber);
      assert.equal(turnCompleted._tag, "Some");

      assert.equal(nativeEvents.length > 0, true);
      assert.equal(
        nativeEvents.some((record) => record.event?.provider === "claudeAgent"),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) =>
            String(
              (record.event as { readonly providerThreadId?: string } | undefined)
                ?.providerThreadId,
            ) === "sdk-session-native-log",
        ),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => String(record.event?.turnId) === String(turn.turnId)),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) => record.event?.method === "claude/stream_event/content_block_delta/text_delta",
        ),
        true,
      );
      assert.equal(
        nativeThreadIds.every((threadId) => threadId === String(THREAD_ID)),
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("thinkingTokensDisplayBucket", () => {
  it("buckets sub-1000 counts at integer granularity", () => {
    assert.strictEqual(thinkingTokensDisplayBucket(97), "97");
    assert.strictEqual(thinkingTokensDisplayBucket(512), "512");
  });

  it("buckets 1k–10k at one decimal and 10k+ at integer k", () => {
    assert.strictEqual(thinkingTokensDisplayBucket(1500), "1.5k");
    assert.strictEqual(thinkingTokensDisplayBucket(2048), "2.0k");
    assert.strictEqual(thinkingTokensDisplayBucket(12_345), "12k");
  });

  it("collapses values within the same bucket so emission is throttled", () => {
    // 12_300 and 12_400 both round to "12k" -> no re-emit between them.
    assert.strictEqual(thinkingTokensDisplayBucket(12_300), thinkingTokensDisplayBucket(12_400));
    assert.notStrictEqual(thinkingTokensDisplayBucket(12_300), thinkingTokensDisplayBucket(13_000));
  });

  it("returns a stable zero bucket for non-positive or non-finite input", () => {
    assert.strictEqual(thinkingTokensDisplayBucket(0), "0");
    assert.strictEqual(thinkingTokensDisplayBucket(-5), "0");
    assert.strictEqual(thinkingTokensDisplayBucket(Number.NaN), "0");
  });

  it.effect("treats aborted_tools results as interrupted and hides ede_diagnostic errors", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      // Exact shape the CLI emits when Stop lands mid-tool-call: is_error
      // is true and the only error is internal diagnostic telemetry.
      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
        stop_reason: "tool_use",
        terminal_reason: "aborted_tools",
        session_id: "sdk-session-abort-tools",
        uuid: "result-abort-tools",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, undefined);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // Task ownership. The SDK's task_started carries no owner, so a subagent's
  // background shell is indistinguishable on the wire from the main agent's.
  // What separates them is whether THIS session streamed the launching tool.
  // Each arm below differs from its neighbour in exactly one input.
  const emitToolBlock = (
    harness: ReturnType<typeof makeHarness>,
    input: {
      readonly index: number;
      readonly toolUseId: string;
      readonly parentToolUseId: string | null;
    },
  ) => {
    harness.query.emit({
      type: "stream_event",
      session_id: "sdk-session",
      uuid: `stream-${input.toolUseId}`,
      parent_tool_use_id: input.parentToolUseId,
      event: {
        type: "content_block_start",
        index: input.index,
        content_block: { type: "tool_use", id: input.toolUseId, name: "Bash", input: {} },
      },
    } as unknown as SDKMessage);
  };

  const emitTaskStarted = (
    harness: ReturnType<typeof makeHarness>,
    input: { readonly taskId: string; readonly taskType: string; readonly toolUseId?: string },
  ) => {
    harness.query.emit({
      type: "system",
      subtype: "task_started",
      task_id: input.taskId,
      description: input.taskId,
      task_type: input.taskType,
      ...(input.toolUseId ? { tool_use_id: input.toolUseId } : {}),
      uuid: `${input.taskId}-uuid`,
      session_id: "sdk-session",
    } as unknown as SDKMessage);
  };

  const ownershipOf = (events: ReadonlyArray<ProviderRuntimeEvent>, taskId: string) => {
    const started = events.find(
      (event) => event.type === "task.started" && String(event.payload.taskId) === taskId,
    );
    assert.ok(started, `no task.started for ${taskId}`);
    return started.type === "task.started" ? started.payload.subagentOwned : undefined;
  };

  const runOwnershipScenario = (
    take: number,
    scenario: (harness: ReturnType<typeof makeHarness>) => void,
  ) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.started"),
        Stream.take(take),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "go", attachments: [] });
      scenario(harness);
      return Array.from(yield* Fiber.join(taskEventsFiber));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  };

  it.effect(
    "a background task whose launching tool this session never streamed is subagent-owned",
    () =>
      Effect.gen(function* () {
        const events = yield* runOwnershipScenario(3, (harness) => {
          // A subagent is live, so there is somebody else the task could belong to.
          emitTaskStarted(harness, { taskId: "agent-1", taskType: "local_agent" });
          // Parent-owned control: its tool block came through this session.
          emitToolBlock(harness, { index: 0, toolUseId: "tool-main", parentToolUseId: null });
          emitTaskStarted(harness, {
            taskId: "bash-main",
            taskType: "local_bash",
            toolUseId: "tool-main",
          });
          // Foreign: the launcher is named but was never streamed here.
          emitTaskStarted(harness, {
            taskId: "bash-sub",
            taskType: "local_bash",
            toolUseId: "tool-never-seen",
          });
        });

        assert.equal(ownershipOf(events, "bash-sub"), true);
        // Positive control in the same run: the classifier still says "mine"
        // for a task launched by a tool this session did stream, while the same
        // subagent is live. Without this the assertion above would also pass if
        // everything were marked foreign.
        assert.equal(ownershipOf(events, "bash-main"), undefined);
      }),
  );

  it.effect("a main-agent fan-out of sibling agents is not misread as subagent-owned", () =>
    Effect.gen(function* () {
      // Both Agent launches arrive without a tool_use_id. Classifying on
      // liveness alone would call the second one foreign because the first is
      // already live - the shape this repo's own interruptTurn test emits.
      const events = yield* runOwnershipScenario(2, (harness) => {
        emitTaskStarted(harness, { taskId: "agent-a", taskType: "local_agent" });
        emitTaskStarted(harness, { taskId: "agent-b", taskType: "local_agent" });
      });

      assert.equal(ownershipOf(events, "agent-a"), undefined);
      assert.equal(ownershipOf(events, "agent-b"), undefined);
    }),
  );

  it.effect("ownership is decided once and survives a task_started re-announcement", () =>
    Effect.gen(function* () {
      // A re-announced task_started arrives without its tool_use_id. Recomputing
      // would flip a parent-owned task to foreign the moment a subagent is live.
      const events = yield* runOwnershipScenario(3, (harness) => {
        emitToolBlock(harness, { index: 0, toolUseId: "tool-main", parentToolUseId: null });
        emitTaskStarted(harness, {
          taskId: "bash-main",
          taskType: "local_bash",
          toolUseId: "tool-main",
        });
        emitTaskStarted(harness, { taskId: "agent-1", taskType: "local_agent" });
        emitTaskStarted(harness, { taskId: "bash-main", taskType: "local_bash" });
      });

      const reannounced = events.filter(
        (event) => event.type === "task.started" && String(event.payload.taskId) === "bash-main",
      );
      assert.equal(reannounced.length, 2);
      for (const event of reannounced) {
        assert.equal(
          event.type === "task.started" ? event.payload.subagentOwned : "missing",
          undefined,
        );
      }
    }),
  );

  it.effect("a re-announced subagent task keeps its ownership instead of reverting", () =>
    Effect.gen(function* () {
      // The other direction of the same guard, and the one that needs it: a
      // foreign task re-announced without its tool_use_id would otherwise fall
      // through to "parent-owned" and get the false-premise wording on its
      // second announcement. Two task ids do this in real data.
      const events = yield* runOwnershipScenario(3, (harness) => {
        emitTaskStarted(harness, { taskId: "agent-1", taskType: "local_agent" });
        emitTaskStarted(harness, {
          taskId: "bash-sub",
          taskType: "local_bash",
          toolUseId: "tool-never-seen",
        });
        emitTaskStarted(harness, { taskId: "bash-sub", taskType: "local_bash" });
      });

      const reannouncedForeign = events.filter(
        (event) => event.type === "task.started" && String(event.payload.taskId) === "bash-sub",
      );
      assert.equal(reannouncedForeign.length, 2);
      for (const event of reannouncedForeign) {
        assert.equal(event.type === "task.started" ? event.payload.subagentOwned : "missing", true);
      }
    }),
  );

  it.effect("an unseen launcher with no subagent running stays parent-owned", () =>
    Effect.gen(function* () {
      // Fail-open. After a restart the seen-tool set is empty, so every
      // launcher looks unseen; with no agent-flavoured task in flight there is
      // nobody else the task could belong to, and guessing "foreign" would
      // rewrite a real background task's wake into a delegation notice.
      const events = yield* runOwnershipScenario(1, (harness) => {
        emitTaskStarted(harness, {
          taskId: "bash-orphan",
          taskType: "local_bash",
          toolUseId: "tool-never-seen",
        });
      });

      assert.equal(ownershipOf(events, "bash-orphan"), undefined);
    }),
  );

  it.effect("task.completed repeats the ownership stamp, which is where the wake reads it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.completed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "go", attachments: [] });

      emitTaskStarted(harness, { taskId: "agent-1", taskType: "local_agent" });
      emitToolBlock(harness, { index: 0, toolUseId: "tool-main", parentToolUseId: null });
      emitTaskStarted(harness, {
        taskId: "bash-main",
        taskType: "local_bash",
        toolUseId: "tool-main",
      });
      emitTaskStarted(harness, {
        taskId: "bash-sub",
        taskType: "local_bash",
        toolUseId: "tool-never-seen",
      });
      for (const taskId of ["bash-sub", "bash-main"]) {
        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: taskId,
          status: "completed",
          summary: "done",
          uuid: `${taskId}-done`,
          session_id: "sdk-session",
        } as unknown as SDKMessage);
      }

      const completed = Array.from(yield* Fiber.join(completedFiber));
      const ownershipAt = (taskId: string) => {
        const event = completed.find(
          (candidate) =>
            candidate.type === "task.completed" && String(candidate.payload.taskId) === taskId,
        );
        assert.ok(event, `no task.completed for ${taskId}`);
        return event.type === "task.completed" ? event.payload.subagentOwned : undefined;
      };

      // The stamp is set on task_started; the terminal row is what the wake
      // gate actually reads, so it has to be repeated there.
      assert.equal(ownershipAt("bash-sub"), true);
      assert.equal(ownershipAt("bash-main"), undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("interruptTurn settles every acknowledged live task before interrupting", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Wait for the three task.* runtime events to prove the lifecycle
      // handlers processed the emissions (no wall-clock sleeps under the
      // test clock).
      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type.startsWith("task.")),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "spawn agents",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-live",
        description: "Agent A",
        task_type: "local_agent",
        uuid: "task-live-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-settled",
        description: "Agent B",
        task_type: "local_agent",
        uuid: "task-settled-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-settled",
        status: "completed",
        output_file: "/tmp/task-settled.jsonl",
        summary: "done",
        uuid: "task-settled-done-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      yield* Fiber.join(taskEventsFiber);

      const stoppedTaskEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.interruptTurn(session.threadId);

      // Only the still-live task is stopped; interrupt always fires after.
      assert.deepEqual(harness.query.stopTaskCalls, ["task-live"]);
      assert.equal(harness.query.interruptCalls.length, 1);

      const stoppedTaskEvents = Array.from(yield* Fiber.join(stoppedTaskEventFiber));
      assert.equal(stoppedTaskEvents.length, 1);
      const stoppedTaskEvent = stoppedTaskEvents[0];
      assert.equal(stoppedTaskEvent?.type, "task.completed");
      if (stoppedTaskEvent?.type === "task.completed") {
        assert.equal(String(stoppedTaskEvent.payload.taskId), "task-live");
        assert.equal(stoppedTaskEvent.payload.status, "stopped");
        assert.equal(stoppedTaskEvent.payload.taskType, "local_agent");
        assert.equal(stoppedTaskEvent.payload.title, "Agent A");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
  it.effect("workflow member coalescing: identical snapshots suppress, changes emit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Collect task.progress until member-0's tick-3 emission lands, then
      // evaluate member emissions.
      const progressFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.progress"),
        Stream.takeUntil(
          // Sentinel: member-0's tick-3 emission (tokens 20) — members are
          // emitted after the coordinator row within a tick.
          (event) =>
            (event.payload as { taskId?: string }).taskId === "wf-coalesce:wf:0" &&
            (event.payload as { typedUsage?: { totalTokens?: number } }).typedUsage?.totalTokens ===
              20,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run workflow",
        attachments: [],
      });

      const memberSnapshot = (tokens: number) => [
        { type: "workflow_phase", index: 0, title: "Work" },
        {
          type: "workflow_agent",
          index: 0,
          state: "running",
          label: "member-0",
          phaseIndex: 0,
          tokens,
        },
        {
          type: "system",
          subtype: "vcs_state_changed",
          kind: "push",
          cwd: "/tmp/worktree",
          session_id: "session",
          uuid: "vcs",
        },
        {
          type: "system",
          subtype: "code_change_published",
          provider: "github",
          url: "https://github.com/pingdotgg/t3code/pull/1",
          repo: "pingdotgg/t3code",
          identifier: "1",
          session_id: "session",
          uuid: "ccp",
        },
        {
          type: "workflow_agent",
          index: 1,
          state: "running",
          label: "member-1",
          phaseIndex: 0,
          tokens: 50,
        },
      ];
      const tick = (usageTotal: number, snapshot: ReturnType<typeof memberSnapshot>) =>
        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "wf-coalesce",
          description: "Coalescing workflow",
          usage: { total_tokens: usageTotal, tool_uses: 1, duration_ms: 10 },
          workflow_progress: snapshot,
          uuid: `wf-tick-${usageTotal}`,
          session_id: "sdk-session",
        } as unknown as SDKMessage);

      // Tick 1: both members are new -> 2 member events.
      tick(100, memberSnapshot(10));
      // Tick 2: IDENTICAL member snapshot -> 0 member events (coordinator
      // usage changed, but members did not).
      tick(200, memberSnapshot(10));
      // Tick 3: member-0's tokens advanced -> exactly 1 member event.
      tick(300, memberSnapshot(20));

      const progressEvents = Array.from(yield* Fiber.join(progressFiber));
      const byMember = new Map<string, number>();
      for (const event of progressEvents) {
        const taskId = (event.payload as { taskId: string }).taskId;
        if (!taskId.includes(":wf:")) continue;
        byMember.set(taskId, (byMember.get(taskId) ?? 0) + 1);
      }
      // member-0: tick 1 + tick 3. member-1: tick 1 only (tick 2 identical,
      // tick 3 unchanged).
      assert.equal(byMember.get("wf-coalesce:wf:0"), 2);
      assert.equal(byMember.get("wf-coalesce:wf:1"), 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
  it.effect("task.started carries model/effort; subagent snapshots refine the model", () => {
    const harness = makeHarness({ modelCatalog: Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG) });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type.startsWith("task.")),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "spawn an agent",
        attachments: [],
      });

      // No explicit model/effort on the launch input: the task inherits the
      // session's selection.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-model",
        description: "Agent M",
        task_type: "local_agent",
        tool_use_id: "toolu_agent_m",
        uuid: "task-model-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      // The subagent's assistant snapshot carries the authoritative API
      // model id, which refines the linkage on later rows.
      harness.query.emit({
        type: "assistant",
        parent_tool_use_id: "toolu_agent_m",
        message: {
          model: "claude-sonnet-5[1m]",
          content: [],
        },
        uuid: "subagent-snapshot-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-model",
        description: "Agent M",
        usage: { total_tokens: 100, tool_uses: 1, duration_ms: 10 },
        uuid: "task-model-progress-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      const taskEvents = Array.from(yield* Fiber.join(taskEventsFiber));
      const started = taskEvents[0];
      assert.equal(started?.type, "task.started");
      if (started?.type === "task.started") {
        assert.equal(started.payload.model, "claude-opus-4-6");
        assert.equal(started.payload.effort, "max");
      }
      const progress = taskEvents[1];
      assert.equal(progress?.type, "task.progress");
      if (progress?.type === "task.progress") {
        assert.equal(progress.payload.model, "claude-sonnet-5[1m]");
        assert.equal(progress.payload.effort, "max");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
