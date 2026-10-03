/**
 * FORK: Claude adapter behaviour this fork keeps on top of upstream's
 * `ClaudeAdapterV2.ts`. Pure helpers only, so the upstream file carries small
 * call-site edits and its own edits keep merging. Registry invariants 12, 22,
 * 32 and 35 (docs/fork/README.md) explain why each piece exists.
 */
import type {
  SDKControlGetContextUsageResponse,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ModelSelection,
  type OrchestrationV2PlanStep,
  resolveClaudeAutoCompactWindow,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogContextWindow,
  resolveClaudeCatalogContextWindowTokens,
} from "../../provider/ClaudeModelCatalog.ts";

// ---------------------------------------------------------------------------
// Result classification (invariant 35)
// ---------------------------------------------------------------------------

// The CLI tags internal telemetry with this prefix (e.g. "[ede_diagnostic]
// result_type=user stop_reason=tool_use") and hides it from its own UI. It can
// sit on any line of `result` and in any `errors[]` entry, so it is filtered
// per line, trimmed and case-insensitively, and never becomes a banner.
const CLAUDE_DIAGNOSTIC_ERROR_PREFIX = "[ede_diagnostic]";

function isClaudeDiagnosticError(error: string): boolean {
  return error.trimStart().toLowerCase().startsWith(CLAUDE_DIAGNOSTIC_ERROR_PREFIX);
}

/** `errors[]` without diagnostics. Never reads `result`, which carries assistant prose. */
export function claudeUserFacingResultErrors(result: SDKResultMessage): ReadonlyArray<string> {
  const errors: unknown = Reflect.get(result, "errors");
  return Array.isArray(errors)
    ? errors.filter(
        (error): error is string => typeof error === "string" && !isClaudeDiagnosticError(error),
      )
    : [];
}

/**
 * The CLI's own prose on a result, diagnostics removed line by line. `result`
 * is typed `string`, but the CLI runs ahead of the typed SDK; a non-string
 * value must not reach a string API, where it would throw and take the
 * session down with the message it was trying to report.
 */
export function claudeResultProse(result: SDKResultMessage): string | undefined {
  const raw: unknown = Reflect.get(result, "result");
  if (typeof raw !== "string") return undefined;
  const text = raw
    .split("\n")
    .filter((line) => !isClaudeDiagnosticError(line))
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

/** `aborted_streaming` / `aborted_tools`: the user stopped the turn. */
export function isClaudeAbortedResult(result: SDKResultMessage): boolean {
  return (
    result.terminal_reason === "aborted_streaming" || result.terminal_reason === "aborted_tools"
  );
}

/**
 * `terminal_reason` values that mean the turn died rather than finished, even
 * on a `success` subtype with an empty error list. Kept in step with
 * `terminalResultError` in ClaudeAdapterV2.ts, which names each of them.
 */
export const CLAUDE_FAILED_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  "api_error",
  "malformed_tool_use_exhausted",
  "budget_exhausted",
  "structured_output_retry_exhausted",
  "tool_deferred_unavailable",
  "turn_setup_failed",
  "blocking_limit",
  "rapid_refill_breaker",
  "prompt_too_long",
  "image_error",
  "model_error",
]);

function isClaudeInterruptedErrorResult(result: SDKResultMessage, errorText: string): boolean {
  if (errorText.includes("interrupt")) return true;
  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errorText.includes("request was aborted") ||
      errorText.includes("interrupted by user") ||
      errorText.includes("aborted"))
  );
}

/**
 * How a Claude result ends its turn.
 *
 * `subtype` is a payload-shape discriminator, not an outcome: the CLI reports
 * a provider HTTP failure as `success` + `is_error: true`. Reading that as a
 * completion recorded a failed turn as done, with its error thrown away.
 */
export function claudeResultTerminalStatus(
  result: SDKResultMessage,
): "completed" | "interrupted" | "failed" | "cancelled" {
  if (isClaudeAbortedResult(result)) return "interrupted";
  if (
    (result.subtype === "success" &&
      (result.api_error_status === 529 || result.api_error_status === 429)) ||
    (result.terminal_reason !== undefined &&
      CLAUDE_FAILED_TERMINAL_REASONS.has(result.terminal_reason))
  ) {
    return "failed";
  }
  if (result.subtype === "success") {
    return result.is_error ? "failed" : "completed";
  }
  // The substring heuristics read diagnostics-free `errors[]` only.
  const errorText = claudeUserFacingResultErrors(result).join(" ").toLowerCase();
  if (isClaudeInterruptedErrorResult(result, errorText)) return "interrupted";
  if (errorText.includes("cancel")) return "cancelled";
  return "failed";
}

