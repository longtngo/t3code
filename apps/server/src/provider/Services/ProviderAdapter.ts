/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  MessageId,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

/**
 * How ProviderService runs manual context compaction for an adapter.
 * Native adapters expose a start call and must emit a compacted thread state
 * when they finish. Slash-command adapters get the command sent as a turn.
 */
export type ProviderCompaction<TError> =
  | {
      readonly type: "native";
      readonly start: (
        threadId: ThreadId,
        modelSelection?: ProviderSendTurnInput["modelSelection"],
      ) => Effect.Effect<void, TError>;
    }
  | { readonly type: "slash-command"; readonly command: `/${string}` };

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /** Starts a resumed turn with no synthetic user prompt. Omitted means the
      adapter needs an explicit continuation instruction. */
  readonly promptlessTurnContinuation?: boolean;
  /** False when native conversation history cannot be rewound. */
  readonly supportsConversationRollback?: boolean;
  /**
   * True when the adapter actually grants `ProviderSessionStartInput.workspaceMemberPaths`
   * to the agent, and echoes the granted set back on its `ProviderSession`.
   *
   * Omitted means it does not. That matters in both directions: an adapter that
   * ignores the field also never echoes it, so its sessions always report an
   * empty grant — comparing those against a non-empty desired set would read as
   * "members changed" on every turn and restart the session each time.
   *
   * Declared per adapter rather than centrally because only the adapter knows
   * whether its transport carries the field, and the answer differs by adapter
   * rather than by "is it Claude":
   *
   * - Claude passes the paths straight to the SDK's `query`, so it declares this.
   * - Cursor, Grok and Antigravity share the ACP runtime, and ACP has no
   *   session-setup field for extra roots at all: `NewSessionRequest` is exactly
   *   `{_meta?, cwd, mcpServers}` and `ResumeSessionRequest` adds only `sessionId`.
   *   Both are encoded through those schemas, which drop anything else, so no ACP
   *   adapter can grant a path by asking the agent for it. Antigravity does grant
   *   its attachments directory, but through the client-filesystem roots it serves
   *   reads and writes from, which is a different mechanism and not a member grant.
   * - Codex is NOT ACP and COULD carry a grant: it has
   *   `workspaceWrite.writableRoots`, which `CodexSessionRuntime` already builds with
   *   no roots. It omits this flag by decision rather than by limitation. Granting a
   *   member repository makes it writable without a per-tool approval, and that is a
   *   wider default than Codex has today; the narrower behaviour was kept, and a Codex
   *   agent goes on asking before it writes outside the thread's own workspace. Revisit
   *   this only with a reason to widen it, not because the field exists.
   * - OpenCode is not ACP either, and has no grant path wired.
   */
  readonly grantsWorkspaceMemberPaths?: boolean;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /** Omitted when this adapter does not support manual context compaction. */
  readonly compaction?: ProviderCompaction<TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Upload a thread to the provider when the adapter supports feedback.
   */
  readonly uploadFeedback?: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Force an immediate account-usage poll and broadcast.
   *
   * Account usage (OAuth 5h/7d limits + extra credit spend) is otherwise
   * emitted only by a per-adapter background poller. This lets callers trigger
   * an on-demand poll; the fresh snapshot is fanned out via the adapter's
   * `account.usage.updated` runtime event.
   *
   * `threadId` is the thread whose UI asked, and it is emitted for whether or
   * not this adapter holds a live session for it. Without it the fan-out
   * reaches active sessions only, and a press on an idle thread updates
   * nothing while still answering `ok` — every Cursor session measured
   * `stopped`, and 451 of 458 Claude ones, so "idle" is the common case rather
   * than the edge.
   *
   * Resolves with the number of events emitted, which is what makes a
   * reached-nobody refresh visible in a log. Adapters whose provider has no
   * account-usage concept resolve 0.
   */
  readonly refreshAccountUsage: (threadId?: ThreadId) => Effect.Effect<number, TError>;

  /**
   * Take a queued turn back out of this adapter's queue before it is sent.
   *
   * Resolves `true` when the turn was still queued and has been removed, and
   * `false` when it was not — already sent, never queued, or this provider does
   * not queue at all. Deliberately not an error: "you were too late" is a
   * normal outcome of a race the user cannot see, and the caller reports it the
   * same way whichever reason applies.
   *
   * Adapters that hand every turn straight to the provider implement this as a
   * constant `false`.
   */
  readonly withdrawQueuedTurn: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<boolean, TError>;

  /**
   * Put a line into the session's transcript WITHOUT starting a turn.
   *
   * The agent reads it on its next real turn and never spends one answering
   * it. That is the whole point: a background task launched by one of the
   * thread's own subagents used to start a turn on the main thread, and over
   * six days those turns re-sent 370.7M tokens of conversation to earn a reply
   * whose median length was 49 characters.
   *
   * Resolves `true` when the note was accepted, `false` when this adapter
   * cannot take one - no live session, a queue already shutting down, or a
   * provider with no such channel. Deliberately not an error: the caller's
   * answer to "no" is to start a turn the old way, which is a fallback rather
   * than a failure.
   */
  readonly appendSessionNote: (input: {
    readonly threadId: ThreadId;
    readonly text: string;
  }) => Effect.Effect<boolean, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
