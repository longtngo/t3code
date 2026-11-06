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
  resolveClaudeAutoCompactWindow,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  resolveClaudeCatalogContextWindow,
  resolveClaudeCatalogContextWindowTokens,
} from "../../provider/ClaudeModelCatalog.ts";

// Result classification (invariant 35)

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

// Context windows and auto-compaction (invariants 12, 22)

/**
 * The window Claude Code ACTUALLY runs a model at: several models are `native_1m` whatever the
 * catalog toggle says (measured on CLI 2.1.247 via `getContextUsage`; re-verify on upgrade).
 * Pass the adapter's live catalog, which can carry a newer Context Window default.
 */
export function claudeCliContextWindow(
  modelSelection: ModelSelection | undefined,
  catalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
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
      return resolveClaudeCatalogContextWindow(catalog, modelSelection) === "1m"
        ? 1_000_000
        : 200_000;
  }
  return undefined;
}

/** The meter's denominator: the CLI's window, then the catalog's, then 200k. */
export function claudeModelContextWindow(
  modelSelection: ModelSelection,
  catalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): number {
  return (
    claudeCliContextWindow(modelSelection, catalog) ??
    resolveClaudeCatalogContextWindowTokens(catalog, modelSelection) ??
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
 * The `autoCompactWindow` for Claude Code, or undefined. The user's setting resolves against
 * the CLI's real window; when unset, any >= 1M window gets 1M, because an older CLI refuses to
 * compact a >= 1M window it has no default for (and the CLI on PATH has no minimum version).
 */
export function claudeQueryAutoCompactWindow(
  setting: string | undefined,
  modelSelection: ModelSelection,
  catalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): number | undefined {
  const catalogWindow = resolveClaudeCatalogContextWindowTokens(catalog, modelSelection);
  const cliWindow = claudeCliContextWindow(modelSelection, catalog) ?? catalogWindow;
  const configured = resolveClaudeAutoCompactWindow(setting, cliWindow);
  if (configured !== undefined) return configured;
  if (CLAUDE_UNARMED_COMPACTION_MODELS.has(modelSelection.model)) return cliWindow;
  return cliWindow !== undefined && cliWindow >= 1_000_000 ? 1_000_000 : undefined;
}

function finitePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

/**
 * A `getContextUsage` answer as the context snapshot, the only source of compaction facts
 * (invariant 12). `autocompactSource` is untyped in the SDK and says whether compaction is
 * armed. `maxTokens` is the model's window, not the response's compaction budget.
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