// ---------------------------------------------------------------------------
// Context windows and auto-compaction (invariants 12, 22)
// ---------------------------------------------------------------------------

/**
 * The context window Claude Code ACTUALLY runs a model at. Several models are
 * `native_1m` in the CLI's registry and run at 1M whatever the catalog's
 * Context Window toggle says. Measured against Claude Code 2.1.247 by calling
 * `getContextUsage` per model; re-verify on a CLI upgrade.
 */
export function claudeCliContextWindow(
  modelSelection: ModelSelection | undefined,
): number | undefined {
  switch (modelSelection?.model) {
    case "claude-opus-5":
    case "claude-opus-4-8":
    case "claude-opus-4-7":
    case "claude-sonnet-5":
    case "claude-fable-5":
      return 1_000_000;
    case "claude-sonnet-4-6":
    case "claude-haiku-4-5":
    case "claude-opus-4-5":
      return 200_000;
    case "claude-opus-4-6":
      return resolveClaudeCatalogContextWindow(BUNDLED_CLAUDE_MODEL_CATALOG, modelSelection) ===
        "1m"
        ? 1_000_000
        : 200_000;
  }
  return undefined;
}

/** The meter's denominator: the CLI's window, then the catalog's, then 200k. */
export function claudeModelContextWindow(modelSelection: ModelSelection): number {
  return (
    claudeCliContextWindow(modelSelection) ??
    resolveClaudeCatalogContextWindowTokens(BUNDLED_CLAUDE_MODEL_CATALOG, modelSelection) ??
    200_000
  );
}

/**
 * Models Claude Code leaves UNARMED: it classifies their window as `"auto"`
 * and then never auto-compacts. Handing the CLI the model's own window flips
 * that to `"settings"` without narrowing anything. Measured on 2.1.288.
 */
const CLAUDE_UNARMED_COMPACTION_MODELS: ReadonlySet<string> = new Set([
  "claude-haiku-4-5",
  "claude-opus-4-5",
]);

/**
 * Models Claude Code compacts on its own (`autocompactSource:
 * "model-default"`, threshold 967,000, measured on 2.1.288). A blank setting
 * sends them nothing, because a supplied window outranks the CLI's remotely
 * tuned default.
 */
const CLAUDE_CLI_ARMED_COMPACTION_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
]);

/**
 * The `autoCompactWindow` handed to Claude Code, or undefined to send none.
 *
 * The user's setting (tokens or a percentage) resolves against the window the
 * CLI will actually use. When it resolves to nothing, models the CLI arms
 * itself get nothing, unarmed models get their own window, and any other
 * >= 1M catalog window gets 1M: the CLI refuses to compact a >= 1M window it
 * holds no default for (`claude-opus-4-6` at 1M still reports `"auto"`).
 */
export function claudeQueryAutoCompactWindow(
  setting: string | undefined,
  modelSelection: ModelSelection,
): number | undefined {
  const catalogWindow = resolveClaudeCatalogContextWindowTokens(
    BUNDLED_CLAUDE_MODEL_CATALOG,
    modelSelection,
  );
  const cliWindow = claudeCliContextWindow(modelSelection) ?? catalogWindow;
  const configured = resolveClaudeAutoCompactWindow(setting, cliWindow);
  if (configured !== undefined) return configured;
  if (CLAUDE_CLI_ARMED_COMPACTION_MODELS.has(modelSelection.model)) return undefined;
  if (CLAUDE_UNARMED_COMPACTION_MODELS.has(modelSelection.model)) return cliWindow;
  return catalogWindow !== undefined && catalogWindow >= 1_000_000
    ? Math.min(catalogWindow, 1_000_000)
    : undefined;
}

function finitePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

/**
 * A `getContextUsage` answer as the thread's context snapshot. It is the only
 * source of the compaction facts the Vitals gauge's note and marker render
 * from (invariant 12). `autocompactSource` (lower-case `c`) is absent from the
 * SDK's declared type and read off the raw object; it, not
 * `isAutoCompactEnabled`, says whether compaction is armed.
 *
 * `maxTokens` is the model's window: the response's own `maxTokens` is the
 * window the CLI compacts against, which made a configured budget the meter's
 * denominator ("541k / 600k, 90%" on a 1M thread).
 */
