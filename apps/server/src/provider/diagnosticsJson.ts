import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

/**
 * JSON for a log line or a span attribute, or nothing.
 *
 * Diagnostics must never be the reason a turn fails, so an input that cannot be
 * encoded (a cycle, a BigInt, a value holding a function) yields `undefined` and
 * the caller substitutes its own placeholder rather than propagating an error.
 */
export function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}