export function claudeContextUsageSnapshot(
  response: SDKControlGetContextUsageResponse,
  modelContextWindow: number,
): ThreadTokenUsageSnapshot | undefined {
  const usedTokens =
    typeof response.totalTokens === "number" && Number.isFinite(response.totalTokens)
      ? Math.max(0, Math.round(response.totalTokens))
      : undefined;
  if (usedTokens === undefined || usedTokens <= 0) return undefined;
  const autoCompactThreshold = finitePositiveInteger(response.autoCompactThreshold);
  const rawSource: unknown = Reflect.get(response, "autocompactSource");
  const autoCompactSource =
    typeof rawSource === "string" && rawSource.length > 0 ? rawSource : undefined;
  const maxTokens = finitePositiveInteger(modelContextWindow);
  return {
    usedTokens: maxTokens === undefined ? usedTokens : Math.min(usedTokens, maxTokens),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(typeof response.isAutoCompactEnabled === "boolean"
      ? { compactsAutomatically: response.isAutoCompactEnabled }
      : {}),
    ...(autoCompactThreshold === undefined ? {} : { autoCompactThreshold }),
    ...(autoCompactSource === undefined ? {} : { autoCompactSource }),
  };
}

// ---------------------------------------------------------------------------
// Task tools (TaskCreate / TaskUpdate / TaskList) as a to-do list
// ---------------------------------------------------------------------------

export interface ClaudeTaskState {
  readonly id: string;
  subject: string;
  status: OrchestrationV2PlanStep["status"];
  readonly blockedBy: Set<string>;
}

export function isClaudeTaskTool(toolName: string): boolean {
  return toolName === "TaskCreate" || toolName === "TaskUpdate" || toolName === "TaskList";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function claudeTaskStatus(value: unknown): OrchestrationV2PlanStep["status"] {
  return value === "completed" ? "completed" : value === "in_progress" ? "running" : "pending";
}

/**
 * Apply one SUCCESSFUL Task tool call to the session's task list. The ids live
 * only in the structured `tool_use_result` (TaskCreate's input has none), so
 * a call whose result is missing or an error changes nothing. Returns whether
 * the visible list changed.
 */
export function applyClaudeTaskToolResult(
  tasks: Map<string, ClaudeTaskState>,
  tool: { readonly toolName: string; readonly input: unknown },
  structuredResult: unknown,
): boolean {
  if (!isClaudeTaskTool(tool.toolName)) return false;
  const input = readRecord(tool.input) ?? {};
  const result = readRecord(structuredResult);

  if (tool.toolName === "TaskList") {
    const listed = result?.tasks;
    if (!Array.isArray(listed)) return false;
    tasks.clear();
    for (const entry of listed) {
      const task = readRecord(entry);
      const id = readString(task?.id);
      const subject = readString(task?.subject);
      if (id === undefined || subject === undefined) continue;
      tasks.set(id, {
        id,
        subject,
        status: claudeTaskStatus(task?.status),
        blockedBy: new Set(readStringArray(task?.blockedBy)),
      });
    }
    return tasks.size > 0;
  }

  if (tool.toolName === "TaskCreate") {
    const created = readRecord(result?.task);
    const id = readString(created?.id);
    const subject = readString(created?.subject) ?? readString(input.subject);
    if (id === undefined || subject === undefined) return false;
    tasks.set(id, {
      id,
      subject,
      status: claudeTaskStatus(input.status),
      blockedBy: new Set(readStringArray(input.blockedBy)),
    });
    return true;
  }

  const taskId = readString(input.taskId) ?? readString(result?.taskId);
  const task = taskId === undefined ? undefined : tasks.get(taskId);
  if (task === undefined) return false;
  let changed = false;
  const subject = readString(input.subject);
  if (subject !== undefined && task.subject !== subject) {
    task.subject = subject;
    changed = true;
  }
  if (typeof input.status === "string") {
    const status = claudeTaskStatus(input.status);
    if (task.status !== status) {
      task.status = status;
      changed = true;
    }
  }
  for (const dependency of readStringArray(input.addBlockedBy)) {
    if (!task.blockedBy.has(dependency)) {
      task.blockedBy.add(dependency);
      changed = true;
    }
  }
  for (const dependency of readStringArray(input.removeBlockedBy)) {
    if (task.blockedBy.delete(dependency)) changed = true;
  }
  return changed;
}

export function claudeTaskPlanSteps(
  tasks: ReadonlyMap<string, ClaudeTaskState>,
): ReadonlyArray<OrchestrationV2PlanStep> {
  return Array.from(tasks.values(), (task) => {
    const blockedBy = Array.from(task.blockedBy);
    return {
      id: `task-${task.id}`,
      text:
        blockedBy.length > 0
          ? `${task.subject} (blocked by #${blockedBy.join(", #")})`
          : task.subject,
      status: task.status,
    };
  });
}
